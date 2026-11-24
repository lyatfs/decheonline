import { describe, expect, test } from 'vitest';
import { type Command } from './commands';
import { NOTIFY_PLAYER_DEFEATED, NOTIFY_PLAYER_RESIGNED } from './game-log';
import { f32, MS_TO_SECONDS, mul32 } from './num';
import { CLUBMAN, TOWN_CENTER, VILLAGER } from './units';
import {
  ATTR_ALL_ARTIFACTS,
  ATTR_ARTIFACTS,
  checkGameState,
  END_ALL_RELICS,
  END_CONDITIONS,
  END_CONQUEST,
  END_TIME_LIMIT,
  END_WONDER,
  newVictory,
  STATUS_LOST,
  STATUS_PLAYING,
  STATUS_WON,
  VICTORY_CONQUEST,
  VICTORY_SCORE,
  VICTORY_STANDARD,
  VICTORY_TIME_LIMIT,
  type VictorySettings,
} from './victory';
import { WONDER, WONDER_COUNTING } from './wonder';
import { startingObjects, STEP_MS, World, type StartUnit } from './world';

const DT = mul32(STEP_MS, MS_TO_SECONDS);

function order(w: World, player: number, command: Command): void {
  w.addBatch(w.turn, player, [command]);
  for (let i = 0; i < 3; i++) w.runTurn();
}

function stepsUntil(w: World, done: () => boolean, limit: number): number {
  let steps = 0;
  while (!done() && steps < limit) {
    w.runStep();
    steps++;
  }
  expect(done()).toBe(true);
  return steps;
}

function fourBases(victory: VictorySettings = { type: VICTORY_STANDARD }): World {
  return new World({
    players: 5,
    units: [
      { owner: 1, type: TOWN_CENTER, x: 5.5, y: 5.5 },
      { owner: 2, type: TOWN_CENTER, x: 40.5, y: 5.5 },
      { owner: 3, type: TOWN_CENTER, x: 5.5, y: 40.5 },
      { owner: 4, type: TOWN_CENTER, x: 40.5, y: 40.5 },
    ],
    victory,
  });
}

