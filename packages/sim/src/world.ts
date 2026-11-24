import { ATTR_POPULATION, build, cancelBuild, checkDestructables, checkPlacement, connectWall, giveBuiltStorages, isBuilding, addToQueue, payObjCost, removeFromQueue, setupBuilding } from './buildings';
import { attackGround } from './combat';
import {
  CommandQueue,
  type AttackCommand,
  type AttackGroundCommand,
  type BuildCommand,
  type BuildWallCommand,
  type CancelCommand,
  type Command,
  type FormationCommand,
  type MoveCommand,
  type QueueCommand,
  type QueuedCommand,
  type RepairCommand,
  type ResearchCommand,
  type StandGroundCommand,
  type UnloadCommand,
  type TradeAttributeCommand,
  type RelationCommand,
  type AlliedVictoryCommand,
  type TributeCommand,
  type StopCommand,
  type WorkCommand,
} from './commands';
import type { GameContext } from './context';
import {
  copyDiplomacy,
  giveAttribute,
  isAlly,
  isEnemy,
  newDiplomacy,
  relation,
  updateMutualAllies,
  type DiplomacyState,
} from './diplomacy';
import { EntityStore, ObjectState, type Entity } from './entities';
import { deleteActions, orderWork, workMoveTo } from './gather';
import { cheat, newCheatState, type CheatState } from './cheats';
import { addPopulationEntry, copyGameLog, historySecond, historyTech, newGameLog, notify, NOTIFY_DIPLOMACY_CHANGED, NOTIFY_PLAYER_DEFEATED, NOTIFY_PLAYER_RESIGNED, NOTIFY_TRIBUTE_PAID, type GameLog } from './game-log';
import { Hasher } from './hash';
import { defaultWonderTask, startWonder, WONDER } from './wonder';
import { add32, div32, f32, MS_TO_SECONDS, mul32, sqrt32, sub32, toInt, toUint, u32 } from './num';
import { createTestMap, TileMap, type MapSnapshot } from './map';
import { copyMasters, hasMaster, master, newMasters, typeOf } from './masters';
import { initialFacing, newMover, orderMove, teleport } from './movement';
import { giveStorages, isAnimated, isMoving, updateObject } from './objects';
import { DEFAULT_PATHING_ITERATIONS, PathingSystem } from './pathing';
import { doRepair, REPAIR_MAN } from './repair';
import { exitAll, exitObj, isTransport } from './transport';
import { regrowTradeGoods, setTradeAttribute, UNIT_LEVEL_TRADE } from './trade';
import { orderResearch, stopBuilding } from './research';
import { MapStack } from './rmm-base';
import { MAP_LARGE, MAP_MOSTLY_LAND, mapGenerate2 } from './rmm-controller';
import { RmmMap, type RmmWorld } from './rmm-map';
import { placeRelicsAndRuins } from './rmm-objects';
import { CrtRand } from './rng';
import { newSprite } from './sprites';
import { checkForNewTech, doEffect, doTech, newResearchDone, newTechStates, startInAge } from './techs';
import {
  checkGameState,
  copyVictory,
  countPopulation,
  newVictory,
  perSecond,
  resign,
  scoreOf,
  STATUS_LOST,
  STATUS_WON,
  updateConditions,
  type Score,
  type VictorySettings,
  type VictoryState,
} from './victory';
import { AI_ACTION_MOVE, AI_ORDER_MOVE, AiClass, createUnitAI, NOTIFY_OWNER_CHANGED, NOTIFY_TARGET_MOVED, notifyObject, orderUnload, purgeNotes, setAiState, standGround } from './unit-ai';
import { FAITH_MAX, GROUP_PRIEST, martyrdom, RESOURCE_FAITH } from './priest';
import { exploreObject, forgetSighting, stateChanged, unexploreObject, Visibility, type VisibilitySnapshot } from './visibility';
import { CIV_EGYPTIAN, CIV_GAIA, CIVS, copyUnitType, ELEPHANT, FORAGE, GAZELLE, MINE_GOLD, MINE_STONE, TECHS, TOWN_CENTER, TREES, VILLAGER, type UnitType } from './units';

/** Default base time per step: the network frame granularity `G` (src/com_spd.cpp:11-25). Never wall time. */
export const STEP_MS = 90;
/** Default buffer frames `F` after each turn's boundary step (src/com_spd.cpp:11-25). */
export const BUFFER_FRAMES = 10;
/** Turns up to this one are a single step: the buffer path needs `current_turn > 6` (src/com_hand.cpp:509). */
export const SINGLE_STEP_TURNS = 6;
/** A command issued during turn N runs on turn N + 2 (src/com_hand.cpp:2810, CommandTurnIncrement). */
export const COMMAND_DELAY_TURNS = 2;
/** A move order keeps the group's layout unless it spans more than this many tiles on an axis (movement.md §5.1). */
const GROUP_EXTENT_LIMIT = 8.0;
/** `OBJECT_GROUP_ARTIFACT`: relics and ruins change hands by the static path. */
const GROUP_ARTIFACT = 1;
/** `random_seed` set by the world constructor (src/world.cpp:95). */
export const DEFAULT_RANDOM_SEED = 14;

/** Steps in a turn: the boundary step plus `frames` buffer frames (docs/spec/turn-timing.md §2). */
export function stepsInTurn(turn: number, frames = BUFFER_FRAMES): number {
  return turn <= SINGLE_STEP_TURNS ? 1 : 1 + frames;
}

/** Step size `G` (ms) and buffer frames `F` agreed for turn `turn` (`E`); turn `E + 1` is the first to run at them. */
export interface SpeedChange {
  turn: number;
  granularity: number;
  frames: number;
}

export interface WorldOptions {
  /** Player slots including Gaia (index 0). */
  players: number;
  /** Stored seed the first step reseeds from. */
  randomSeed?: number;
  /** The tile map; defaults to the fixed test map. */
  map?: TileMap;
  /** Objects placed before the first step, in this order (see `startingObjects`). */
  units?: readonly StartUnit[];
  /** "Path Finding" budget per search: 2500 low, 5000 medium, 7500 high (docs/spec/movement.md §3). */
  pathingIterations?: number;
  /** The game's population limit (`pop_limit`, default 50), each player's attribute 32. */
  populationLimit?: number;
  /** Each player's civ (empires.dat civ index), Gaia's included; a missing entry is Egyptian (Gaia: civ 0). */
  civs?: readonly number[];
  /** The lobby's victory setting (victory.md §2); default Standard. */
  victory?: VictorySettings;
  /** Starting Age (`AGE_*`, `TRIBE_Game::Age`); default `AGE_DEFAULT`. Nomad only changes a random map's start objects. */
  startingAge?: number;
  /** Resources (`RESOURCES_*`, `TRIBE_Game::ResourceLevel`); default `RESOURCES_DEFAULT`, the civ's own stockpile. */
  resourceLevel?: number;
  /** Death Match: every player starts with 20000 food and wood, 10000 gold, 5000 stone. */
  deathMatch?: boolean;
  /** Full Tech Tree: effect 210 instead of each civ's tech tree effect. */
  fullTechTree?: boolean;
  /** Reveal Map (`fullVisibility`): every player starts with the whole map explored. */
  revealMap?: boolean;
  /** Fixed Positions (`!randomizePositions`, default on): the generator's `fixed_position` (random-maps.md §4 step 5). */
  fixedPositions?: boolean;
  /** Enable Cheating (`allowCheatCodes`, default off): the cheat codes typed in chat take effect (chat.md §7). */
  cheating?: boolean;
  /**
   * A random map game (docs/spec/random-maps.md): the map and every start object come from `randomSeed` through the
   * original's `new_game` chain; `map` and `units` are not used.
   */
  randomMap?: RandomMapOptions;
}

/** `TRIBE_Game::Age` (include/tribegam.h:123): the Starting Age drop-down's ids. */
export const AGE_DEFAULT = 0;
export const AGE_NOMAD = 1;
export const AGE_STONE = 2;
export const AGE_TOOL = 3;
export const AGE_BRONZE = 4;
export const AGE_IRON = 5;
/** `TRIBE_Game::ResourceLevel` (include/tribegam.h:122); Low (1) is not on the dialog. */
export const RESOURCES_DEFAULT = 0;
export const RESOURCES_LOW = 1;
export const RESOURCES_MEDIUM = 2;
export const RESOURCES_HIGH = 3;

/**
 * Food, wood, gold, stone each player is given at game start by resource level and for Death Match
 * (src/tworld.cpp:806-840); Default keeps the civ's own (200, 200, 0, 150).
 */
const START_STOCKPILES: Readonly<Record<number, readonly [number, number, number, number]>> = {
  [RESOURCES_LOW]: [200, 200, 0, 100],
  [RESOURCES_MEDIUM]: [500, 500, 0, 250],
  [RESOURCES_HIGH]: [1000, 1000, 0, 750],
};
const DEATH_MATCH_STOCKPILE = [20000, 20000, 10000, 5000] as const;
/** Effect 210, "A01": the Full Tech Tree's in place of a civ's tech tree (disables only tech 118). */
const FULL_TECH_TREE_EFFECT = 210;

/** The lobby's random map settings. */
export interface RandomMapOptions {
  /** Map type (`MAP_*` in rmm-controller.ts), the dat's random map index; default Mostly Land. */
  type?: number;
  /** Map side in tiles (`MAP_TINY` .. `MAP_HUMONGOUS`); default Large (144). */
  size?: number;
}

/** The original's multiplayer game defaults (src/scr_mps.cpp:436-450): Large, Mostly Land, fixed positions. */
export const DEFAULT_RANDOM_MAP: Required<RandomMapOptions> = { type: MAP_MOSTLY_LAND, size: MAP_LARGE };

/** How the game ended (`game_end_condition`) and who won, once it is over. */
export interface GameResult {
  endCondition: number;
  /** Players with status won; empty when everyone lost. */
  winners: number[];
  /** `game_status` per player, Gaia's included: 0 playing, 1 won, 2 lost. */
  status: number[];
}

