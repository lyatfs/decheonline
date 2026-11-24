import type { Command } from './commands';
import { CIV_RANDOM, DEFAULT_GAME_SETTINGS, lobbyWorldOptions, PATH_FINDING_HIGH, type GameSettings } from './game-settings';
import { MAP_HILLY, MAP_MEDIUM } from './rmm-controller';
import { TileMap } from './map';
import { CrtRand } from './rng';
import { TOOL_AGE } from './techs';
import { BARRACKS, BOWMAN, CLUBMAN, HOUSE, MARKET, SMALL_WALL, TOWN_CENTER, VILLAGER } from './units';
import { VICTORY_TIME_LIMIT, type VictorySettings } from './victory';
import { AGE_BRONZE, AGE_IRON, startingObjects, World, type RandomMapOptions, type SpeedChange, type StartUnit, type WorldOptions } from './world';

export * from './replay4';

/** Everything needed to rerun a game: start state plus every batch, keyed by the turn it was issued on. */
export interface ReplayLog {
  players: number;
  randomSeed: number;
  /** Objects placed before the first step. */
  units?: StartUnit[];
  /** A hand-made map (`TileMap` terrain, row by row); default the fixed test map. */
  terrain?: { width: number; height: number; tiles: number[] };
  /** A random map game: the map and the start objects come from the seed (`units` is not used). */
  randomMap?: RandomMapOptions;
  /** Each player's civ, Gaia's included; default Egyptian. */
  civs?: number[];
  /** The lobby's victory setting; default Standard. */
  victory?: VictorySettings;
  /** The lobby's population limit; default 50. */
  populationLimit?: number;
  /** The lobby's start settings (`WorldOptions`); default off. */
  start?: Pick<WorldOptions, 'startingAge' | 'resourceLevel' | 'deathMatch' | 'fullTechTree' | 'revealMap' | 'pathingIterations' | 'fixedPositions' | 'cheating'>;
  turns: number;
  batches: { turn: number; player: number; commands: Command[] }[];
  /** Step size and buffer frame changes, each given to the world on the turn it was agreed for (turn-timing.md §8.7). */
  speeds?: SpeedChange[];
}

/** The world a log starts from. */
export function replayWorld(log: ReplayLog): World {
  return new World({
    players: log.players,
    randomSeed: log.randomSeed,
    units: log.units,
    ...(log.terrain ? { map: new TileMap(log.terrain.width, log.terrain.height, log.terrain.tiles) } : {}),
    ...(log.randomMap ? { randomMap: log.randomMap } : {}),
    ...(log.civs ? { civs: log.civs } : {}),
    ...(log.victory ? { victory: log.victory } : {}),
    ...(log.populationLimit !== undefined ? { populationLimit: log.populationLimit } : {}),
    ...log.start,
  });
}

/** Run a log from the start; returns the state hash after every turn. */
export function runReplay(log: ReplayLog, world = replayWorld(log)): number[] {
  const hashes: number[] = [];
  while (world.turn < log.turns) {
    for (const b of log.batches) if (b.turn === world.turn) world.addBatch(b.turn, b.player, b.commands);
    for (const c of log.speeds ?? []) if (c.turn === world.turn) world.setSpeedChange(c);
    world.runTurn();
    hashes.push(world.hash());
  }
  return hashes;
}

/**
 * `(G, F)` changes the sample replays, as the host would agree them (turn-timing.md §5, §7): from the defaults down
 * to small steps and back up, so every engine also runs 20, 30 and 150 ms steps.
 */
const SAMPLE_SPEEDS: readonly SpeedChange[] = [
  { turn: 24, granularity: 30, frames: 9 },
  { turn: 30, granularity: 20, frames: 13 },
  { turn: 36, granularity: 150, frames: 8 },
  { turn: 60, granularity: 90, frames: 10 },
];

/** Two Clubmen and a Bowman per player, facing each other across the middle of the test map, after the starting objects. */
const SKIRMISH: readonly StartUnit[] = [
  { owner: 1, type: CLUBMAN, x: 18.5, y: 18.5 },
  { owner: 1, type: CLUBMAN, x: 19.5, y: 18.5 },
  { owner: 1, type: BOWMAN, x: 18.5, y: 17.5 },
  { owner: 2, type: CLUBMAN, x: 21.5, y: 20.5 },
  { owner: 2, type: CLUBMAN, x: 22.5, y: 20.5 },
  { owner: 2, type: BOWMAN, x: 22.5, y: 21.5 },
];

