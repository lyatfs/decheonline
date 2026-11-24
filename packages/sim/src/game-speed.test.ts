import { describe, expect, test } from 'vitest';
import {
  DEFAULT_GAME_SPEED,
  GAME_SPEEDS,
  SINGLE_PLAYER_SPEED_MAX,
  SINGLE_PLAYER_SPEED_MIN,
  SINGLE_PLAYER_SPEED_STEP,
  isMultiplayerGameSpeed,
  isSinglePlayerGameSpeed,
  parseCommand,
} from './commands';
import { sampleLobbyReplay, replayWorld, runReplay } from './replay';
import { VICTORY_SPECIAL } from './victory';
import { World } from './world';

// Game speed (docs/spec/lobby.md §8): a game command sets `game_speed`; every later step adds `G * game_speed` ms.
describe('game speed', () => {
  test('bounded finite speeds in [0.5, 4.0] parse; invalid/out-of-range/non-finite are rejected; multiplayer whitelist stays [1, 1.5, 2]', () => {
    expect([SINGLE_PLAYER_SPEED_MIN, SINGLE_PLAYER_SPEED_MAX, SINGLE_PLAYER_SPEED_STEP, DEFAULT_GAME_SPEED]).toEqual([0.5, 4, 0.25, 1]);
    expect(GAME_SPEEDS).toEqual([1, 1.5, 2]);

    for (const speed of [0.5, 0.75, 1, 1.25, 1.5, 2, 2.5, 3, 4]) {
      expect(isSinglePlayerGameSpeed(speed)).toBe(true);
      expect(parseCommand({ type: 'game-speed', speed })).toEqual({ type: 'game-speed', speed });
    }
    for (const speed of [0, -0.5, -1, 0.25, 0.49, 4.01, 16, '2', null, undefined, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      expect(isSinglePlayerGameSpeed(speed)).toBe(false);
      expect(parseCommand({ type: 'game-speed', speed })).toBeNull();
    }

    for (const speed of [1, 1.5, 2]) expect(isMultiplayerGameSpeed(speed)).toBe(true);
    for (const speed of [0.5, 0.75, 1.25, 2.5, 4, 0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(isMultiplayerGameSpeed(speed)).toBe(false);
    }
  });

  test.each([0.5, 1.5, 2, 4])('speed %f multiplies the game time each step adds, from the step the command runs', (speed) => {
    const world = new World({ players: 3, randomSeed: 5, victory: { type: VICTORY_SPECIAL } });
    for (let t = 0; t < 8; t++) world.runTurn();
    expect(world.gameSpeed).toBe(1);
    world.addBatch(world.turn, 1, [{ type: 'game-speed', speed }]);
    world.runTurn();
    world.runTurn();
    // The command runs in the boundary step of the turn two later: that step still adds G, the rest G * speed.
    const before = world.worldTime;
    world.runStep();
    expect(world.gameSpeed).toBe(speed);
    expect(world.worldTime - before).toBe(world.granularity);
    const turnStart = world.worldTime;
    while (world.turnStep !== 0) world.runStep();
    expect(world.worldTime - turnStart).toBe(world.frames * world.granularity * speed);
    world.runTurn();
    expect(world.gameSpeed).toBe(speed);
  });

  test('the lobby sample replay changes the speed to 1.5 and then 2', () => {
    const log = sampleLobbyReplay(40);
    const world = replayWorld(log);
    runReplay(log, world);
    expect(world.gameSpeed).toBe(2);
    expect(world.snapshot().gameSpeed).toBe(2);
  });
});