export interface StartUnit {
  owner: number;
  /** Master object id; must be in the sim's unit table. */
  type: number;
  x: number;
  y: number;
}

/**
 * `RGE_Player` attributes at game start: the civilization's resource table (empires.dat civ 1, Egyptians; every
 * playable civ but Palmyra has this table). Food 200, wood 200, stone 150, gold 0; attribute 47 (gold mining
 * multiplier) 1. Gaia's table (civ 0) is all zeros.
 */
export const START_ATTRIBUTES: readonly number[] = CIVS[CIV_EGYPTIAN]!.resources;
export const ATTRIBUTE_COUNT = START_ATTRIBUTES.length;
/** Player attribute indices the client shows (`PLAYER_ATTRIBUTE_*`). */
export const ATTR_FOOD = 0;
export const ATTR_WOOD = 1;
export const ATTR_STONE = 2;
export const ATTR_GOLD = 3;

/** `RGE_Game_Info` default population limit. */
export const DEFAULT_POPULATION_LIMIT = 50;
/**
 * Attributes `new_game` sets for every player but Gaia after the objects are placed (`src/tworld.cpp`, economy.md
 * §6.4): 32 population limit (filled in from the options), 33 0, 30 building allowance 500, 45 1. They overwrite what
 * the start techs gave (Stone Age adds 8 to attribute 30).
 */
const NEW_GAME_ATTRIBUTES: readonly (readonly [number, number])[] = [
  [32, DEFAULT_POPULATION_LIMIT],
  [33, 0],
  [30, 500],
  [45, 1],
];

/** Villagers each player starts with (the original's default start: 3 per player). */
export const STARTING_VILLAGERS = 3;

/**
 * Starting units on the fixed test map until the random map generator places them: three Villagers per player
 * on adjacent tile centres. Player 1 starts north-west of the lake, player 2 south-east of it.
 */
export function startingUnits(players: number): StartUnit[] {
  const units: StartUnit[] = [];
  for (let owner = 1; owner < players; owner++) {
    const [bx, by] = BASES[(owner - 1) % BASES.length]!;
    for (let i = 0; i < STARTING_VILLAGERS; i++) units.push({ owner, type: VILLAGER, x: bx! + i + 0.5, y: by! + 0.5 });
  }
  return units;
}

/**
 * The fixed test map's start until the random map generator places objects: per player three Villagers, a Town
 * Center below them, and (owned by Gaia) eight trees, three forage bushes, two gold mines, a stone mine, a gazelle
 * and an elephant around the base. All on land; ids follow this order (players first, then Gaia's objects).
 */
export function startingObjects(players: number): StartUnit[] {
  const out = startingUnits(players);
  const gaia: StartUnit[] = [];
  for (let owner = 1; owner < players; owner++) {
    const [bx, by] = BASES[(owner - 1) % BASES.length]!;
    out.push({ owner, type: TOWN_CENTER, x: bx! + 1.5, y: by! + 3.5 });
    const at = (type: number, dx: number, dy: number) => gaia.push({ owner: 0, type, x: bx! + dx, y: by! + dy });
    for (let i = 0; i < 8; i++) at(TREES[i % TREES.length]!, -4.5 + (i % 4), 7.5 + (i >> 2));
    for (let i = 0; i < 3; i++) at(FORAGE, 4.5 + i, 7.5);
    at(MINE_GOLD, 6.5, 0.5);
    at(MINE_GOLD, 7.5, 0.5);
    at(MINE_STONE, 6.5, 4.5);
    at(GAZELLE, 9.5, 6.5);
    at(ELEPHANT, 3.5, 11.5);
  }
  return [...out, ...gaia];
}

const BASES = [
  [10, 10],
  [30, 30],
  [8, 36],
  [36, 8],
];

/** Plain JSON-safe copy of the whole simulation state, taken between turns. */
export interface Snapshot {
  version: 14;
  players: number;
  turn: number;
  granularity: number;
  frames: number;
  speedChanges: SpeedChange[];
  worldTime: number;
  randomSeed: number;
  gameSpeed: number;
  playerTurn: number;
  playerTimeDelta: number[];
  playerUpdateTime: number[];
  alertCooldown: number[];
  depleted: number[];
  deltaSeconds: number;
  entities: { nextId: number; entities: Entity[] };
  queue: QueuedCommand[];
  map: MapSnapshot;
  pathingIterations: number;
  /** Obstruction counters, one per cell (`PathingSystem.cells`). */
  obstruction: number[];
  /** Player attributes, `[player][attribute]`. */
  attributes: number[][];
  /** Each player's updated object list, by id, in update order. */
  awake: number[][];
  /** Tech states, `[player][tech]`. */
  techs: number[][];
  /** Research progress, `[player][tech]`. */
  researchDone: number[][];
  /** Each player's civ. */
  civs: number[];
  /** Each player's masters by unit id. */
  masters: Record<number, UnitType>[];
  /** Each player's `fog_update`. */
  fogUpdate: number[];
  visibility: VisibilitySnapshot;
  victory: VictoryState;
  diplomacy: DiplomacyState;
  log: GameLog;
  cheats: CheatState;
}

const COMMAND_TYPE_IDS: Record<Command['type'], number> = { noop: 0, test: 1, move: 2, work: 3, build: 4, queue: 5, cancel: 6, attack: 7, research: 8, stop: 9, resign: 10, repair: 11, 'stand-ground': 12, relation: 13, 'allied-victory': 14, tribute: 15, 'build-wall': 16, 'attack-ground': 17, unload: 18, 'trade-attribute': 19, formation: 20, cheat: 21, 'quick-build': 22, 'game-speed': 23 };

/** `command_flag += 1` (src/act_obj.cpp:107, :135, :143): a player's command reached the unit; a byte. */
function countCommand(e: Entity): void {
  e.commandFlag = ((e.commandFlag ?? 0) + 1) & 0xff;
}

/**
 * The simulation: `RGE_Game_World` in the original. Advances in turns of `granularity`-ms steps (`runTurn`, or one
 * `runStep` at a time), each step following `RGE_Game_World::update` (src/world.cpp:1206) on its multiplayer path.
 */
export class World {
  readonly players: number;
  /** Turn the next `runTurn` call executes. */
  turn = 0;
  /** Steps of `turn` already run; 0 between turns. */
  turnStep = 0;
  /** `CurrentBufferGranularity` `G`: base ms per step of the current turn (docs/spec/turn-timing.md §1). */
  granularity = STEP_MS;
  /** `CurrentBufferFrames` `F`: buffer steps after the current turn's boundary step. */
  frames = BUFFER_FRAMES;
  /** Agreed changes not yet applied, by turn. Not hashed: peers may learn of a change at different turns before it applies. */
  speedChanges: SpeedChange[] = [];
  /** Game clock, unsigned 32-bit ms (include/world.h:134). */
  worldTime = 0;
  /** The only RNG state carried between steps: a 15-bit value (docs/spec/core.md §4.2). */
  randomSeed: number;
  gameSpeed = f32(1);
  playerTurn = 0;
  playerTimeDelta: number[];
  /** `TRIBE_Player::update_time`: seconds (float32) towards the player's next once-a-second bookkeeping. */
  playerUpdateTime: number[];
  /** `TRIBE_Player::update_count`: seconds before the player hears another under-attack alert. */
  alertCooldown: number[];
  /** Per player, the `GAME_NOTIFY_OBJECT_DEPLETED` notifications so far (farms used up, economy.md §4.7). */
  depleted: number[];
  /**
   * `world_time_delta_seconds`. Commands run before a step recomputes it (src/world.cpp:1270-1272), so they
   * see the previous step's value: it is state, snapshotted and hashed.
   */
  deltaSeconds = 0;
  entities = new EntityStore();
  map: TileMap;
  /** Obstruction map and path search; its cells are state. */
  readonly pathing: PathingSystem;
  /** Player attributes (`RGE_Player::attributes`): resources and counters, float32. */
  attributes: number[][];
  /**
   * Each player's object list as the update walks it: head first, which is the newest object or the latest woken one
   * (src/obj_list.cpp:57). Sleeping objects (living trees) are not in it until damage wakes them.
   */
  awake: number[][];
  /** Tech states per player (`Tech_Player_Tree`), `[player][tech]`. */
  techs: number[][];
  /** Research progress per player (`Tech_Player_Tree.research_done`), `[player][tech]`, float32. */
  researchDone: number[][];
  /** Each player's civ (empires.dat civ index). */
  readonly civs: readonly number[];
  /** Each player's master objects (`RGE_Player::master_objects`): copies of its civ's records the techs change. */
  masters: Record<number, UnitType>[];
  /**
   * Each player's `TRIBE_Player::fog_update` (3 + rand() * 3 / 0x7fff at creation, src/tplayer.cpp:265). Nothing reads
   * it; it is kept for the draw that sets it.
   */
  fogUpdate: number[];
  /** Fog of war: each player's explored and visible tiles and the visible-unit records (docs/spec/visibility.md). */
  visibility: Visibility;
  /** Game statuses, score lists and the time-limit countdown (docs/spec/victory.md). */
  victory: VictoryState;
  /** Stances, allied victory and allied line of sight (docs/spec/diplomacy.md). */
  diplomacy: DiplomacyState;
  /** The notifications raised so far and each player's population history (victory.md §16). The client's read API. */
  log: GameLog;
  /** Enable Cheating and the flags the cheat codes set (chat.md §7); `mapVisible`/`mapFog` are the client's to draw. */
  cheats: CheatState;
  /** `save_random_map_seed`: the map seed a random map game drew, -1 otherwise. Not state: nothing reads it. */
  randomMapSeed = -1;
  /** Per player, the hash of its masters while no effect has changed them since (they are large to hash). */
  private mastersDigest: (number | undefined)[] = [];
  /** `trackedOnTile`'s index and the store state it was built for; derived, never hashed or saved. */
  private tracked: { key: string; tiles: Map<number, [number, number][]> } | null = null;
  private queue = new CommandQueue();
  private readonly rng = new CrtRand();