/**
 * A fixed log for determinism tests: Gaia plus two players with the test map's starting objects (`startingObjects`)
 * (with `war`, also a skirmish of two Clubmen and a Bowman each in the middle of the map, close enough to find each other),
 * each issuing 0-3 `test` commands per turn at coordinates that are not exact float32 values, so every step exercises
 * float32 rounding. Now and then, spaced so gatherers fill up and drop off, builders finish and units train between
 * orders: a `move` of some of their Villagers (and sometimes one of the other side's, which is ignored) to a random
 * point of the map, water included; a `work` order, mostly on a resource near their base, else on a random starting
 * object (resources, either Town Center, the other side's units) or a missing one; a `build` of a House or Barracks near their Town Center (some spots are taken);
 * a `queue` of Villagers (or a Clubman, or an unqueue) at their Town Center or now and then the other's; with `war`, an `attack` by
 * some of their Villagers and of the units made during the game on one of the other side's Villagers, mostly, else its
 * Town Center or a unit made during the game (drawn from a second generator, so the other orders stay as they were);
 * rarely a `cancel` of an object made during the game; and, from a third generator, now and then a `research` at their
 * Town Center (sometimes the other's or an object made during the game) of a building's 2-second tech (Granary,
 * Storage Pit or Barracks built: two make the Tool Age available), the Tool Age or any tech id, and rarely a `stop` of
 * their Town Center. The step size and buffer frames change on the way (`SAMPLE_SPEEDS`). With `war`, 20 turns before
 * the end player 2 deletes every object it may own (a `cancel` of every id the game can have reached): it is defeated
 * at its next per-second check and player 1 wins (docs/spec/victory.md §6).
 */
export function sampleReplay(turns = 120, seed = 20260101, war = true): ReplayLog {
  const players = 3;
  const units = war ? [...startingObjects(players), ...SKIRMISH] : startingObjects(players);
  // Starting objects get ids 1.. in `units` order.
  const start: ReplayStart = {
    count: units.length,
    villagers: units.flatMap((u, i) => (u.type === VILLAGER ? [{ id: i + 1, owner: u.owner }] : [])),
    centers: units.flatMap((u, i) => (u.type === TOWN_CENTER ? [{ id: i + 1, owner: u.owner, x: u.x, y: u.y }] : [])),
    resources: units.flatMap((u, i) => (u.owner === 0 ? [{ id: i + 1, x: u.x, y: u.y }] : [])),
    at: (id) => units[id - 1],
  };
  return { players, randomSeed: 4242, units, turns, batches: sampleBatches(start, turns, seed, war), speeds: sampleSpeeds(turns) };
}

/**
 * The same kind of log on a random map game (Large, Mostly Land, the multiplayer default) without the skirmish: the
 * orders aim at the start objects the seed placed (each side's Villagers and Town Center, the resources near it).
 */
export function sampleRandomMapReplay(turns = 60, seed = 20261115, lobby?: { randomSeed: number; settings: GameSettings; civs: number[] }): ReplayLog {
  const players = 3;
  const randomSeed = lobby?.randomSeed ?? 4243;
  const options = lobby ? lobbyWorldOptions(randomSeed, lobby.settings, lobby.civs) : { players, randomSeed, randomMap: {} };
  const randomMap: RandomMapOptions = options.randomMap ?? {};
  const world = new World(options);
  const objects = [...world.entities.all()];
  const start: ReplayStart = {
    count: Math.max(...objects.map((e) => e.id)),
    villagers: objects.flatMap((e) => (e.type === VILLAGER ? [{ id: e.id, owner: e.owner }] : [])),
    centers: objects.flatMap((e) => (e.type === TOWN_CENTER ? [{ id: e.id, owner: e.owner, x: e.x, y: e.y }] : [])),
    resources: objects.flatMap((e) => (e.owner === 0 && e.heldAmount > 0 ? [{ id: e.id, x: e.x, y: e.y }] : [])),
    at: (id) => world.entities.get(id),
  };
  const { startingAge, resourceLevel, deathMatch, fullTechTree, revealMap, pathingIterations, fixedPositions, cheating } = options;
  const lobbyStart = { startingAge, resourceLevel, deathMatch, fullTechTree, revealMap, pathingIterations, fixedPositions, cheating };
  const settings = lobby
    ? { civs: [...world.civs], victory: options.victory!, populationLimit: options.populationLimit!, start: lobbyStart }
    : {};
  return { players, randomSeed, randomMap, ...settings, turns, batches: sampleBatches(start, turns, seed, false), speeds: sampleSpeeds(turns) };
}

/**
 * The same on a game with lobby settings other than the defaults (docs/spec/lobby.md): a Death Match on Medium Hill
 * Country, a 3,000-year time limit, the Bronze Age, Reveal Map, Full Tech Tree, a population limit of 25, a Random civ
 * (resolved from the seed) against Shang, High Path Finding, random positions and Enable Cheating, with cheat codes
 * (chat.md §7), STEROIDS and a formation (commands.md §6) among the orders.
 */
