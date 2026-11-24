import type { Command } from './commands';
import { CIV_RANDOM, DEFAULT_GAME_SETTINGS, lobbyWorldOptions, type GameSettings } from './game-settings';
import type { ReplayLog } from './replay';
import { CrtRand } from './rng';
import { TOOL_AGE } from './techs';
import { BARRACKS, BOWMAN, CLUBMAN, HOUSE, MARKET, SMALL_WALL, TOWN_CENTER, VILLAGER } from './units';
import { startingObjects, World, type RandomMapOptions, type SpeedChange, type StartUnit } from './world';

const SAMPLE_SPEEDS_4: readonly SpeedChange[] = [
  { turn: 24, granularity: 30, frames: 9 },
  { turn: 30, granularity: 20, frames: 13 },
  { turn: 36, granularity: 150, frames: 8 },
  { turn: 60, granularity: 90, frames: 10 },
];

/** Four-way skirmish in the central grass corridor of the 48x48 test map, clear of all 4 bases and the lake. */
const SKIRMISH_4: readonly StartUnit[] = [
  { owner: 1, type: CLUBMAN, x: 23.5, y: 21.5 },
  { owner: 1, type: CLUBMAN, x: 24.5, y: 21.5 },
  { owner: 1, type: BOWMAN, x: 23.5, y: 20.5 },
  { owner: 2, type: CLUBMAN, x: 28.5, y: 26.5 },
  { owner: 2, type: CLUBMAN, x: 29.5, y: 26.5 },
  { owner: 2, type: BOWMAN, x: 29.5, y: 27.5 },
  { owner: 3, type: CLUBMAN, x: 23.5, y: 26.5 },
  { owner: 3, type: CLUBMAN, x: 24.5, y: 26.5 },
  { owner: 3, type: BOWMAN, x: 23.5, y: 27.5 },
  { owner: 4, type: CLUBMAN, x: 28.5, y: 21.5 },
  { owner: 4, type: CLUBMAN, x: 29.5, y: 21.5 },
  { owner: 4, type: BOWMAN, x: 29.5, y: 20.5 },
];

interface ReplayStart4 {
  count: number;
  villagers: { id: number; owner: number }[];
  centers: { id: number; owner: number; x: number; y: number }[];
  resources: { id: number; x: number; y: number }[];
  at(id: number): { x: number; y: number } | undefined;
}

function sampleSpeeds4(turns: number): SpeedChange[] {
  return SAMPLE_SPEEDS_4.filter((c) => c.turn < turns).map((c) => ({ ...c }));
}