  constructor(options: WorldOptions) {
    this.players = options.players;
    this.randomSeed = options.randomSeed ?? DEFAULT_RANDOM_SEED;
    const randomMap = options.randomMap && { ...DEFAULT_RANDOM_MAP, ...options.randomMap };
    // `new_map` (src/map.cpp:275-280): terrain 0, height 1 until the generator runs.
    this.map = randomMap ? new TileMap(randomMap.size, randomMap.size, null, new Array<number>(randomMap.size * randomMap.size).fill(1)) : (options.map ?? createTestMap());
    this.playerTimeDelta = new Array<number>(this.players).fill(0);
    this.playerUpdateTime = new Array<number>(this.players).fill(0);
    this.alertCooldown = new Array<number>(this.players).fill(0);
    this.depleted = new Array<number>(this.players).fill(0);
    this.civs = Array.from({ length: this.players }, (_, p) => options.civs?.[p] ?? (p === 0 ? CIV_GAIA : CIV_EGYPTIAN));
    this.attributes = this.civs.map((c) => [...CIVS[c]!.resources]);
    this.awake = Array.from({ length: this.players }, () => []);
    this.pathing = new PathingSystem(this.map, { get: (id) => this.entities.get(id) }, (e) => typeOf(this, e));
    this.pathing.iterations = options.pathingIterations ?? DEFAULT_PATHING_ITERATIONS;
    this.visibility = new Visibility(this.map.width, this.map.height, this.players);
    this.diplomacy = newDiplomacy(this.players);
    this.log = newGameLog(this.players);
    this.cheats = newCheatState(options.cheating ?? false);
    // Player creation copies the civ's masters, draws its `fog_update` and runs its tech tree's first
    // `check_for_new_tech` (techs.md §3.7): the zero-time start techs complete, Gaia's too. The draw comes before the
    // setup seed below: `randomSeed` stands for the stream after player creation (visibility.md §6).
    this.masters = this.civs.map((c) => newMasters(c));
    this.fogUpdate = this.civs.map(() => Math.trunc((this.rng.rand() * 3) / 0x7fff) + 3);
    this.techs = Array.from({ length: this.players }, () => newTechStates());
    this.researchDone = Array.from({ length: this.players }, () => newResearchDone());
    for (let p = 0; p < this.players; p++) checkForNewTech(this.gameContext(), p);
    // The victory type and each player's score table (victory.md §2, §11); no RNG. The original's players have their
    // conditions from creation on, and the random game's player updates read them.
    this.victory = newVictory(this.players, options.victory, options.revealMap);
    if (randomMap) {
      this.newRandomGame(randomMap.type, options);
    } else {
      // Game setup draws from the stored seed and stores a fresh one afterwards (docs/spec/core.md §4.2).
      const setup = (options.units?.length ?? 0) > 0;
      if (setup) this.rng.srand(this.randomSeed);
      for (const u of options.units ?? []) this.createUnit(u);
      this.startEffects(options);
      if (setup) this.randomSeed = this.rng.rand();
    }
    for (let p = 1; p < this.players; p++) {
      for (const [attr, value] of NEW_GAME_ATTRIBUTES) this.attributes[p]![attr] = f32(attr === 32 ? (options.populationLimit ?? value) : value);
      // `add_population_entry` (src/tworld.cpp:901): the history's first entry, after the start ages (victory.md §16).
      addPopulationEntry(this.log, p, this.attributes[p]![ATTR_POPULATION]!);
    }
    // Reveal Map: `TRIBE_Game::create_game` explores the whole map for every human player once the world is made
    // (src/tribegam.cpp:3024-3033); the fog stays on.
    if (options.revealMap) for (let p = 1; p < this.players; p++) this.visibility.exploreAll(p);
    // `TRIBE_Game::create_game` computes the mutual-ally masks once the world is made (src/tribegam.cpp:3021).
    updateMutualAllies(this.diplomacy, this.visibility);
  }

  /**
   * `TRIBE_World::new_game` after the objects (src/tworld.cpp:793-855, techs.md §4.6), each player but Gaia: its civ's
   * tech tree effect, or effect 210 with Full Tech Tree; the Medium or High resource level's stockpile, then Death
   * Match's; then the starting age's techs (`startInAge`).
   */
  private startEffects(options: WorldOptions): void {
    const ctx = this.gameContext();
    for (let p = 1; p < this.players; p++) {
      const effect = options.fullTechTree ? FULL_TECH_TREE_EFFECT : CIVS[this.civs[p]!]!.effect;
      if (effect >= 0) doEffect(ctx, p, effect);
    }
    const stockpiles = [START_STOCKPILES[options.resourceLevel ?? RESOURCES_DEFAULT], options.deathMatch ? DEATH_MATCH_STOCKPILE : undefined];
    for (const stockpile of stockpiles) {
      if (!stockpile) continue;
      const [food, wood, gold, stone] = stockpile;
      for (let p = 1; p < this.players; p++) {
        const a = this.attributes[p]!;
        [a[ATTR_FOOD], a[ATTR_WOOD], a[ATTR_GOLD], a[ATTR_STONE]] = [food, wood, gold, stone];
      }
    }
    for (let p = 1; p < this.players; p++) startInAge(ctx, p, options.startingAge ?? AGE_DEFAULT);
  }

  /**
   * A random map game's `new_game` (`RGE_Game_World::new_game` src/world.cpp:983-1083, `new_random_game` :1143-1185,
   * `TRIBE_World::new_game` src/tworld.cpp:394; docs/spec/random-maps.md §6): seeded with the game seed, a draw after
   * the seed, the map, Gaia and the players; one before the map, whose seed is the next draw (`map_generate2`); two
   * after it; three rounds of every player's update; one more; then the world keeps a last draw as its seed. With
   * TRIBE's part: relics and ruins, drawn after the world took its seed, and the civ effects. The players' `fog_update`
   * draws stay before the seed (visibility.md §6). No player is left without objects on the dat's maps, so
   * `random_start` draws nothing (its stand-in Town Center for an empty player is not ported).
   */
  private newRandomGame(type: number, options: WorldOptions): void {
    const rng = this.rng;
    rng.srand(this.randomSeed);
    for (let i = 0; i < 5; i++) rng.rand();
    const m = new RmmMap(this.map, rng, this.rmmWorld());
    // Fixed Positions as the lobby set it (`randomizePositions() == 0`, src/rmm_tdbc.cpp:32); no alliances in a 2-player
    // room. Nomad: Villagers, no Town Center.
    this.randomMapSeed = rng.rand();
    const nomad = options.startingAge === AGE_NOMAD;
    mapGenerate2(m, this.randomMapSeed, { type, players: this.players - 1, fixedPositions: options.fixedPositions ?? true, nomad, allied: () => false });
    // The game's zone maps are made over the finished terrain.
    this.pathing.zones.clear();
    rng.rand();
    rng.rand();
    const ctx = this.gameContext();
    for (let round = 0; round < 3; round++) for (let p = 0; p < this.players; p++) this.updatePlayer(ctx, p);
    rng.rand();
    this.randomSeed = rng.rand();
    const { w, h } = m;
    const placed = placeRelicsAndRuins(m, new MapStack(w, h), new Uint8Array(w * h), {
      victoryType: this.victory.type,
      // The special victories (ruins, artifacts, discoveries) are not ported (victory.md §2): none is wanted.
      artifacts: 0,
      discoveries: 0,
      ruins: 0,
      owned: (types) => [...this.entities.all()].filter((e) => types.includes(e.type)).length,
    });
    // `artifact_count` / `ruin_count` (src/tworld.cpp:732, :736): what the all-relics and all-ruins holds count.
    this.victory.artifactCount = placed.artifactCount ?? 0;
    this.victory.ruinCount = placed.ruinCount ?? 0;
    this.startEffects(options);
  }

  /** The generator's view of the world: masters, and objects made and removed as the game makes them. */
  private rmmWorld(): RmmWorld {
    return {
      master: (owner, type) => (hasMaster(this, owner, type) ? master(this, owner, type) : null),
      create: (owner, type, x, y) => this.createObject(owner, type, x, y, 0),
      destroy: (e) => this.destroyObject(e),
      remove: (e) => this.removeObject(e),
      complete: (e) => void build(this.gameContext(), e, f32(10000)),
      typeOf: (e) => typeOf(this, e),
    };
  }

  /**
   * A start object (`build_all_the_way`): created, then a building clears what it stands on and is built at once
   * (`build(10000)`, which completes it).
   */
  createUnit({ owner, type, x, y }: StartUnit): Entity {
    const e = this.createObject(owner, type, x, y, 0);
    const t = typeOf(this, e);
    if (isBuilding(t)) {
      const ctx = this.gameContext();
      checkDestructables(ctx, t, e.x, e.y, (o) => this.destroyObject(o));
      build(ctx, e, f32(10000));
    }
    return e;
  }

  /**
   * `destroy_obj` (src/stat_obj.cpp): wake the object and mark it for removal. It stays on the obstruction map until it
   * is removed.
   */
  private destroyObject(o: Entity): void {
    if (o.state >= ObjectState.PendingRemoval) return;
    this.wake(o);
    stateChanged(this, o, typeOf(this, o), ObjectState.PendingRemoval);
    o.state = ObjectState.PendingRemoval;
  }

  private wake(e: Entity): void {
    const list = this.awake[e.owner]!;
    if (!list.includes(e.id)) list.unshift(e.id);
  }