export function sampleLobbyReplay(turns = 60, seed = 20261116): ReplayLog {
  const settings: GameSettings = {
    ...DEFAULT_GAME_SETTINGS,
    deathMatch: true,
    mapType: MAP_HILLY,
    mapSize: MAP_MEDIUM,
    victory: { type: VICTORY_TIME_LIMIT, amount: 3000 },
    startingAge: AGE_BRONZE,
    revealMap: true,
    fullTechTree: true,
    populationLimit: 25,
    pathFinding: PATH_FINDING_HIGH,
    fixedPositions: false,
    cheating: true,
  };
  const log = sampleRandomMapReplay(turns, seed, { randomSeed: 4244, settings, civs: [CIV_RANDOM, 10] });
  const units = log.batches.flatMap((b) => b.commands).find((c) => c.type === 'move' && c.units.length > 1);
  const extra: { turn: number; player: number; commands: Command[] }[] = [
    { turn: 3, player: 1, commands: [{ type: 'cheat', code: 21 }, { type: 'cheat', code: 0 }] },
    { turn: 6, player: 2, commands: [{ type: 'quick-build', on: true }, { type: 'cheat', code: 12 }] },
    { turn: 9, player: 2, commands: [{ type: 'cheat', code: 220 }, { type: 'cheat', code: 230 }] },
    { turn: 12, player: 1, commands: units?.type === 'move' ? [{ type: 'formation', units: units.units, formation: 4 }] : [] },
    { turn: 20, player: 1, commands: [{ type: 'quick-build', on: false }, { type: 'cheat', code: 8 }] },
    { turn: 24, player: 2, commands: [{ type: 'game-speed', speed: 1.5 }] },
    { turn: 36, player: 1, commands: [{ type: 'game-speed', speed: 2 }] },
  ];
  const batches = [...log.batches];
  for (const { turn, player, commands } of extra) {
    const batch = batches.find((b) => b.turn === turn && b.player === player);
    if (batch) batch.commands = [...batch.commands, ...commands];
    else batches.push({ turn, player, commands });
  }
  return { ...log, batches };
}

/**
 * `sampleReplay`'s game (with the skirmish) plus a built Market left of each Town Center, and from a fourth generator, so
 * the other orders stay as they were, diplomacy (docs/spec/diplomacy.md): now and then a stance towards the other side
 * (ally, neutral or enemy; rarely towards itself or Gaia, which is ignored), an allied-victory flag, and a tribute of
 * 50-500 of a random resource, sometimes more than the sender has.
 */
export function sampleDiplomacyReplay(turns = 120, seed = 20261117): ReplayLog {
  const log = sampleReplay(turns, seed);
  const markets: StartUnit[] = log.units!.filter((u) => u.type === TOWN_CENTER).map((tc) => ({ owner: tc.owner, type: MARKET, x: tc.x - 4, y: tc.y }));
  const talk = new CrtRand();
  talk.srand(seed + 15485863);
  const batches = [...log.batches];
  for (let turn = 0; turn < turns; turn++) {
    for (const player of [2, 1]) {
      const commands: Command[] = [];
      const other = 3 - player;
      if (talk.rand() % 10 === 0) {
        const roll = talk.rand() % 16;
        commands.push({ type: 'relation', player: roll === 0 ? player : roll === 1 ? 0 : other, relation: [0, 1, 3][talk.rand() % 3]! });
      }
      if (talk.rand() % 30 === 0) commands.push({ type: 'allied-victory', on: talk.rand() % 2 === 0 });
      if (talk.rand() % 8 === 0) commands.push({ type: 'tribute', player: other, resource: talk.rand() % 4, amount: 50 + (talk.rand() % 451) });
      if (commands.length === 0) continue;
      const batch = batches.find((b) => b.turn === turn && b.player === player);
      if (batch) batch.commands = [...batch.commands, ...commands];
      else batches.push({ turn, player, commands });
    }
  }
  // Markets come after the other start objects, so those keep their ids.
  return { ...log, units: [...log.units!, ...markets], batches };
}

/** Each side's siege and splash units for `sampleSiegeReplay`, west and east of the test map's middle. */
const SIEGE: readonly StartUnit[] = [
  { owner: 1, type: 35, x: 14.5, y: 18.5 },
  { owner: 1, type: 280, x: 14.5, y: 20.5 },
  { owner: 1, type: 11, x: 14.5, y: 22.5 },
  { owner: 1, type: 46, x: 17.5, y: 19.5 },
  { owner: 1, type: 339, x: 17.5, y: 21.5 },
  { owner: 2, type: 36, x: 26.5, y: 18.5 },
  { owner: 2, type: 279, x: 26.5, y: 20.5 },
  { owner: 2, type: 345, x: 23.5, y: 19.5 },
  { owner: 2, type: 93, x: 23.5, y: 21.5 },
  { owner: 2, type: 93, x: 24.5, y: 21.5 },
];

/**
 * `sampleReplay`'s game (with the skirmish) plus each side's siege and splash units (`SIEGE`) and, from a fifth
 * generator, now and then an `attack-ground` by some of them at a point around the middle of the map (sometimes one of
 * the other side's units, which is ignored): stones, bolts, blasts and melee splash in every engine.
 */