function sampleBatches4(
  { count, villagers, centers, resources, at: startAt }: ReplayStart4,
  turns: number,
  seed: number,
  war: boolean,
  eliminate: { player: number; turn: number } | null,
): ReplayLog['batches'] {
  const gen = new CrtRand();
  gen.srand(seed);
  const fight = new CrtRand();
  fight.srand(seed + 7919);
  const study = new CrtRand();
  study.srand(seed + 104729);
  const mason = new CrtRand();
  mason.srand(seed + 15485863);
  const pick = (player: number) => villagers.flatMap((v) => ((v.owner === player || gen.rand() % 8 === 0) && gen.rand() % 3 !== 0 ? [v.id] : []));
  const fraction = () => gen.rand() / 32768;
  const batches: ReplayLog['batches'] = [];
  for (let turn = 0; turn < turns; turn++) {
    for (const player of [4, 2, 3, 1]) {
      if (eliminate && player === eliminate.player && turn > eliminate.turn) continue;
      const commands: Command[] = [];
      const n = gen.rand() % 4;
      for (let i = 0; i < n; i++) commands.push({ type: 'test', x: gen.rand() / 327.67, y: gen.rand() / 91.3 });
      if (n === 0 && gen.rand() % 2 === 0) commands.push({ type: 'noop' });
      const own = centers.find((c) => c.owner === player);
      const otherCenters = centers.filter((c) => c.owner !== player);
      if (gen.rand() % 64 === 0) {
        const ids = pick(player);
        if (ids.length > 0) commands.push({ type: 'move', units: ids, x: gen.rand() / 682.66, y: gen.rand() / 682.66 });
      }
      if (gen.rand() % 32 === 0 && own) {
        const ids = pick(player);
        const near = resources.filter((r) => Math.abs(r.x - own.x) < 16 && Math.abs(r.y - own.y) < 16);
        const pool = near.length > 0 ? near : resources;
        const target = pool.length > 0 && gen.rand() % 4 !== 0 ? pool[gen.rand() % pool.length]!.id : (gen.rand() % (count + 4)) + 1;
        const at = startAt(target) ?? { x: gen.rand() / 682.66, y: gen.rand() / 682.66 };
        if (ids.length > 0) commands.push({ type: 'work', units: ids, target, x: at.x, y: at.y });
      }
      if (gen.rand() % 48 === 0 && own) {
        const ids = pick(player);
        const unitType = gen.rand() % 3 === 0 ? BARRACKS : HOUSE;
        const x = own.x + (gen.rand() % 11) - 5 + fraction();
        const y = own.y + (gen.rand() % 11) - 5 + fraction();
        commands.push({ type: 'build', units: ids, unitType, x, y });
      }
      if (war && own && mason.rand() % 40 === 0) {
        const ids = villagers.filter((v) => v.owner === player && mason.rand() % 2 === 0).map((v) => v.id);
        const tile = (v: number) => Math.min(255, Math.max(0, Math.trunc(v)));
        const x1 = tile(own.x + (mason.rand() % 13) - 6);
        const y1 = tile(own.y + (mason.rand() % 13) - 6);
        const x2 = tile(x1 + (mason.rand() % 11) - 5);
        const y2 = tile(y1 + (mason.rand() % 11) - 5);
        commands.push({ type: 'build-wall', units: ids, unitType: SMALL_WALL, x1, y1, x2, y2 });
      }
      if (gen.rand() % 16 === 0 && own) {
        const otherTc = otherCenters.length > 0 ? otherCenters[gen.rand() % otherCenters.length]! : own;
        const building = gen.rand() % 8 === 0 ? otherTc.id : own.id;
        const unit = gen.rand() % 6 === 0 ? CLUBMAN : VILLAGER;
        const qCount = gen.rand() % 5 === 0 ? -1 : 1 + (gen.rand() % 3);
        commands.push({ type: 'queue', building, unit, count: qCount });
      }
      if (war && fight.rand() % 24 === 0) {
        const made = Array.from({ length: 1 + (fight.rand() % 6) }, () => count + 1 + (fight.rand() % 40));
        const ids = [...new Set([...villagers.filter((v) => v.owner === player && fight.rand() % 3 === 0).map((v) => v.id), ...made])];
        const enemies = villagers.filter((v) => v.owner !== player);
        const roll = fight.rand() % 8;
        const target =
          roll < 5 && enemies.length > 0
            ? enemies[fight.rand() % enemies.length]!.id
            : roll < 6 && otherCenters.length > 0
              ? otherCenters[fight.rand() % otherCenters.length]!.id
              : count + 1 + (fight.rand() % 40);
        commands.push({ type: 'attack', units: ids, target });
      }
      if (gen.rand() % 60 === 0) commands.push({ type: 'cancel', target: count + 1 + (gen.rand() % 40) });
      if (study.rand() % 20 === 0 && own) {
        const roll = study.rand() % 8;
        const otherTc = otherCenters.length > 0 ? otherCenters[study.rand() % otherCenters.length]! : own;
        const building = roll < 6 ? own.id : roll < 7 ? otherTc.id : count + 1 + (study.rand() % 40);
        const techs = [10, 39, 62, TOOL_AGE, TOOL_AGE, study.rand() % 130];
        commands.push({ type: 'research', building, tech: techs[study.rand() % techs.length]! });
      }
      if (study.rand() % 150 === 0 && own) commands.push({ type: 'stop', objects: [own.id] });
      if (eliminate && player === eliminate.player && turn === eliminate.turn) {
        commands.push({ type: 'resign' });
      }
      if (commands.length > 0) batches.push({ turn, player, commands });
    }
  }
  return batches;
}

/**
 * A 4-player human (`players: 5`, player 0 = Gaia, 1..4 = humans) determinism replay on the fixed test map.
 * Optionally includes a mid-map 4-way skirmish (`war`) and an early resignation (`eliminate`) so remaining players
 * continue playing past elimination.
 */
export function sampleReplay4(
  turns = 120,
  seed = 20260401,
  options: { war?: boolean; eliminate?: { player: number; turn: number } | null } = {},
): ReplayLog {
  const players = 5;
  const war = options.war ?? true;
  const eliminate = options.eliminate === undefined ? (war ? { player: 4, turn: Math.max(10, turns - 30) } : null) : options.eliminate;
  const units = war ? [...startingObjects(players), ...SKIRMISH_4] : startingObjects(players);
  const start: ReplayStart4 = {
    count: units.length,
    villagers: units.flatMap((u, i) => (u.type === VILLAGER ? [{ id: i + 1, owner: u.owner }] : [])),
    centers: units.flatMap((u, i) => (u.type === TOWN_CENTER ? [{ id: i + 1, owner: u.owner, x: u.x, y: u.y }] : [])),
    resources: units.flatMap((u, i) => (u.owner === 0 ? [{ id: i + 1, x: u.x, y: u.y }] : [])),
    at: (id) => units[id - 1],
  };
  return {
    players,
    randomSeed: 4442,
    units,
    turns,
    batches: sampleBatches4(start, turns, seed, war, eliminate),
    speeds: sampleSpeeds4(turns),
  };
}