  /**
   * `make_new_obj` + `setup` (src/stat_obj.cpp:200-286): place the object, show its standing sprite (one draw if it
   * has a random start frame, sprites.md §4), load its own starting resource, give the owner its flag 1/2 storages,
   * draw one `rand()` and reseed with it (economy.md §7); a moving object then draws its facing (movement.md §11). Units
   * and buildings then get their unit AI, which draws its idle timeouts (unit-ai.md §1.2), and count in the owner's
   * civilian or military population (victory.md §11.2). Animated objects, and static
   * ones without hit points, join the owner's updated list at the front; living trees sleep.
   */
  createObject(owner: number, type: number, x: number, y: number, z: number): Entity {
    const t = master(this, owner, type);
    const own = t.storages.find((s) => s.flag === 0);
    const e = this.entities.create({
      owner,
      type,
      x,
      y,
      z,
      hp: t.hitPoints,
      heldType: own ? own.type : -1,
      heldAmount: own ? own.amount : 0,
      mover: isMoving(t) ? newMover() : undefined,
    });
    if (t.combat) e.attackTimer = 0;
    if (isMoving(t)) e.turnTowardsTime = 0;
    // A priest starts with full faith as its held attribute (src/t_c_obj.cpp:89-92).
    if (t.group === GROUP_PRIEST) {
      e.heldAmount = FAITH_MAX;
      e.heldType = RESOURCE_FAITH;
    }
    teleport(this.gameContext(), e, t, e.x, e.y, e.z, true);
    newSprite(this.gameContext(), e, null);
    giveStorages(this.attributes[owner]!, t, 1, [1, 2]);
    this.rng.srand(this.rng.rand());
    if (e.mover) initialFacing(e, t, e.mover, this.rng);
    if (t.masterType === 70 || t.masterType === 80) e.ai = createUnitAI(this.gameContext(), t);
    // A unit's first move pushes its goal as the final user waypoint, and every later search of that move heads there
    // first (movement.md §5): a chase would end where the target stood when it began. The original's alligator spends
    // that first move on its wander (action 6), which the captain dropped (unit-ai.md §5.5); the lion, which has no
    // wander, and the elephant are given the same start so that they too follow what they attack (unit-ai.md §5.2-§5.4).
    const chaser = e.ai?.kind === AiClass.Predator || e.ai?.kind === AiClass.Lion || e.ai?.kind === AiClass.Elephant;
    if (e.mover && chaser) e.mover.finalUserWaypoint = true;
    countPopulation(this.attributes[owner]!, t, 1);
    if (isAnimated(t) || e.hp <= 0) this.awake[owner]!.unshift(e.id);
    if (isBuilding(t)) setupBuilding(this.gameContext(), e, t, (o) => this.destroyObject(o));
    // `TRIBE_Building_Object`'s constructor gives the Wonder its countdown at once (src/t_b_obj.cpp:53-55, victory.md §8).
    if (type === WONDER && defaultWonderTask(t) !== -1) startWonder(this.gameContext(), e);
    return e;
  }

  /**
   * `TRIBE_Combat_Object::change_ownership` (src/t_c_obj.cpp:240-286, support-actions.md §4.6): every visible-unit record
   * of the object takes the new owner first. An artifact then goes through `RGE_Static_Object::change_ownership`
   * (`artifactOwnership`). Anything else, when the new owner has its master: a building first gives up its built
   * storages, cuts its queue to the unit in training and drops its actions (`TRIBE_Building_Object::change_ownership`,
   * src/t_b_obj.cpp:394-444); the old owner loses its flag-2 storages and the object's sight, the object moves to the
   * front of the new owner's list, takes a private copy of its master (it keeps its old civ's record and techs), gives
   * the new owner its sight and flag 1/2 storages, purges its notes and tells itself (0x20B, which stops it on its new
   * owner's turn). A built building then runs its on-build object and tech for the new owner and gives it the built
   * storages. Its other actions keep running until then; the civilian/military counts stay with the old owner (decomp
   * @bug, src/t_c_obj.cpp:233-238).
   */
  private changeOwnership(e: Entity, owner: number): void {
    const ctx = this.gameContext();
    const old = typeOf(this, e);
    this.visibility.setRecordOwner(e.id, old.group, owner);
    if (old.group === GROUP_ARTIFACT) return this.artifactOwnership(e, owner);
    if (!hasMaster(this, owner, e.type)) return;
    const building = isBuilding(old);
    if (building) {
      if (e.state === ObjectState.Active) giveBuiltStorages(ctx, e, old, -1);
      if (e.state === ObjectState.Unbuilt) unexploreObject(this, e, old, true);
      if (e.queue && e.queue.length > 0) e.queue = [{ unit: e.queue[0]!.unit, count: 1 }];
      deleteActions(ctx, e);
    }
    giveStorages(this.attributes[e.owner]!, old, -1, [2]);
    this.moveToOwnerList(e, owner);
    if (e.state === ObjectState.Active) unexploreObject(this, e, old, false);
    e.owner = owner;
    if (!e.ownMaster) e.ownMaster = copyUnitType(old);
    const t = e.ownMaster;
    if (e.state === ObjectState.Active) exploreObject(this, e, t, false);
    giveStorages(this.attributes[owner]!, t, 1, [1, 2]);
    if (e.ai) purgeNotes(ctx, e);
    notifyObject(ctx, e, e.id, NOTIFY_OWNER_CHANGED, owner);
    if (!building) return;
    if (e.state === ObjectState.Unbuilt) exploreObject(this, e, t, true);
    if (e.state === ObjectState.Active) {
      if (t.building!.makeObject > -1) this.createObject(owner, t.building!.makeObject, e.x, e.y, e.z);
      if (t.building!.techId > -1) doTech(ctx, owner, t.building!.techId);
      giveBuiltStorages(ctx, e, t, 1);
    }
  }

  /** `removeObject` from the old owner's list, `addObject` at the front of the new owner's. */
  private moveToOwnerList(e: Entity, owner: number): void {
    const list = this.awake[e.owner]!;
    const i = list.indexOf(e.id);
    if (i !== -1) {
      list.splice(i, 1);
      this.awake[owner]!.unshift(e.id);
    }
  }

  /**
   * An artifact's `change_ownership` through `RGE_Action_Object::change_ownership` (src/act_obj.cpp:425-429) and
   * `RGE_Static_Object::change_ownership` (src/stat_obj.cpp:1675-1720): nothing when the new owner has no such master;
   * else its actions stop, the old owner loses its flag-2 storages and the object's sight, the object moves to the front
   * of the new owner's list, shows the new master's sprite (one draw for a random start frame), keeps its hit-point ratio,
   * and the new owner gets its sight and its flag 1/2 storages. The closing `notify(0x20B)` to itself is dropped: the
   * artifact AI ignores it (src/taiuaimd.cpp:2093-2111).
   */
  private artifactOwnership(e: Entity, owner: number): void {
    if (!hasMaster(this, owner, e.type)) return;
    const ctx = this.gameContext();
    deleteActions(ctx, e);
    const old = typeOf(this, e);
    const next = master(this, owner, e.type);
    const hpRatio = div32(e.hp, f32(Math.trunc(old.hitPoints)));
    giveStorages(this.attributes[e.owner]!, old, -1, [2]);
    if (e.state === ObjectState.Active) unexploreObject(this, e, old, false);
    this.moveToOwnerList(e, owner);
    // `new_sprite` runs while the object still has its old master.
    const sprite = old.dying && e.sprite?.graphic === old.dying.graphic ? next.dying : next.standing;
    if (sprite) newSprite(ctx, e, sprite);
    e.owner = owner;
    e.hp = mul32(f32(Math.trunc(next.hitPoints)), hpRatio);
    if (e.state === ObjectState.Active) exploreObject(this, e, next, false);
    giveStorages(this.attributes[owner]!, next, 1, [1, 2]);
  }

  /** The context object updates and orders run with (current RNG, delta and clock). */
  gameContext(): GameContext {
    return {
      map: this.map,
      entities: this.entities,
      pathing: this.pathing,
      rng: this.rng,
      deltaSeconds: this.deltaSeconds,
      attempts: 0,
      attributes: this.attributes,
      techs: this.techs,
      researchDone: this.researchDone,
      masters: this.masters,
      visibility: this.visibility,
      diplomacy: this.diplomacy,
      worldTime: this.worldTime,
      playerTurn: this.playerTurn,
      playerTimeDelta: this.playerTimeDelta,
      alertCooldown: this.alertCooldown,
      depleted: this.depleted,
      victory: this.victory,
      civs: this.civs,
      quickBuild: this.cheats.quickBuild,
      create: (owner, type, x, y, z) => this.createObject(owner, type, x, y, z),
      wake: (e) => this.wake(e),
      objectsOf: (owner) => this.awake[owner]!.map((id) => this.entities.get(id)!),
      changeOwnership: (e, owner) => this.changeOwnership(e, owner),
      connectWall: (e) => connectWall(this.gameContext(), e),
      targetMoved: (e) => notifyObject(this.gameContext(), e, e.id, NOTIFY_TARGET_MOVED, 0),
      mastersChanged: (player) => {
        this.mastersDigest[player] = undefined;
      },
      techDone: (player, id) => historyTech(this.log, player, id, this.worldTime),
      notify: (type, p1, p2, p3, p4) => notify(this.log, this.worldTime, type, p1, p2, p3, p4),
      alliedLosOn: (player) => {
        this.diplomacy.alliedLos[player] = true;
        updateMutualAllies(this.diplomacy, this.visibility);
      },
    };
  }

  /**
   * Remove an object that is ready (`recycle_out_of_game`): off the obstruction map, the lists and the store; a unit or
   * building leaves the owner's civilian or military population (its destructor).
   */
  private removeObject(e: Entity): void {
    const t = typeOf(this, e);
    if (t.trackAsResource) this.visibility.removeResource(e.id, t.resourceGroup, toInt(e.x), toInt(e.y));
    countPopulation(this.attributes[e.owner]!, t, -1);
    this.pathing.unstamp(e, t);
    if (t.masterType >= 50) forgetSighting(this, e, t);
    // The destructor exits a transport's passengers and takes a passenger off its transport (naval.md §7.3).
    exitObj(this.gameContext(), e);
    exitAll(this.gameContext(), e);
    const list = this.awake[e.owner]!;
    const i = list.indexOf(e.id);
    if (i !== -1) list.splice(i, 1);
    this.entities.remove(e.id);
  }