export function sampleSiegeReplay(turns = 120, seed = 20261118): ReplayLog {
  const log = sampleReplay(turns, seed);
  const first = log.units!.length + 1;
  const ids = SIEGE.map((u, i) => ({ id: first + i, owner: u.owner }));
  const fire = new CrtRand();
  fire.srand(seed + 32452843);
  const batches = [...log.batches];
  for (let turn = 0; turn < turns; turn++) {
    for (const player of [1, 2]) {
      if (fire.rand() % 6 !== 0) continue;
      const units = ids.filter((u) => fire.rand() % 2 === 0 && (u.owner === player || fire.rand() % 8 === 0)).map((u) => u.id);
      if (units.length === 0) continue;
      const commands: Command[] = [{ type: 'attack-ground', units, x: 16 + (fire.rand() % 1000) / 100, y: 16 + (fire.rand() % 800) / 100 }];
      const batch = batches.find((b) => b.turn === turn && b.player === player);
      if (batch) batch.commands = [...batch.commands, ...commands];
      else batches.push({ turn, player, commands });
    }
  }
  // The siege units come after the other start objects, so those keep their ids.
  return { ...log, units: [...log.units!, ...SIEGE], batches };
}

/** Each side's Priests for `samplePriestReplay`, behind its skirmish units. */
const PRIESTS: readonly StartUnit[] = [
  { owner: 1, type: 125, x: 16.5, y: 17.5 },
  { owner: 1, type: 125, x: 16.5, y: 19.5 },
  { owner: 2, type: 125, x: 24.5, y: 20.5 },
  { owner: 2, type: 125, x: 24.5, y: 22.5 },
];

/**
 * `sampleReplay`'s game (with the skirmish) in the Iron Age, Babylonian against Egyptian, plus two Priests a side
 * (`PRIESTS`) and, from a sixth generator, now and then a `work` order by some of a side's Priests on a skirmish unit,
 * one of a few Villagers or a Priest of either side (a convert on the other side's, a heal or a walk on its own; sometimes the
 * other side's Priests, which is ignored): faith, rolls, flares, ownership changes and heals in every engine.
 */
export function samplePriestReplay(turns = 120, seed = 20261116): ReplayLog {
  const log = sampleReplay(turns, seed);
  const first = log.units!.length + 1;
  const priests = PRIESTS.map((u, i) => ({ id: first + i, owner: u.owner }));
  const targets = log.units!.flatMap((u, i) => (i + 1 > log.units!.length - SKIRMISH.length || (u.type === VILLAGER && i % 3 === 0) ? [i + 1] : []));
  targets.push(...priests.map((p) => p.id));
  const pray = new CrtRand();
  pray.srand(seed + 49979687);
  const batches = [...log.batches];
  for (let turn = 0; turn < turns; turn++) {
    for (const player of [1, 2]) {
      if (pray.rand() % 3 !== 0) continue;
      const units = priests.filter((p) => pray.rand() % 2 === 0 && (p.owner === player || pray.rand() % 8 === 0)).map((p) => p.id);
      if (units.length === 0) continue;
      const target = targets[pray.rand() % targets.length]!;
      const at = log.units![target - 1] ?? PRIESTS[target - first]!;
      const commands: Command[] = [{ type: 'work', units, target, x: at.x, y: at.y }];
      const batch = batches.find((b) => b.turn === turn && b.player === player);
      if (batch) batch.commands = [...batch.commands, ...commands];
      else batches.push({ turn, player, commands });
    }
  }
  // The priests come after the other start objects, so those keep their ids.
  return { ...log, units: [...log.units!, ...PRIESTS], batches, civs: [0, 3, 1], start: { startingAge: AGE_IRON } };
}

/**
 * The naval sample's 40×40 map: columns 0-14 grass (player 1's land), 15 beach, 16-27 water (21-22 deep water), 28 beach,
 * 29-39 grass (player 2's island). Land units of one side cannot reach the other's land.
 */
export function navalTerrain(): { width: number; height: number; tiles: number[] } {
  const tiles: number[] = [];
  for (let y = 0; y < 40; y++) {
    for (let x = 0; x < 40; x++) tiles.push(x === 15 || x === 28 ? 2 : x >= 16 && x <= 27 ? (x === 21 || x === 22 ? 22 : 1) : 0);
  }
  return { width: 40, height: 40, tiles };
}

/**
 * Each side's Dock, Villagers and Fishing Boats at its end of the sea, its war ships facing the other's in the middle,
 * then Gaia's fish (two off each side's Dock), for `sampleNavalReplay`.
 */