/**
 * A 4-player human (`players: 5`) random-map replay log, preserving the full 5-entry `civs` array (with `CIV_RANDOM`
 * resolved deterministically from `randomSeed` in slot order `0..3` without filtering or compacting).
 */
export function sampleRandomMapReplay4(
  turns = 60,
  seed = 20260415,
  lobby: { randomSeed: number; settings: GameSettings; civs: readonly number[] } = {
    randomSeed: 4443,
    settings: DEFAULT_GAME_SETTINGS,
    civs: [CIV_RANDOM, 10, CIV_RANDOM, 3],
  },
): ReplayLog {
  const players = lobby.civs.length + 1;
  const options = lobbyWorldOptions(lobby.randomSeed, lobby.settings, lobby.civs);
  const randomMap: RandomMapOptions = options.randomMap ?? {};
  const world = new World(options);
  const objects = [...world.entities.all()];
  const start: ReplayStart4 = {
    count: objects.length > 0 ? Math.max(...objects.map((e) => e.id)) : 0,
    villagers: objects.flatMap((e) => (e.type === VILLAGER ? [{ id: e.id, owner: e.owner }] : [])),
    centers: objects.flatMap((e) => (e.type === TOWN_CENTER ? [{ id: e.id, owner: e.owner, x: e.x, y: e.y }] : [])),
    resources: objects.flatMap((e) => (e.owner === 0 && e.heldAmount > 0 ? [{ id: e.id, x: e.x, y: e.y }] : [])),
    at: (id) => world.entities.get(id),
  };
  const { startingAge, resourceLevel, deathMatch, fullTechTree, revealMap, pathingIterations, fixedPositions, cheating } = options;
  const lobbyStart = { startingAge, resourceLevel, deathMatch, fullTechTree, revealMap, pathingIterations, fixedPositions, cheating };
  return {
    players,
    randomSeed: lobby.randomSeed,
    randomMap,
    civs: [...world.civs],
    victory: options.victory!,
    populationLimit: options.populationLimit!,
    start: lobbyStart,
    turns,
    batches: sampleBatches4(start, turns, seed, false, null),
    speeds: sampleSpeeds4(turns),
  };
}

/**
 * A 4-player human (`players: 5`) diplomacy replay on the fixed test map with built Markets for players 1..4,
 * issuing `relation`, `allied-victory`, and `tribute` commands across all 4 players plus a mid-game resign by player 4.
 */
export function sampleDiplomacyReplay4(turns = 100, seed = 20260417): ReplayLog {
  const eliminateTurn = Math.max(10, Math.trunc(turns / 2));
  const log = sampleReplay4(turns, seed, { war: true, eliminate: { player: 4, turn: eliminateTurn } });
  const markets: StartUnit[] = log.units!.filter((u) => u.type === TOWN_CENTER).map((tc) => ({ owner: tc.owner, type: MARKET, x: tc.x - 4, y: tc.y }));
  const talk = new CrtRand();
  talk.srand(seed + 15485863);
  const batches = [...log.batches];
  for (let turn = 0; turn < turns; turn++) {
    for (const player of [4, 3, 2, 1]) {
      if (player === 4 && turn > eliminateTurn) continue;
      const commands: Command[] = [];
      const others = [1, 2, 3, 4].filter((p) => p !== player);
      const target = others[talk.rand() % others.length]!;
      if (talk.rand() % 8 === 0) {
        const roll = talk.rand() % 16;
        commands.push({ type: 'relation', player: roll === 0 ? player : roll === 1 ? 0 : target, relation: [0, 1, 3][talk.rand() % 3]! });
      }
      if (talk.rand() % 24 === 0) commands.push({ type: 'allied-victory', on: talk.rand() % 2 === 0 });
      if (talk.rand() % 6 === 0) commands.push({ type: 'tribute', player: target, resource: talk.rand() % 4, amount: 50 + (talk.rand() % 451) });
      if (commands.length === 0) continue;
      const batch = batches.find((b) => b.turn === turn && b.player === player);
      if (batch) batch.commands = [...batch.commands, ...commands];
      else batches.push({ turn, player, commands });
    }
  }
  return { ...log, units: [...log.units!, ...markets], batches };
}