  /**
   * Per tile index, the objects on it whose master has `track_as_resource`, by descending id (a tile's list order, as
   * `areaAttack` takes it), with their `resource_group`. Such objects never move, so the index is rebuilt only when an
   * object was created or removed since.
   */
  private trackedOnTile(): Map<number, [id: number, group: number][]> {
    const key = `${this.entities.nextEntityId}/${this.entities.size}`;
    if (this.tracked?.key === key) return this.tracked.tiles;
    const tiles = new Map<number, [number, number][]>();
    for (const e of this.entities.all()) {
      // `test` probe objects are not game objects.
      if (e.inside != null || !hasMaster(this, e.owner, e.type)) continue;
      const t = typeOf(this, e);
      if (!t.trackAsResource) continue;
      const tile = toInt(e.y) * this.map.width + toInt(e.x);
      const list = tiles.get(tile);
      if (list) list.unshift([e.id, t.resourceGroup]);
      else tiles.set(tile, [[e.id, t.resourceGroup]]);
    }
    this.tracked = { key, tiles };
    return tiles;
  }

  /** Queue the commands `player` issued during `issueTurn`; they run on `issueTurn + COMMAND_DELAY_TURNS`. */
  addBatch(issueTurn: number, player: number, commands: readonly Command[]): void {
    this.queue.push(issueTurn + COMMAND_DELAY_TURNS, player, commands);
  }

  get pendingCommands(): number {
    return this.queue.size;
  }

  /** Schedule `(G, F)` agreed for turn `change.turn`; it applies from the next turn on (docs/spec/turn-timing.md §5). */
  setSpeedChange(change: SpeedChange): void {
    this.speedChanges = this.speedChanges.filter((c) => c.turn !== change.turn);
    this.speedChanges.push({ ...change });
    this.speedChanges.sort((a, b) => a.turn - b.turn);
  }

  runTurn(): void {
    const turn = this.turn;
    while (this.turn === turn) this.runStep();
  }

  /** Run the next step of the current turn: its boundary step first, which applies any due speed change. */
  runStep(): void {
    if (this.turnStep === 0) {
      // `AdjustLocalSpeed` at the boundary `E -> E + 1` (src/com_spd.cpp:114-138).
      const { granularity, frames } = this.speedAtBoundary();
      this.speedChanges = this.speedChanges.filter((c) => c.turn >= this.turn);
      this.granularity = granularity;
      this.frames = frames;
    }
    // Once the game is over the screen stops calling the world's update; the turn counters are the comm handler's.
    if (!this.gameOver) this.step(this.granularity);
    this.turnStep++;
    if (this.turnStep >= stepsInTurn(this.turn, this.frames)) {
      this.turnStep = 0;
      this.turn++;
    }
  }

  /** The game is over (`game_state` 1): the world is no longer updated (`TRIBE_Screen_Game` stops calling `update`). */
  get gameOver(): boolean {
    return this.victory.gameState === 1;
  }

  /** The end of the game for the client's end screen, or null while it is on. */
  gameResult(): GameResult | null {
    if (!this.gameOver) return null;
    const status = [...this.victory.status];
    return { endCondition: this.victory.endCondition, winners: status.flatMap((s, p) => (p > 0 && s === STATUS_WON ? [p] : [])), status };
  }

  /** `player`'s `game_status`: 0 playing, 1 won, 2 lost. */
  playerStatus(player: number): number {
    return this.victory.status[player] ?? 0;
  }

  /** `player`'s victory points, in the achievements screen's groups (victory.md §11). */
  score(player: number): Score {
    return scoreOf(this.victory, player);
  }

  /** `(G, F)` the current turn runs at once its boundary step applies the changes agreed before it. */
  private speedAtBoundary(): { granularity: number; frames: number } {
    let speed = { granularity: this.granularity, frames: this.frames };
    for (const c of this.speedChanges) if (c.turn < this.turn) speed = c;
    return { granularity: speed.granularity, frames: speed.frames };
  }

  /** One `RGE_Game_World::update` with a non-zero cycle (src/world.cpp:1206). */
  private step(cycle: number): void {
    const rng = this.rng;
    rng.srand(this.randomSeed);
    const oldTime = this.worldTime;
    this.worldTime = u32(oldTime + toUint(mul32(cycle, this.gameSpeed)));
    const delta = u32(this.worldTime - oldTime);
    if (delta !== 0) {
      const status = [...this.victory.status];
      for (const queued of this.queue.take(this.turn)) this.execute(queued);
      this.deltaSeconds = mul32(delta, MS_TO_SECONDS);
      const ctx = this.gameContext();
      for (let i = 0; i < this.players; i++) {
        this.playerTimeDelta[i] = u32(this.playerTimeDelta[i]! + delta);
        this.updatePlayer(ctx, i);
      }
      // Fog ghost updates draw from the RNG on each peer's local view; the original fences them so the
      // stream afterwards depends only on this draw (src/world.cpp:1283-1294).
      rng.srand(rng.rand());
      this.playerTimeDelta[this.playerTurn] = 0;
      this.playerTurn = (this.playerTurn + 1) % this.players;
      checkGameState(this.victory, this.deltaSeconds, this.attributes, this.diplomacy);
      // `set_game_status(2)` without a resignation raises `GAME_NOTIFY_PLAYER_DEFEATED` (src/player.cpp:262-264).
      for (let p = 1; p < this.players; p++) {
        if (status[p] !== STATUS_LOST && this.victory.status[p] === STATUS_LOST && !this.victory.resigned[p]) notify(this.log, this.worldTime, NOTIFY_PLAYER_DEFEATED, p);
      }
    }
    this.randomSeed = rng.rand();
  }

  /**
   * `TRIBE_Player::update` / `TRIBE_Gaia::update` over `RGE_Player::update` for player `i`, with the context's delta;
   * the world step runs it for every player, and a random game's `new_game` three times before the first step.
   */
  private updatePlayer(ctx: GameContext, i: number): void {
    const rng = this.rng;
    // `TRIBE_Player::update`: once a game second, before its objects, the alert cooldown runs down and the trade goods
    // regrow (support-actions.md §7.4; Gaia's has none).
    if (i > 0) {
      this.playerUpdateTime[i] = add32(this.playerUpdateTime[i]!, this.deltaSeconds);
      while (this.playerUpdateTime[i]! > 1) {
        this.playerUpdateTime[i] = sub32(this.playerUpdateTime[i]!, 1);
        historySecond(this.log, i, this.attributes[i]![ATTR_POPULATION]!);
        if (this.alertCooldown[i]! > 0) this.alertCooldown[i]!--;
        perSecond(this.victory, i, {
          attributes: this.attributes[i]!,
          exploredTiles: this.visibility.explored[i]!,
          totalTiles: this.map.width * this.map.height,
          objects: ctx.objectsOf(i),
          groupOf: (e) => typeOf(this, e).group,
        });
        regrowTradeGoods(this.attributes[i]!);
      }
    }
    // `RGE_Player::update` (src/player.cpp:870): the path search counter restarts, then the object list updates
    // from its head. Objects created or woken during the walk go in front of it and wait for the next step.
    ctx.attempts = 0;
    for (const id of [...this.awake[i]!]) {
      const e = this.entities.get(id);
      if (e && updateObject(ctx, e)) this.removeObject(e);
    }
    // Then the player's victory points and conditions (`RGE_Player::update`, victory.md §4).
    updateConditions(this.victory, i, this.attributes, this.diplomacy);
    // Last, the objects on the tiles it explored since its last update join its visible-resource lists (unit-ai.md §3.4).
    if (this.visibility.newTiles[i]!.length > 0) {
      const tracked = this.trackedOnTile();
      this.visibility.processNewTiles(i, (tile) => tracked.get(tile));
    }
    // `TRIBE_Player::update` ends by fencing its computer-player AI off the stream (src/tplayer.cpp:607-631): one
    // draw becomes the seed. Gaia's update (`TRIBE_Gaia::update`) has no fence.
    if (i > 0) rng.srand(rng.rand());
  }

  private execute({ player, command }: QueuedCommand): void {
    // `TRIBE_Command::do_command` draws once for every command before dispatch (docs/spec/core.md §2.4).
    this.rng.rand();
    switch (command.type) {
      case 'noop':
        return;
      case 'move':
        return this.doCommandMove(player, command);
      case 'work':
        return this.doCommandWork(player, command);
      case 'attack':
        return this.doCommandAttack(player, command);
      case 'build':
        return this.doCommandBuild(player, command);
      case 'build-wall':
        return this.doCommandBuildWall(player, command);
      case 'queue':
        return this.doCommandQueue(player, command);
      case 'cancel':
        return this.doCommandCancel(player, command);
      case 'research':
        return this.doCommandResearch(player, command);
      case 'stop':
        return this.doCommandStop(player, command);
      case 'resign':
        // `do_resign` (src/player.cpp:266-273): the notice once, `dropped` 0 for the command.
        if (!this.victory.resigned[player]) notify(this.log, this.worldTime, NOTIFY_PLAYER_RESIGNED, player, 0);
        return resign(this.victory, player);
      case 'repair':
        return this.doCommandRepair(player, command);
      case 'stand-ground':
        return this.doCommandStandGround(player, command);
      case 'attack-ground':
        return this.doCommandAttackGround(player, command);
      case 'unload':
        return this.doCommandUnload(player, command);
      case 'trade-attribute':
        return this.doCommandTradeAttribute(player, command);
      case 'formation':
        return this.doCommandFormation(player, command);
      case 'cheat':
        return cheat(this.gameContext(), this.cheats, player, command.code);
      case 'quick-build':
        // `do_command_game` case 4: not gated (chat.md §7.2).
        this.cheats.quickBuild = command.on;
        return;
      case 'game-speed':
        // `do_command_game` case 1 (src/tcommand.cpp:377): from the next step on, each step adds `cycle * game_speed`.
        this.gameSpeed = f32(command.speed);
        return;
      case 'relation':
        return this.doCommandRelation(player, command);
      case 'allied-victory':
        return this.doCommandAlliedVictory(player, command);
      case 'tribute':
        return this.doCommandTribute(player, command);
      case 'test': {
        const tx = f32(command.x);
        const ty = f32(command.y);
        // Type -1: no table has it (type 0 is the Academy).
        this.entities.create({ owner: player, type: -1, x: tx, y: ty, z: 0, hp: 1 + (this.rng.rand() % 100) });
        for (const e of this.entities.ofPlayer(player)) {
          // Only the probe's own objects: game objects move only through orders.
          if (e.type !== -1) continue;
          const dx = sub32(tx, e.x);
          const dy = sub32(ty, e.y);
          const len = sqrt32(add32(mul32(dx, dx), mul32(dy, dy)));
          if (len === 0) continue;
          e.x = add32(e.x, div32(dx, len));
          e.y = add32(e.y, div32(dy, len));
          e.hp = sub32(e.hp, mul32(this.deltaSeconds, f32(0.7)));
        }
        return;
      }
    }
  }