const NAVAL: readonly StartUnit[] = [
  { owner: 1, type: 45, x: 16.5, y: 10.5 },
  { owner: 1, type: VILLAGER, x: 12.5, y: 9.5 },
  { owner: 1, type: VILLAGER, x: 12.5, y: 12.5 },
  { owner: 1, type: 13, x: 18.5, y: 8.5 },
  { owner: 1, type: 13, x: 18.5, y: 12.5 },
  { owner: 1, type: 19, x: 17.5, y: 19.5 },
  { owner: 1, type: 250, x: 17.5, y: 21.5 },
  { owner: 1, type: 360, x: 18.5, y: 20.5 },
  { owner: 2, type: 45, x: 27.5, y: 30.5 },
  { owner: 2, type: VILLAGER, x: 31.5, y: 29.5 },
  { owner: 2, type: VILLAGER, x: 31.5, y: 32.5 },
  { owner: 2, type: 13, x: 25.5, y: 28.5 },
  { owner: 2, type: 13, x: 25.5, y: 32.5 },
  { owner: 2, type: 19, x: 26.5, y: 20.5 },
  { owner: 2, type: 250, x: 26.5, y: 18.5 },
  { owner: 2, type: 360, x: 25.5, y: 19.5 },
  { owner: 0, type: 53, x: 19.5, y: 4.5 },
  { owner: 0, type: 53, x: 18.5, y: 13.5 },
  { owner: 0, type: 53, x: 25.5, y: 27.5 },
  { owner: 0, type: 53, x: 24.5, y: 36.5 },
];

/** The boats a Dock order queues and the Dock techs it researches in `sampleNavalReplay`. */
const NAVAL_QUEUE = [13, 19, 250, 360];
const NAVAL_TECHS = [4, 5, 7, 9, 25];

/**
 * A sea game on `navalTerrain` in the Iron Age with Death Match stockpiles, Minoan against Phoenician (both have ship
 * bonuses): each side's Dock, two Villagers, two Fishing Boats, and a Scout Ship (a War Galley), a Catapult Trireme and a
 * Fire Galley facing the other side's mid-sea (`NAVAL`). Now and then, from one generator, a side orders: its
 * Fishing Boats onto a fish, mostly one off its own Dock; its war ships to attack one of the other side's war ships or to move to a point of the sea; its Villagers onto one
 * of its own boats (a repair when it is damaged); a boat queued at its Dock or a Dock tech; and sometimes the other
 * side's objects, which is ignored. Fishing, drop-offs, missiles, blasts, ship reactions and boat repair in every engine.
 */
export function sampleNavalReplay(turns = 160, seed = 20261119): ReplayLog {
  const ids = (owner: number, types: number[]) => NAVAL.flatMap((u, i) => (u.owner === owner && types.includes(u.type) ? [i + 1] : []));
  const fish = ids(0, [53]);
  const sea = new CrtRand();
  sea.srand(seed);
  const batches: ReplayLog['batches'] = [];
  for (let turn = 0; turn < turns; turn++) {
    for (const player of [1, 2]) {
      if (sea.rand() % 4 !== 0) continue;
      const side = sea.rand() % 8 === 0 ? 3 - player : player;
      const enemy = 3 - side;
      const commands: Command[] = [];
      switch (sea.rand() % 7) {
        case 0:
        case 1: {
          // Mostly one of the two fish off its own Dock.
          const target = sea.rand() % 4 === 0 ? fish[sea.rand() % fish.length]! : fish[2 * (side - 1) + (sea.rand() % 2)]!;
          const at = NAVAL[target - 1]!;
          commands.push({ type: 'work', units: ids(side, [13]), target, x: at.x, y: at.y });
          break;
        }
        case 2: {
          const boats = ids(enemy, [19, 250, 360]);
          commands.push({ type: 'attack', units: ids(side, [19, 250, 360]), target: boats[sea.rand() % boats.length]! });
          break;
        }
        case 3:
          commands.push({ type: 'move', units: ids(side, [19, 250, 360]), x: 17 + (sea.rand() % 1000) / 100, y: 2 + (sea.rand() % 3600) / 100 });
          break;
        case 4: {
          const boats = ids(side, [13, 19, 250, 360]);
          const target = boats[sea.rand() % boats.length]!;
          const at = NAVAL[target - 1]!;
          commands.push({ type: 'work', units: ids(side, [VILLAGER]), target, x: at.x, y: at.y });
          break;
        }
        default: {
          const dock = ids(side, [45])[0]!;
          if (sea.rand() % 2 === 0) commands.push({ type: 'queue', building: dock, unit: NAVAL_QUEUE[sea.rand() % NAVAL_QUEUE.length]!, count: 1 });
          else commands.push({ type: 'research', building: dock, tech: NAVAL_TECHS[sea.rand() % NAVAL_TECHS.length]! });
        }
      }
      batches.push({ turn, player, commands });
    }
  }
  return {
    players: 3,
    randomSeed: 4343,
    terrain: navalTerrain(),
    units: [...NAVAL],
    civs: [0, 7, 9],
    turns,
    batches,
    speeds: sampleSpeeds(turns),
    start: { startingAge: AGE_IRON, deathMatch: true },
  };
}

/** `navalTerrain` with shallows (4) in column 16 on rows 0-9, beside the west beach: an unload there drops onto them. */
export function transportTerrain(): { width: number; height: number; tiles: number[] } {
  const t = navalTerrain();
  for (let y = 0; y < 10; y++) t.tiles[y * t.width + 16] = 4;
  return t;
}

