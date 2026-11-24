import { describe, expect, test } from 'vitest';
import { CIV_RANDOM, DEFAULT_GAME_SETTINGS, lobbyWorldOptions, resolveCivs } from './game-settings';
import { replayWorld, runReplay, sampleRandomMapReplay4, sampleReplay4 } from './replay';
import { MAP_HILLY, MAP_MEDIUM } from './rmm-controller';
import { VICTORY_TIME_LIMIT } from './victory';
import { AGE_BRONZE, startingObjects, World, type Snapshot } from './world';

const REPLAY_TIMEOUT = 30_000;

describe('W05: 4-player deterministic replay and JSON snapshot', () => {
  test('sampleReplay4 runs identically twice with 5 sim players and continues past player 4 resign', () => {
    const log = sampleReplay4(80);
    expect(log.players).toBe(5);
    const first = runReplay(log);
    const second = runReplay(log);
    expect(first).toHaveLength(80);
    expect(second).toEqual(first);

    const mutated = { ...log, batches: log.batches.slice(1) };
    expect(runReplay(mutated).at(-1)).not.toBe(first.at(-1));
  }, REPLAY_TIMEOUT);

  test('out-of-order batch submission across slots 1..4 produces identical hashes (CommandQueue canonical sort)', () => {
    const log = sampleReplay4(30, 20260402, { war: false, eliminate: null });
    const forward = new World({ players: log.players, randomSeed: log.randomSeed, units: log.units });
    const reversed = new World({ players: log.players, randomSeed: log.randomSeed, units: log.units });

    while (forward.turn < log.turns) {
      const turnBatches = log.batches.filter((b) => b.turn === forward.turn);
      for (const b of turnBatches) forward.addBatch(b.turn, b.player, b.commands);
      for (const b of [...turnBatches].reverse()) reversed.addBatch(b.turn, b.player, b.commands);
      for (const c of log.speeds ?? []) {
        if (c.turn === forward.turn) {
          forward.setSpeedChange(c);
          reversed.setSpeedChange(c);
        }
      }
      forward.runTurn();
      reversed.runTurn();
      // Pending queue serialization preserves arrival order; the executed state must agree.
      expect(reversed.syncChecksum()).toBe(forward.syncChecksum());
    }
    // Once the delayed queue drains, the complete snapshots must agree as well.
    for (let i = 0; i < 3; i++) { forward.runTurn(); reversed.runTurn(); }
    expect(reversed.hash()).toBe(forward.hash());
  }, REPLAY_TIMEOUT);

  test('JSON snapshot round-trip mid-game and after player 4 resign preserves all 5 player arrays without compacting', () => {
    const log = sampleReplay4(80);
    const full = runReplay(log);

    // Turn 55 is after player 4's resign on turn 50.
    const split = 55;
    const w = new World({ players: log.players, randomSeed: log.randomSeed, units: log.units });
    runReplay({ ...log, turns: split }, w);
    expect(w.playerStatus(4)).toBe(2);
    expect(w.gameOver).toBe(false);

    const snap = JSON.parse(JSON.stringify(w.snapshot())) as Snapshot;
    const restored = World.restore(snap);
    expect(restored.players).toBe(5);
    expect(restored.civs).toHaveLength(5);
    expect(restored.attributes).toHaveLength(5);
    expect(restored.awake).toHaveLength(5);
    expect(restored.techs).toHaveLength(5);
    expect(restored.victory.status).toHaveLength(5);
    expect(restored.diplomacy.relations).toHaveLength(5);
    expect(restored.hash()).toBe(w.hash());
    expect(restored.snapshot()).toEqual(w.snapshot());

    const tail = runReplay(log, restored);
    expect(tail).toEqual(full.slice(split));
  }, REPLAY_TIMEOUT);
});

describe('W05: CIV_RANDOM resolution and random-map 4-player replay', () => {
  test('resolveCivs resolves CIV_RANDOM deterministically across 4 slots while keeping fixed slots intact', () => {
    const allRandom = resolveCivs(1, [CIV_RANDOM, CIV_RANDOM, CIV_RANDOM, CIV_RANDOM]);
    expect(allRandom).toHaveLength(4);
    for (const c of allRandom) {
      expect(Number.isInteger(c)).toBe(true);
      expect(c).toBeGreaterThanOrEqual(1);
      expect(c).toBeLessThanOrEqual(16);
    }
    expect(resolveCivs(1, [CIV_RANDOM, CIV_RANDOM, CIV_RANDOM, CIV_RANDOM])).toEqual(allRandom);

    const mixed = resolveCivs(777, [5, CIV_RANDOM, 12, CIV_RANDOM]);
    expect(mixed[0]).toBe(5);
    expect(mixed[2]).toBe(12);
    expect(mixed[1]).toBeGreaterThanOrEqual(1);
    expect(mixed[1]).toBeLessThanOrEqual(16);
    expect(mixed[3]).toBeGreaterThanOrEqual(1);
    expect(mixed[3]).toBeLessThanOrEqual(16);
  });

  test('sampleRandomMapReplay4 preserves 5-element civs, replays deterministically, and round-trips through JSON snapshot', () => {
    const settings = {
      ...DEFAULT_GAME_SETTINGS,
      mapType: MAP_HILLY,
      mapSize: MAP_MEDIUM,
      victory: { type: VICTORY_TIME_LIMIT, amount: 3000 },
      startingAge: AGE_BRONZE,
      fixedPositions: false,
    };
    const log = sampleRandomMapReplay4(40, 20260416, {
      randomSeed: 4445,
      settings,
      civs: [CIV_RANDOM, 10, CIV_RANDOM, 3],
    });
    expect(log.players).toBe(5);
    expect(log.civs).toEqual([0, ...resolveCivs(4445, [CIV_RANDOM, 10, CIV_RANDOM, 3])]);

    const first = runReplay(log);
    expect(first).toHaveLength(40);
    expect(runReplay(log)).toEqual(first);

    const w = replayWorld(log);
    runReplay({ ...log, turns: 20 }, w);
    const restored = World.restore(JSON.parse(JSON.stringify(w.snapshot())) as Snapshot);
    expect(restored.hash()).toBe(w.hash());
    expect(runReplay(log, restored)).toEqual(first.slice(20));
  }, REPLAY_TIMEOUT);

  test('lobbyWorldOptions with 4 CIV_RANDOM players creates 5 sim players with deterministic world hash', () => {
    const opts = lobbyWorldOptions(999, DEFAULT_GAME_SETTINGS, [CIV_RANDOM, CIV_RANDOM, CIV_RANDOM, CIV_RANDOM], true);
    expect(opts.players).toBe(5);
    expect(opts.civs).toHaveLength(5);
    expect(opts.civs![0]).toBe(0);
    const a = new World(opts);
    const b = new World({ ...opts, units: startingObjects(5) });
    expect(a.hash()).toBe(b.hash());
  });
});