  /**
   * `RGE_Command::do_command_move` (docs/spec/movement.md §5.1). Units listed but missing, or not the sender's, are
   * skipped yet still count towards the group size, as missing ones do in the original.
   */
  private doCommandMove(player: number, command: MoveCommand): void {
    const ids = command.units;
    const units = ids.map((id) => {
      const e = this.entities.get(id);
      return e?.mover && e.owner === player ? e : undefined;
    });
    const x = f32(command.x);
    const y = f32(command.y);
    let keepFormation = false;
    let avgX = 0;
    let avgY = 0;
    if (ids.length > 1) {
      let minX = f32(10000);
      let maxX = 0;
      let minY = f32(10000);
      let maxY = 0;
      for (const e of units) {
        if (!e) continue;
        if (e.x < minX) minX = e.x;
        else if (e.x > maxX) maxX = e.x;
        if (e.y < minY) minY = e.y;
        else if (e.y > maxY) maxY = e.y;
        avgX = add32(avgX, e.x);
        avgY = add32(avgY, e.y);
      }
      keepFormation = !(sub32(maxX, minX) > GROUP_EXTENT_LIMIT || sub32(maxY, minY) > GROUP_EXTENT_LIMIT);
      avgX = div32(avgX, ids.length);
      avgY = div32(avgY, ids.length);
    }
    const width = f32(this.map.width);
    const height = f32(this.map.height);
    units.forEach((e, index) => {
      if (!e) return;
      const m = e.mover!;
      m.group = ids.filter((_, other) => other !== index);
      m.waitingToMove = true;
      let tx = x;
      let ty = y;
      if (keepFormation) {
        tx = add32(sub32(e.x, avgX), x);
        ty = add32(sub32(e.y, avgY), y);
        if (tx < 0) tx = 1;
        else if (tx >= width) tx = sub32(width, 1);
        if (ty < 0) ty = 1;
        else if (ty >= height) ty = sub32(height, 1);
      }
      // `move_to`: a gather or hunt action takes the order itself (src/act_obj.cpp:111-113); otherwise the walk is the
      // only action.
      if (!workMoveTo(this.gameContext(), e, tx, ty)) {
        e.attack = null;
        orderMove(this.gameContext(), e, tx, ty);
        countCommand(e);
      }
      setAiState(e, AI_ORDER_MOVE, AI_ACTION_MOVE, -1, -1, tx, ty, 0);
    });
  }

  /**
   * `RGE_Command::do_command_formation` (src/Command.cpp:492-578, commands.md §6): with two units or more listed, the
   * one nearest the map origin stays and the others, in list order, walk to points stepped off from it. Every unit
   * joins the others' pathing group and waits to move. Listed units missing, not the sender's or not mobile are skipped
   * (port: the original lines up any object listed).
   */
  private doCommandFormation(player: number, command: FormationCommand): void {
    const ids = command.units;
    if (ids.length <= 1) return;
    const units = ids.map((id) => {
      const e = this.entities.get(id);
      return e?.mover && e.owner === player ? e : undefined;
    });
    let reference: Entity | undefined;
    let distance = 0;
    for (const e of units) {
      if (!e) continue;
      const d = sqrt32(add32(mul32(e.x, e.x), mul32(e.y, e.y)));
      if (!reference || d < distance) {
        reference = e;
        distance = d;
      }
    }
    if (!reference) return;
    const f = command.formation;
    // The steps along x (`adjustedYLocation`) and y (`tempX`), and which side the wedges' next unit takes.
    let stepX = f === 2 || f === 3 ? f32(2) : f === 0 ? f32(1) : f32(1.5);
    let stepY = stepX;
    let alternate = false;
    units.forEach((e, index) => {
      if (!e) return;
      const m = e.mover!;
      m.group = ids.filter((_, other) => other !== index);
      m.waitingToMove = true;
      if (e === reference) return;
      let x = reference.x;
      let y = reference.y;
      switch (f) {
        case 0:
          x = add32(x, stepX);
          stepX = add32(stepX, 1);
          y = add32(y, stepY);
          stepY = add32(stepY, 1);
          break;
        case 1:
          x = add32(x, stepX);
          stepX = add32(stepX, f32(1.5));
          y = sub32(y, stepY);
          stepY = add32(stepY, f32(1.5));
          break;
        case 2:
          x = add32(x, stepX);
          stepX = add32(stepX, 2);
          break;
        case 3:
          y = add32(y, stepY);
          stepY = add32(stepY, 2);
          break;
        case 4:
        case 5:
          x = f === 4 ? add32(x, stepX) : sub32(x, stepX);
          if (!alternate) {
            y = sub32(y, stepY);
            alternate = true;
          } else {
            y = add32(y, stepY);
            stepY = add32(stepY, f32(1.5));
            stepX = add32(stepX, f32(1.5));
            alternate = false;
          }
          break;
      }
      // `move_to(0, x, y, 1.0f)` (src/act_obj.cpp:110-136): no clamp to the map, z 1.
      const one = f32(1);
      if (!workMoveTo(this.gameContext(), e, x, y)) {
        e.attack = null;
        orderMove(this.gameContext(), e, x, y, one);
        countCommand(e);
      }
      setAiState(e, AI_ORDER_MOVE, AI_ACTION_MOVE, -1, -1, x, y, one);
    });
  }

  /**
   * `RGE_Command::do_command_work` (src/Command.cpp:295): each listed unit of the sender joins the others' pathing
   * group and is ordered to work on the target (`work2`, economy.md §3.1). A missing target leaves a walk to (x, y).
   */
  private doCommandWork(player: number, command: WorkCommand): void {
    // `test` probe objects are not game objects: an order on one is an order on nothing.
    const found = this.entities.get(command.target);
    const target = found && hasMaster(this, found.owner, found.type) ? found : undefined;
    const ids = command.units;
    const ctx = this.gameContext();
    ids.forEach((id, index) => {
      const e = this.entities.get(id);
      if (!e?.mover || e.owner !== player || e.state !== 2) return;
      e.mover.group = ids.filter((_, other) => other !== index);
      e.mover.waitingToMove = true;
      orderWork(ctx, e, target, command.x, command.y);
      if (target !== e) countCommand(e);
    });
  }

  /**
   * Attack order: the right-click on an enemy, which the original sends as a work order on the target at its position
   * (`do_command_work`, then the unit's attack task). A missing target is an order on nothing.
   */
  private doCommandAttack(player: number, command: AttackCommand): void {
    const target = this.entities.get(command.target);
    if (!target || !hasMaster(this, target.owner, target.type)) return;
    this.doCommandWork(player, { type: 'work', units: command.units, target: target.id, x: target.x, y: target.y });
  }

  /**
   * `TRIBE_Command::do_command_build` (economy.md §4.1): the foundation must fit (construction radius, objects that can
   * be built on ignored) and be paid for; then it is created and each listed unit of the sender is ordered onto it.
   */
  private doCommandBuild(player: number, command: BuildCommand): void {
    if (!hasMaster(this, player, command.unitType)) return;
    const t = master(this, player, command.unitType);
    if (!isBuilding(t) || !t.creatable) return;
    const x = f32(command.x);
    const y = f32(command.y);
    const ctx = this.gameContext();
    if (checkPlacement(ctx, t, x, y, true, true, player) !== 0) return;
    if (!payObjCost(ctx, player, t.id, 1, false)) return;
    const building = this.createObject(player, t.id, x, y, 0);
    for (const id of command.units) {
      const e = this.entities.get(id);
      if (!e?.mover || e.owner !== player || e.state !== ObjectState.Active) continue;
      e.mover.group = [];
      orderWork(ctx, e, building, x, y);
      countCommand(e);
    }
  }

  /**
   * `TRIBE_Command::do_command_build_wall` (`src/tcommand.cpp:239-296`, economy.md §4.8.1): a line from (x1, y1) when
   * the two axes differ by as much, else two legs, along the longer axis to the end's row or column, then across from
   * the tile after the corner; then each listed unit of the sender is ordered onto the first segment placed.
   */
  private doCommandBuildWall(player: number, command: BuildWallCommand): void {
    if (!hasMaster(this, player, command.unitType)) return;
    const t = master(this, player, command.unitType);
    if (!isBuilding(t) || !t.creatable) return;
    const { x1, y1, x2, y2 } = command;
    const dy = Math.abs(y2 - y1);
    const dx = Math.abs(x2 - x1);
    let first: Entity | null = null;
    const leg = (ax: number, ay: number, bx: number, by: number) => {
      first = this.placeLineOfWalls(player, t, ax, ay, bx, by, first);
    };
    if (dy === dx) leg(x1, y1, x2, y2);
    else if (dy >= dx) {
      leg(x1, y1, x1, y2);
      if (x1 < x2) leg(x1 + 1, y2, x2, y2);
      else if (x1 > x2) leg(x1 - 1, y2, x2, y2);
    } else {
      leg(x1, y1, x2, y1);
      if (y1 < y2) leg(x2, y1 + 1, x2, y2);
      else if (y1 > y2) leg(x2, y1 - 1, x2, y2);
    }
    const wall = first as Entity | null;
    if (!wall) return;
    const ctx = this.gameContext();
    for (const id of command.units) {
      const e = this.entities.get(id);
      if (!e?.mover || e.owner !== player || e.state !== ObjectState.Active) continue;
      e.mover.group = [];
      orderWork(ctx, e, wall, wall.x, wall.y);
    }
  }