/** Each side's Town Center, Dock, four Villagers on its beach, two Transport Boats off it and a Scout Ship, for `sampleTransportReplay`. */
const TRANSPORT: readonly StartUnit[] = [
  { owner: 1, type: TOWN_CENTER, x: 6.5, y: 20.5 },
  { owner: 1, type: 45, x: 16.5, y: 30.5 },
  { owner: 1, type: VILLAGER, x: 13.5, y: 14.5 },
  { owner: 1, type: VILLAGER, x: 13.5, y: 16.5 },
  { owner: 1, type: VILLAGER, x: 13.5, y: 18.5 },
  { owner: 1, type: VILLAGER, x: 13.5, y: 20.5 },
  { owner: 1, type: 17, x: 18.5, y: 12.5 },
  { owner: 1, type: 17, x: 18.5, y: 20.5 },
  { owner: 1, type: 19, x: 20.5, y: 26.5 },
  { owner: 2, type: TOWN_CENTER, x: 34.5, y: 20.5 },
  { owner: 2, type: 45, x: 27.5, y: 10.5 },
  { owner: 2, type: VILLAGER, x: 30.5, y: 20.5 },
  { owner: 2, type: VILLAGER, x: 30.5, y: 22.5 },
  { owner: 2, type: VILLAGER, x: 30.5, y: 24.5 },
  { owner: 2, type: VILLAGER, x: 30.5, y: 26.5 },
  { owner: 2, type: 17, x: 25.5, y: 22.5 },
  { owner: 2, type: 17, x: 25.5, y: 30.5 },
  { owner: 2, type: 19, x: 23.5, y: 14.5 },
];

/**
 * A transport game on `transportTerrain` in the Iron Age with Death Match stockpiles, Egyptian against Greek (`TRANSPORT`).
 * Now and then, from one generator, a side orders: its Villagers onto one of its transports (they board, five at most);
 * a transport across the sea, or a right click on a beach point of either shore (a drop when within 2 tiles, else a
 * move); an unload at a point of the far shore or at the boat itself (beside the west shallows or not); its Scout Ship at
 * the other side's transports (cargo dies with its ship); a Transport Boat queued or Heavy Transport (8) researched at its
 * Dock; and sometimes the other side's objects, which is ignored. Boarding, drops, unloads and sinking in every engine.
 */
export function sampleTransportReplay(turns = 200, seed = 20261116): ReplayLog {
  const ids = (owner: number, types: number[]) => TRANSPORT.flatMap((u, i) => (u.owner === owner && types.includes(u.type) ? [i + 1] : []));
  const gen = new CrtRand();
  gen.srand(seed);
  const shore = (side: number) => (side === 1 ? 15.5 : 28.5);
  const batches: ReplayLog['batches'] = [];
  for (let turn = 0; turn < turns; turn++) {
    for (const player of [1, 2]) {
      if (gen.rand() % 4 !== 0) continue;
      const side = gen.rand() % 8 === 0 ? 3 - player : player;
      const enemy = 3 - side;
      const boats = ids(side, [17]);
      const boat = boats[gen.rand() % boats.length]!;
      const commands: Command[] = [];
      switch (gen.rand() % 8) {
        case 0:
        case 1: {
          const at = TRANSPORT[boat - 1]!;
          commands.push({ type: 'work', units: ids(side, [VILLAGER]), target: boat, x: at.x, y: at.y });
          break;
        }
        case 2:
          commands.push({ type: 'move', units: [boat], x: 17 + (gen.rand() % 1000) / 100, y: 2 + (gen.rand() % 3600) / 100 });
          break;
        case 3:
          commands.push({ type: 'work', units: [boat], target: 0, x: shore(gen.rand() % 2 === 0 ? enemy : side), y: 2.5 + (gen.rand() % 35) });
          break;
        case 4:
          if (gen.rand() % 2 === 0) commands.push({ type: 'unload', units: boats, x: shore(enemy) + (enemy === 1 ? -2 : 2), y: 2.5 + (gen.rand() % 35) });
          else commands.push({ type: 'unload', units: [boat], x: 17.5, y: 2.5 + (gen.rand() % 8) });
          break;
        case 5: {
          const targets = ids(enemy, [17]);
          commands.push({ type: 'attack', units: ids(side, [19]), target: targets[gen.rand() % targets.length]! });
          break;
        }
        default: {
          const dock = ids(side, [45])[0]!;
          if (gen.rand() % 3 === 0) commands.push({ type: 'research', building: dock, tech: 8 });
          else commands.push({ type: 'queue', building: dock, unit: 17, count: 1 });
        }
      }
      batches.push({ turn, player, commands });
    }
  }
  return {
    players: 3,
    randomSeed: 5151,
    terrain: transportTerrain(),
    units: [...TRANSPORT],
    civs: [0, 1, 2],
    turns,
    batches,
    speeds: sampleSpeeds(turns),
    start: { startingAge: AGE_IRON, deathMatch: true },
  };
}