describe('W04: 4-player FFA resignation and elimination lifecycle', () => {
  test('resigning player 4 then player 3 does NOT end match early; last surviving player wins by conquest', () => {
    for (const victory of [{ type: VICTORY_STANDARD }, { type: VICTORY_CONQUEST }] as const) {
      const w = new World({ players: 5, units: startingObjects(5), victory });

      order(w, 4, { type: 'resign' });
      expect(w.gameOver).toBe(false);
      expect(w.gameResult()).toBeNull();
      expect(w.victory.status).toEqual([0, STATUS_PLAYING, STATUS_PLAYING, STATUS_PLAYING, STATUS_LOST]);
      expect(w.victory.resigned).toEqual([false, false, false, false, true]);

      order(w, 3, { type: 'resign' });
      expect(w.gameOver).toBe(false);
      expect(w.victory.status).toEqual([0, STATUS_PLAYING, STATUS_PLAYING, STATUS_LOST, STATUS_LOST]);

      // Remaining 2 players can still advance turns and issue commands.
      const p2Vill = [...w.entities.ofPlayer(2)].find((e) => e.type === VILLAGER)!;
      const beforeX = p2Vill.x;
      order(w, 2, { type: 'move', units: [p2Vill.id], x: beforeX - 2, y: p2Vill.y - 2 });
      stepsUntil(w, () => p2Vill.x !== beforeX, 100);
      expect(w.gameOver).toBe(false);

      // Only when P1 resigns does P2 win as the last survivor.
      order(w, 1, { type: 'resign' });
      expect(w.gameOver).toBe(true);
      expect(w.gameResult()).toEqual({
        endCondition: END_CONQUEST,
        winners: [2],
        status: [0, STATUS_LOST, STATUS_WON, STATUS_LOST, STATUS_LOST],
      });
      expect(w.log.notifications.filter((n) => n.type === NOTIFY_PLAYER_RESIGNED).map((n) => n.args[0])).toEqual([4, 3, 1]);
    }
  });

  test('eliminating players 4 and 3 via unit loss keeps match running until only 1 survivor remains', () => {
    const units: StartUnit[] = [
      { owner: 1, type: VILLAGER, x: 5.5, y: 5.5 },
      { owner: 2, type: VILLAGER, x: 40.5, y: 5.5 },
      { owner: 3, type: VILLAGER, x: 5.5, y: 40.5 },
    ];
    // Player 4 starts with zero objects: defeated at step 12, match continues for 1..3.
    const w = new World({ players: 5, units, victory: { type: VICTORY_STANDARD } });
    for (let i = 0; i < 12; i++) w.runStep();
    expect(w.playerStatus(4)).toBe(STATUS_LOST);
    expect(w.score(4).survival).toBe(0);
    expect(w.gameOver).toBe(false);

    // Eliminate player 3: match STILL continues for 1 and 2.
    const p3Vill = [...w.entities.ofPlayer(3)].find((e) => e.type === VILLAGER)!;
    order(w, 3, { type: 'cancel', target: p3Vill.id });
    for (let i = 0; i < 30 && w.playerStatus(3) === STATUS_PLAYING; i++) w.runTurn();
    expect(w.playerStatus(3)).toBe(STATUS_LOST);
    expect(w.gameOver).toBe(false);

    // Eliminate player 2 in combat: player 1 wins by conquest.
    const p2Vill = [...w.entities.ofPlayer(2)].find((e) => e.type === VILLAGER)!;
    const clubman = w.createUnit({ owner: 1, type: CLUBMAN, x: 39.5, y: 5.5 });
    order(w, 1, { type: 'attack', units: [clubman.id], target: p2Vill.id });
    stepsUntil(w, () => w.gameOver, 500);
    expect(w.gameResult()).toEqual({
      endCondition: END_CONQUEST,
      winners: [1],
      status: [0, STATUS_WON, STATUS_LOST, STATUS_LOST, STATUS_LOST],
    });
    expect(w.log.notifications.filter((n) => n.type === NOTIFY_PLAYER_DEFEATED).map((n) => n.args[0])).toEqual([4, 3, 2]);
  });

  test('last two survivors resigning in the same turn ends with draw (empty winners array)', () => {
    const w = fourBases();
    order(w, 3, { type: 'resign' });
    order(w, 4, { type: 'resign' });
    expect(w.gameOver).toBe(false);
    w.addBatch(w.turn, 1, [{ type: 'resign' }]);
    w.addBatch(w.turn, 2, [{ type: 'resign' }]);
    for (let i = 0; i < 3; i++) w.runTurn();
    expect(w.gameResult()).toEqual({
      endCondition: END_CONQUEST,
      winners: [],
      status: [0, STATUS_LOST, STATUS_LOST, STATUS_LOST, STATUS_LOST],
    });
  });

  test('FFA default has no 2v2 teams: all 4 players start hostile and alliedVictory starts false', () => {
    const w = fourBases();
    expect(w.diplomacy.alliedVictory).toEqual([false, false, false, false, false]);
    for (let p = 1; p <= 4; p++) {
      for (let q = 1; q <= 4; q++) {
        if (p !== q) expect(w.isEnemy(p, q)).toBe(true);
      }
    }
  });
});