  /**
   * `TRIBE_Command::place_line_of_walls` (`src/tcommand.cpp:298-341`): from tile (x1, y1) one step at a time towards
   * (x2, y2), both axes moving by their sign, a segment at each tile centre that passes `check_placement` (as a
   * foundation; seen, objects that can be built on ignored) and that the player can pay for; the leg stops at the
   * first segment it cannot pay. A tile that does not fit is skipped. Returns the first segment of the command.
   */
  private placeLineOfWalls(player: number, t: UnitType, x1: number, y1: number, x2: number, y2: number, first: Entity | null): Entity | null {
    const stepX = Math.sign(x2 - x1);
    const stepY = Math.sign(y2 - y1);
    let x = x1;
    let y = y1;
    for (;;) {
      const wx = f32(x + 0.5);
      const wy = f32(y + 0.5);
      if (checkPlacement(this.gameContext(), t, wx, wy, true, true, player) === 0) {
        if (!payObjCost(this.gameContext(), player, t.id, 1, false)) return first;
        const wall = this.createObject(player, t.id, wx, wy, 0);
        first ??= wall;
      }
      if (x === x2 && y === y2) return first;
      x += stepX;
      y += stepY;
    }
  }

  /**
   * `TRIBE_Command::do_command_queue` (economy.md §5.1): queue or unqueue units at a building. Only buildings have a
   * queue. Port-side guard (economy.md §5.5): the original accepts another player's building, this ignores it; the
   * command's `rand()` was already drawn in `execute`, so determinism is the same as for an accepted command.
   */
  private doCommandQueue(player: number, command: QueueCommand): void {
    const building = this.entities.get(command.building);
    if (!building?.queue || building.owner !== player || building.state >= ObjectState.PendingRemoval || !hasMaster(this, player, command.unit)) return;
    const ctx = this.gameContext();
    if (command.count > 0) addToQueue(ctx, building, command.unit, command.count);
    else removeFromQueue(ctx, building, command.unit, -command.count);
  }

  /**
   * `TRIBE_Command::do_command_cancel_build` → `cancel_object`: a foundation is cancelled with a refund (economy.md
   * §4.4), anything else of combat level or above is killed (`die_die_die`). Port-side guard (economy.md §5.5): a target
   * the sender does not own is ignored, the original accepts it.
   */
  private doCommandCancel(player: number, command: CancelCommand): void {
    const e = this.entities.get(command.target);
    if (!e || e.owner !== player || !hasMaster(this, e.owner, e.type) || e.state >= ObjectState.PendingRemoval) return;
    const t = typeOf(this, e);
    if (t.masterType < 50) return;
    const ctx = this.gameContext();
    if (isBuilding(t) && e.state === ObjectState.Unbuilt) cancelBuild(ctx, e);
    else {
      // `TRIBE_Combat_Object::cancel_object` → `die_die_die`: a priest's martyrdom first (support-actions.md §4.5).
      martyrdom(ctx, e);
      this.wake(e);
      e.hp = 0;
    }
  }

  /**
   * `TRIBE_Command::do_command_research` (techs.md §3.1): the building starts researching the tech, unless it already
   * researches. Port-side guard (economy.md §5.5): the original accepts another player's building, this ignores it, and
   * an unknown tech id; the command's `rand()` was already drawn in `execute`.
   */
  private doCommandResearch(player: number, command: ResearchCommand): void {
    const building = this.entities.get(command.building);
    if (!building?.queue || building.owner !== player || building.state !== ObjectState.Active || !TECHS[command.tech]) return;
    orderResearch(this.gameContext(), building, command.tech);
  }

  /**
   * `RGE_Command::do_command_stop` (docs/spec/commands.md §2): each listed object `stop`s. A unit's action ends and its
   * unit AI stops (`RGE_Combat_Object::stop` → `stopObject(1)`); a building also stops its research and empties its
   * queue, refunded (techs.md §3.5). Port-side guard (economy.md §5.5): the original stops any listed object of any
   * player; another player's objects are skipped.
   */
  private doCommandStop(player: number, command: StopCommand): void {
    const ctx = this.gameContext();
    for (const id of command.objects) {
      const e = this.entities.get(id);
      if (!e || e.owner !== player || e.state !== ObjectState.Active) continue;
      stopBuilding(ctx, e);
    }
  }

  /**
   * `TRIBE_Command::do_command_repair` (support-actions.md §6.1): each listed unit `do_repair`s the target, becoming the
   * Repair_Man. Port-side guards (economy.md §5.5): a missing target is skipped (the original would crash), and so are
   * units not the sender's or not of the Repair_Man's object group (the original's button sends only those).
   */
  private doCommandRepair(player: number, command: RepairCommand): void {
    const target = this.entities.get(command.target);
    if (!target || target.state >= ObjectState.PendingRemoval || !hasMaster(this, player, REPAIR_MAN)) return;
    const ctx = this.gameContext();
    const group = master(this, player, REPAIR_MAN).group;
    for (const id of command.units) {
      const e = this.entities.get(id);
      if (!e?.mover || e.owner !== player || e.state !== ObjectState.Active || typeOf(this, e).group !== group) continue;
      doRepair(ctx, e, target);
    }
  }

  /**
   * Stand ground: `RGE_Player::command_stand_ground` sends a group AI order that `do_command_group_ai_order` gives each
   * listed object (docs/spec/commands.md §3). Port-side guard (economy.md §5.5): another player's objects are skipped.
   */
  private doCommandStandGround(player: number, command: StandGroundCommand): void {
    const ctx = this.gameContext();
    for (const id of command.units) {
      const e = this.entities.get(id);
      if (!e || e.owner !== player || e.state !== ObjectState.Active) continue;
      standGround(ctx, e, player);
    }
  }

  /**
   * `TRIBE_Command::do_command_unload` (src/tcommand.cpp:513, naval.md §7.6): each listed object leaves its pathing group
   * and gets an immediate UNLOAD order at (x, y). Port-side guards (economy.md §5.5): only the sender's active transports
   * (the original's button sends only objects of `unit_level` 7).
   */
  private doCommandUnload(player: number, command: UnloadCommand): void {
    const ctx = this.gameContext();
    for (const id of command.units) {
      const e = this.entities.get(id);
      if (!e?.mover || e.owner !== player || e.state !== ObjectState.Active || !isTransport(typeOf(this, e))) continue;
      e.mover.group = [];
      orderUnload(ctx, e, f32(command.x), f32(command.y));
    }
  }

  /**
   * `TRIBE_Command::do_command_trade_attribute` (src/tcommand.cpp:489, support-actions.md §7.6): each listed object's held
   * attribute becomes the cargo. Port-side guards: only the sender's active trade boats (the sender's own filter,
   * `get_selected_objects_to_command` with `unit_level` 5, src/tplayer.cpp:946).
   */
  private doCommandTradeAttribute(player: number, command: TradeAttributeCommand): void {
    for (const id of command.units) {
      const e = this.entities.get(id);
      if (!e || e.owner !== player || e.state !== ObjectState.Active || typeOf(this, e).unitLevel !== UNIT_LEVEL_TRADE) continue;
      setTradeAttribute(e, command.attribute);
    }
  }

  /**
   * Attack Ground (`TRIBE_Command::do_command_attack_ground`, src/tcommand.cpp:442, commands.md §5): each listed unit
   * gets `attack(x, y, 0, 1)`. Port-side guards: only the sender's active objects (the sender's own filter,
   * `get_selected_objects_to_command`).
   */
  private doCommandAttackGround(player: number, command: AttackGroundCommand): void {
    const ctx = this.gameContext();
    for (const id of command.units) {
      const e = this.entities.get(id);
      if (!e || e.owner !== player || e.state !== ObjectState.Active) continue;
      attackGround(ctx, e, command.x, command.y);
    }
  }

  /**
   * Stance (`TRIBE_Command::do_command_game` game command 0, src/tcommand.cpp:370-375, diplomacy.md §4): the sender's
   * stance towards `command.player` changes, then the mutual-ally masks. Port-side guards (the Diplomacy dialog's rows,
   * src/dlg_dip.cpp:124-131, 440-455): only towards another player, 1 and up, still playing.
   */
  private doCommandRelation(player: number, command: RelationCommand): void {
    const to = command.player;
    if (to < 1 || to >= this.players || to === player || this.victory.status[to] !== 0) return;
    this.diplomacy.relations[player]![to] = command.relation;
    notify(this.log, this.worldTime, NOTIFY_DIPLOMACY_CHANGED, player, to, command.relation, 0);
    updateMutualAllies(this.diplomacy, this.visibility);
  }

  /** Allied victory (game command 5, src/tcommand.cpp:368-370, diplomacy.md §4): the sender's flag. */
  private doCommandAlliedVictory(player: number, command: AlliedVictoryCommand): void {
    this.diplomacy.alliedVictory[player] = command.on;
  }