/** `navalTerrain`'s columns on a 64 × 64 map, for `sampleTradeReplay`: Docks at either end trade above the minimum. */
export function tradeTerrain(): { width: number; height: number; tiles: number[] } {
  const tiles: number[] = [];
  for (let y = 0; y < 64; y++) {
    for (let x = 0; x < 64; x++) tiles.push(x === 15 || x === 28 ? 2 : x >= 16 && x <= 27 ? (x === 21 || x === 22 ? 22 : 1) : 0);
  }
  return { width: 64, height: 64, tiles };
}

/** Each side's Town Center and Dock at its end of `tradeTerrain`, two Trade Boats off it and a Scout Ship, for `sampleTradeReplay`. */
const TRADE: readonly StartUnit[] = [
  { owner: 1, type: TOWN_CENTER, x: 6.5, y: 6.5 },
  { owner: 1, type: 45, x: 16.5, y: 4.5 },
  { owner: 1, type: 15, x: 18.5, y: 7.5 },
  { owner: 1, type: 15, x: 19.5, y: 10.5 },
  { owner: 1, type: 19, x: 20.5, y: 30.5 },
  { owner: 2, type: TOWN_CENTER, x: 34.5, y: 58.5 },
  { owner: 2, type: 45, x: 27.5, y: 58.5 },
  { owner: 2, type: 15, x: 25.5, y: 55.5 },
  { owner: 2, type: 15, x: 24.5, y: 52.5 },
  { owner: 2, type: 19, x: 23.5, y: 34.5 },
];

/**
 * A trade game on `tradeTerrain` in the Bronze Age with Death Match stockpiles, Egyptian against Palmyran (twice the gold;
 * `TRADE`). Now and then, from one generator, a side orders: its Trade Boats at the other side's Dock (now and then its
 * own); a cargo for them (food, wood or stone); a boat to a point of the sea; its Scout Ship at the other side's boats; a
 * Trade Boat queued or Merchant Ship (6) researched at its Dock; and sometimes the other side's objects, which is
 * ignored. Loading against regrowing trade goods, the gold by distance, the trade ship's reactions in every engine.
 */
export function sampleTradeReplay(turns = 300, seed = 20261120): ReplayLog {
  const ids = (owner: number, types: number[]) => TRADE.flatMap((u, i) => (u.owner === owner && types.includes(u.type) ? [i + 1] : []));
  const gen = new CrtRand();
  gen.srand(seed);
  const batches: ReplayLog['batches'] = [];
  for (let turn = 0; turn < turns; turn++) {
    for (const player of [1, 2]) {
      if (gen.rand() % 4 !== 0) continue;
      const side = gen.rand() % 8 === 0 ? 3 - player : player;
      const enemy = 3 - side;
      const boats = ids(side, [15]);
      const boat = boats[gen.rand() % boats.length]!;
      const commands: Command[] = [];
      switch (gen.rand() % 8) {
        case 0:
        case 1:
        case 2: {
          const dock = ids(gen.rand() % 6 === 0 ? side : enemy, [45])[0]!;
          const at = TRADE[dock - 1]!;
          commands.push({ type: 'work', units: gen.rand() % 2 === 0 ? boats : [boat], target: dock, x: at.x, y: at.y });
          break;
        }
        case 3:
          commands.push({ type: 'trade-attribute', units: boats, attribute: gen.rand() % 3 });
          break;
        case 4:
          commands.push({ type: 'move', units: [boat], x: 17 + (gen.rand() % 1000) / 100, y: 2 + (gen.rand() % 6000) / 100 });
          break;
        case 5: {
          const targets = ids(enemy, [15]);
          commands.push({ type: 'attack', units: ids(side, [19]), target: targets[gen.rand() % targets.length]! });
          break;
        }
        default: {
          const dock = ids(side, [45])[0]!;
          if (gen.rand() % 3 === 0) commands.push({ type: 'research', building: dock, tech: 6 });
          else commands.push({ type: 'queue', building: dock, unit: 15, count: 1 });
        }
      }
      batches.push({ turn, player, commands });
    }
  }
  return {
    players: 3,
    randomSeed: 6262,
    terrain: tradeTerrain(),
    units: [...TRADE],
    civs: [0, 1, 15],
    turns,
    batches,
    speeds: sampleSpeeds(turns),
    start: { startingAge: AGE_BRONZE, deathMatch: true },
  };
}

/** What the sample orders aim at: the start objects, by id; ids past `count` are what the game made. */
interface ReplayStart {
  count: number;
  villagers: { id: number; owner: number }[];
  centers: { id: number; owner: number; x: number; y: number }[];
  resources: { id: number; x: number; y: number }[];
  at(id: number): { x: number; y: number } | undefined;
}

function sampleSpeeds(turns: number): SpeedChange[] {
  return SAMPLE_SPEEDS.filter((c) => c.turn < turns).map((c) => ({ ...c }));
}