describe('W04: Standard Wonder, Relics, Score and Time Limit victories in 4-player FFA', () => {
  test('Standard Wonder victory: player 3 builds and holds Wonder 2000 years -> player 3 wins, 1/2/4 lose', () => {
    const w = fourBases({ type: VICTORY_STANDARD });
    const wonder = w.createUnit({ owner: 3, type: WONDER, x: 22.5, y: 12.5 });
    w.runStep();
    expect(wonder.wonder?.state).toBe(WONDER_COUNTING);
    expect(w.victory.wonderCountdown[3]).toBe(2000);
    stepsUntil(w, () => w.gameOver, 12000);
    expect(w.gameResult()).toEqual({
      endCondition: END_WONDER,
      winners: [3],
      status: [0, STATUS_LOST, STATUS_LOST, STATUS_WON, STATUS_LOST],
    });
  });

  test('if player 3 resigns while owning a Wonder, its timer does NOT end the game or defeat survivors 1, 2, 4', () => {
    const w = fourBases({ type: VICTORY_STANDARD });
    w.createUnit({ owner: 3, type: WONDER, x: 22.5, y: 12.5 });
    w.runStep();
    order(w, 3, { type: 'resign' });
    expect(w.playerStatus(3)).toBe(STATUS_LOST);
    expect(w.gameOver).toBe(false);
    for (let i = 0; i < 11200; i++) w.runStep();
    expect(w.gameOver).toBe(false);
    expect(w.victory.status).toEqual([0, STATUS_PLAYING, STATUS_PLAYING, STATUS_LOST, STATUS_PLAYING]);
  });

  test('All-Relics victory: player 2 holding all 5 relics wins with END_ALL_RELICS; resigned player 4 holding all 5 does not', () => {
    const v = newVictory(5, { type: VICTORY_STANDARD });
    v.artifactCount = 5;
    const attrs = Array.from({ length: 5 }, () => new Array<number>(60).fill(0));
    attrs[2]![ATTR_ARTIFACTS] = 5;
    checkGameState(v, DT, attrs);
    expect([v.artifactHeld[2], attrs[2]![ATTR_ALL_ARTIFACTS]]).toEqual([2000, 1]);
    let steps = 0;
    while (v.gameState === 0 && steps < 12000) {
      checkGameState(v, DT, attrs);
      steps++;
    }
    expect(v.gameState).toBe(1);
    expect(v.endCondition).toBe(END_ALL_RELICS);
    expect(v.status).toEqual([0, STATUS_LOST, STATUS_WON, STATUS_LOST, STATUS_LOST]);

    // Resigned player 4 holding all 5 relics must not eliminate survivors 1..3.
    const v2 = newVictory(5, { type: VICTORY_STANDARD });
    v2.artifactCount = 5;
    v2.status[4] = STATUS_LOST;
    v2.resigned[4] = true;
    const attrs2 = Array.from({ length: 5 }, () => new Array<number>(60).fill(0));
    attrs2[4]![ATTR_ARTIFACTS] = 5;
    for (let i = 0; i < 12000; i++) checkGameState(v2, DT, attrs2);
    expect(v2.gameState).toBe(0);
    expect(v2.status).toEqual([0, STATUS_PLAYING, STATUS_PLAYING, STATUS_PLAYING, STATUS_LOST]);
  });

  test('Score victory in 4-player FFA: player 4 resigned early, player 2 reaches target -> player 2 wins', () => {
    const w = fourBases({ type: VICTORY_SCORE, amount: 300 });
    order(w, 4, { type: 'resign' });
    expect(w.gameOver).toBe(false);
    w.attributes[2]![21] = 80; // 160 + 50 (highest tech) + 100 survival = 310 >= 300
    w.runStep();
    expect(w.gameResult()).toEqual({
      endCondition: END_CONDITIONS,
      winners: [2],
      status: [0, STATUS_LOST, STATUS_WON, STATUS_LOST, STATUS_LOST],
    });
  });

  test('Time Limit victory in 4-player FFA: highest surviving player wins, ignoring resigned higher-score player', () => {
    const v = newVictory(5, { type: VICTORY_TIME_LIMIT, amount: 10 });
    v.countdownClock = f32(1);
    v.status[3] = STATUS_LOST;
    v.resigned[3] = true;
    v.totals = [0, 200, 350, 999, 300];
    checkGameState(v, DT, [[], [], [], [], []]);
    expect(v.gameState).toBe(1);
    expect(v.endCondition).toBe(END_TIME_LIMIT);
    expect(v.status).toEqual([0, STATUS_LOST, STATUS_WON, STATUS_LOST, STATUS_LOST]);
  });
});