  /**
   * Tribute (`TRIBE_Command::do_command_give_attribute`, diplomacy.md §5). Port-side guards (the Diplomacy dialog's
   * rows): only to another player, 1 and up, still playing; `giveAttribute` refuses a sender without an active Market.
   */
  private doCommandTribute(player: number, command: TributeCommand): void {
    const to = command.player;
    if (to < 1 || to >= this.players || to === player || this.victory.status[to] !== 0) return;
    const given = giveAttribute({ attributes: this.attributes, objectsOf: (p) => this.entities.ofPlayer(p) }, player, to, command.resource, command.amount);
    // `GAME_NOTIFY_TRIBUTE_PAID` with `(long)` of what `to` received (src/tcommand.cpp:481-483).
    if (given >= 0) notify(this.log, this.worldTime, NOTIFY_TRIBUTE_PAID, player, to, command.resource, Math.trunc(given));
  }

  /** `player`'s stance towards `other` (0 ally, 1 neutral, 3 enemy; diplomacy.md §1). For the client's dialogs. */
  relation(player: number, other: number): number {
    return relation(this, player, other);
  }

  /** `isAlly`: `other` is `player` itself or a player `player` calls an ally (one-sided; the chat's Allies button). */
  isAlly(player: number, other: number): boolean {
    return isAlly(this, player, other);
  }

  /** `isEnemy`: `other` is another player `player` calls an enemy (the chat's Enemies button). */
  isEnemy(player: number, other: number): boolean {
    return isEnemy(this, player, other);
  }

  /**
   * What `player` knows of tile (col, row) (`get_visible`): `TILE_VISIBLE` (0x0F) while seen, `TILE_FOGGED` (0x80) once
   * explored, `TILE_BLACK` (0) before. For the client's fog drawing and minimap.
   */
  tileVisibility(player: number, col: number, row: number): number {
    return this.visibility.get(player, col, row);
  }

  /**
   * The live sync check's checksum (`GetWorldChecksums`, `RGE_Player::get_checksums`): the clock, the random seed, every
   * player's stockpiles and techs, and each object's id, owner, type, position, hit points, state and load. It costs
   * a fraction of `hash()`, which walks every field of every object: a divergence that starts in an object's inner
   * state shows here once it moves an object, changes a stockpile or draws a different `rand()`.
   */
  syncChecksum(): number {
    const h = new Hasher().u32(this.turn).u32(this.turnStep).u32(this.worldTime).u32(this.randomSeed).u32(this.entities.nextEntityId).u32(this.entities.size);
    hashValue(h, this.attributes);
    hashValue(h, this.techs);
    hashValue(h, this.researchDone);
    hashValue(h, this.victory);
    for (const e of this.entities.all()) {
      h.u32(e.id).u32(e.owner).u32(e.type).f32(e.x).f32(e.y).f32(e.z).f32(e.hp).u32(e.state).u32(e.heldType).f32(e.heldAmount);
    }
    return h.digest();
  }

  /** 32-bit hash of the whole state; equal on every peer while they are in sync. */
  hash(): number {
    const h = new Hasher()
      .u32(this.players)
      .u32(this.turn)
      .u32(this.turnStep)
      .u32(this.granularity)
      .u32(this.frames)
      .u32(this.worldTime)
      .u32(this.randomSeed)
      .f32(this.gameSpeed)
      .u32(this.playerTurn)
      .f32(this.deltaSeconds);
    for (const d of this.playerTimeDelta) h.u32(d);
    for (const t of this.playerUpdateTime) h.f32(t);
    for (const c of this.alertCooldown) h.u32(c);
    for (const c of this.depleted) h.u32(c);
    h.u32(this.entities.nextEntityId).u32(this.entities.size);
    for (const e of this.entities.all()) hashValue(h, e);
    hashValue(h, this.attributes);
    hashValue(h, this.awake);
    hashValue(h, this.techs);
    hashValue(h, this.researchDone);
    hashValue(h, this.civs);
    for (let p = 0; p < this.players; p++) h.u32((this.mastersDigest[p] ??= digest(this.masters[p])));
    for (const f of this.fogUpdate) h.u32(f);
    this.visibility.hashInto(h);
    hashValue(h, this.victory);
    hashValue(h, this.diplomacy);
    hashValue(h, this.log);
    hashValue(h, this.cheats);
    this.map.hashInto(h);
    h.u32(this.pathing.iterations);
    this.pathing.hashInto(h);
    const queued = this.queue.toJSON();
    h.u32(queued.length);
    for (const q of queued) {
      h.u32(q.turn).u32(q.player).u32(q.seq).u32(COMMAND_TYPE_IDS[q.command.type]);
      if (q.command.type === 'test') h.f64(q.command.x).f64(q.command.y);
      if (q.command.type === 'move' || q.command.type === 'work' || q.command.type === 'attack-ground' || q.command.type === 'unload') {
        h.u32(q.command.units.length);
        for (const id of q.command.units) h.u32(id);
        h.f64(q.command.x).f64(q.command.y);
      }
      if (q.command.type === 'work') h.u32(q.command.target);
      if (q.command.type === 'formation') {
        h.u32(q.command.units.length);
        for (const id of q.command.units) h.u32(id);
        h.u32(q.command.formation);
      }
      if (q.command.type === 'build' || q.command.type === 'build-wall' || q.command.type === 'queue' || q.command.type === 'cancel' || q.command.type === 'attack' || q.command.type === 'research' || q.command.type === 'stop' || q.command.type === 'repair' || q.command.type === 'stand-ground' || q.command.type === 'relation' || q.command.type === 'allied-victory' || q.command.type === 'tribute' || q.command.type === 'trade-attribute' || q.command.type === 'cheat' || q.command.type === 'quick-build' || q.command.type === 'game-speed') {
        hashValue(h, q.command);
      }
    }
    return h.digest();
  }

  snapshot(): Snapshot {
    return {
      version: 14,
      players: this.players,
      turn: this.turn,
      granularity: this.granularity,
      frames: this.frames,
      speedChanges: this.speedChanges.map((c) => ({ ...c })),
      worldTime: this.worldTime,
      randomSeed: this.randomSeed,
      gameSpeed: this.gameSpeed,
      playerTurn: this.playerTurn,
      playerTimeDelta: [...this.playerTimeDelta],
      playerUpdateTime: [...this.playerUpdateTime],
      alertCooldown: [...this.alertCooldown],
      depleted: [...this.depleted],
      deltaSeconds: this.deltaSeconds,
      entities: this.entities.toJSON(),
      queue: this.queue.toJSON(),
      map: this.map.toJSON(),
      pathingIterations: this.pathing.iterations,
      obstruction: Array.from(this.pathing.cells),
      attributes: this.attributes.map((a) => [...a]),
      awake: this.awake.map((a) => [...a]),
      techs: this.techs.map((a) => [...a]),
      researchDone: this.researchDone.map((a) => [...a]),
      civs: [...this.civs],
      masters: copyMasters(this.masters),
      fogUpdate: [...this.fogUpdate],
      visibility: this.visibility.toJSON(),
      victory: copyVictory(this.victory),
      diplomacy: copyDiplomacy(this.diplomacy),
      log: copyGameLog(this.log),
      cheats: { ...this.cheats },
    };
  }

  static restore(s: Snapshot): World {
    if (s.version !== 14) throw new Error(`unsupported snapshot version ${String(s.version)}`);
    const w = new World({
      players: s.players,
      randomSeed: s.randomSeed,
      map: TileMap.fromJSON(s.map),
      pathingIterations: s.pathingIterations,
      civs: s.civs,
    });
    w.pathing.cells.set(s.obstruction);
    w.turn = s.turn;
    w.granularity = s.granularity;
    w.frames = s.frames;
    w.speedChanges = s.speedChanges.map((c) => ({ ...c }));
    w.worldTime = s.worldTime;
    w.gameSpeed = s.gameSpeed;
    w.playerTurn = s.playerTurn;
    w.playerTimeDelta = [...s.playerTimeDelta];
    w.playerUpdateTime = [...s.playerUpdateTime];
    w.alertCooldown = [...s.alertCooldown];
    w.depleted = [...s.depleted];
    w.deltaSeconds = s.deltaSeconds;
    w.entities = EntityStore.fromJSON(s.entities);
    w.queue = CommandQueue.fromJSON(s.queue);
    w.attributes = s.attributes.map((a) => [...a]);
    w.awake = s.awake.map((a) => [...a]);
    w.techs = s.techs.map((a) => [...a]);
    w.researchDone = s.researchDone.map((a) => [...a]);
    w.masters = copyMasters(s.masters);
    w.mastersDigest = [];
    w.fogUpdate = [...s.fogUpdate];
    w.visibility = Visibility.fromJSON(s.visibility);
    w.victory = copyVictory(s.victory);
    w.diplomacy = copyDiplomacy(s.diplomacy);
    w.log = copyGameLog(s.log);
    w.cheats = { ...s.cheats };
    return w;
  }
}

/** `hashValue` of `v` on its own. */
function digest(v: unknown): number {
  const h = new Hasher();
  hashValue(h, v);
  return h.digest();
}

/**
 * Hash any plain state value: numbers as float64 (every sim number is a float32 or a 32-bit integer, so this is
 * exact), booleans and null as markers, arrays by length then items, objects by sorted key. Absent, undefined and null
 * fields hash alike.
 */
function hashValue(h: Hasher, v: unknown): void {
  if (v === undefined || v === null) h.u32(0xfffffffe);
  else if (typeof v === 'number') h.f64(v);
  else if (typeof v === 'boolean') h.u32(v ? 0xfffffffd : 0xfffffffc);
  else if (Array.isArray(v)) {
    h.u32(v.length);
    for (const x of v) hashValue(h, x);
  } else if (typeof v === 'object') {
    const o = v as Record<string, unknown>;
    const keys = Object.keys(o)
      .filter((k) => o[k] !== undefined && o[k] !== null)
      .sort();
    h.u32(keys.length);
    for (const k of keys) {
      for (let i = 0; i < k.length; i++) h.u32(k.charCodeAt(i));
      hashValue(h, o[k]);
    }
  }
}