function sampleBatches({ count, villagers, centers, resources, at: startAt }: ReplayStart, turns: number, seed: number, war: boolean): ReplayLog['batches'] {
  const gen = new CrtRand();
  gen.srand(seed);
  const fight = new CrtRand();
  fight.srand(seed + 7919);
  const study = new CrtRand();
  study.srand(seed + 104729);
  // Wall lines (with the skirmish only) draw from their own generator, so the other orders stay as they were. Without the
  // skirmish the fuzz checks drop-offs, and builders take every foundation near them (economy.md §4.8.3).
  const mason = new CrtRand();
  mason.srand(seed + 15485863);
  const pick = (player: number) => villagers.flatMap((v) => ((v.owner === player || gen.rand() % 8 === 0) && gen.rand() % 3 !== 0 ? [v.id] : []));
  const fraction = () => gen.rand() / 32768;
  const batches: ReplayLog['batches'] = [];
  for (let turn = 0; turn < turns; turn++) {
    for (const player of [2, 1]) {
      const commands: Command[] = [];
      const n = gen.rand() % 4;
      for (let i = 0; i < n; i++) commands.push({ type: 'test', x: gen.rand() / 327.67, y: gen.rand() / 91.3 });
      if (n === 0 && gen.rand() % 2 === 0) commands.push({ type: 'noop' });
      const own = centers.find((c) => c.owner === player)!;
      if (gen.rand() % 64 === 0) {
        const ids = pick(player);
        if (ids.length > 0) commands.push({ type: 'move', units: ids, x: gen.rand() / 682.66, y: gen.rand() / 682.66 });
      }
      if (gen.rand() % 32 === 0) {
        const ids = pick(player);
        const near = resources.filter((r) => Math.abs(r.x - own.x) < 12 && Math.abs(r.y - own.y) < 12);
        const target = gen.rand() % 4 !== 0 ? near[gen.rand() % near.length]!.id : (gen.rand() % (count + 4)) + 1;
        const at = startAt(target) ?? { x: gen.rand() / 682.66, y: gen.rand() / 682.66 };
        if (ids.length > 0) commands.push({ type: 'work', units: ids, target, x: at.x, y: at.y });
      }
      if (gen.rand() % 48 === 0) {
        const ids = pick(player);
        const unitType = gen.rand() % 3 === 0 ? BARRACKS : HOUSE;
        const x = own.x + (gen.rand() % 11) - 5 + fraction();
        const y = own.y + (gen.rand() % 11) - 5 + fraction();
        commands.push({ type: 'build', units: ids, unitType, x, y });
      }
      if (war && mason.rand() % 40 === 0) {
        const ids = villagers.filter((v) => v.owner === player && mason.rand() % 2 === 0).map((v) => v.id);
        const tile = (v: number) => Math.min(255, Math.max(0, Math.trunc(v)));
        const x1 = tile(own.x + (mason.rand() % 13) - 6);
        const y1 = tile(own.y + (mason.rand() % 13) - 6);
        const x2 = tile(x1 + (mason.rand() % 11) - 5);
        const y2 = tile(y1 + (mason.rand() % 11) - 5);
        commands.push({ type: 'build-wall', units: ids, unitType: SMALL_WALL, x1, y1, x2, y2 });
      }
      if (gen.rand() % 16 === 0) {
        const building = gen.rand() % 8 === 0 ? centers.find((c) => c.owner !== player)!.id : own.id;
        const unit = gen.rand() % 6 === 0 ? CLUBMAN : VILLAGER;
        const count = gen.rand() % 5 === 0 ? -1 : 1 + (gen.rand() % 3);
        commands.push({ type: 'queue', building, unit, count });
      }
      if (war && fight.rand() % 24 === 0) {
        const made = Array.from({ length: 1 + (fight.rand() % 6) }, () => count + 1 + (fight.rand() % 40));
        const ids = [...new Set([...villagers.filter((v) => v.owner === player && fight.rand() % 3 === 0).map((v) => v.id), ...made])];
        const enemies = villagers.filter((v) => v.owner !== player);
        const roll = fight.rand() % 8;
        const target =
          roll < 5 ? enemies[fight.rand() % enemies.length]!.id : roll < 6 ? centers.find((c) => c.owner !== player)!.id : count + 1 + (fight.rand() % 40);
        commands.push({ type: 'attack', units: ids, target });
      }
      if (gen.rand() % 60 === 0) commands.push({ type: 'cancel', target: count + 1 + (gen.rand() % 40) });
      if (study.rand() % 20 === 0) {
        const roll = study.rand() % 8;
        const building = roll < 6 ? own.id : roll < 7 ? centers.find((c) => c.owner !== player)!.id : count + 1 + (study.rand() % 40);
        const techs = [10, 39, 62, TOOL_AGE, TOOL_AGE, study.rand() % 130];
        commands.push({ type: 'research', building, tech: techs[study.rand() % techs.length]! });
      }
      if (study.rand() % 150 === 0) commands.push({ type: 'stop', objects: [own.id] });
      // Ids so far: the start objects, at most 3 probes per player per turn, and what the game made (well under 2 a turn).
      if (war && player === 2 && turn === turns - 20) {
        for (let id = 1; id <= count + 8 * turn; id++) commands.push({ type: 'cancel', target: id });
      }
      if (commands.length > 0) batches.push({ turn, player, commands });
    }
  }
  return batches;
}
