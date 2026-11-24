import { describe, expect, test } from 'vitest';
import { type Command } from './commands';
import { ATTR_TRIBUTE_FEE, ATTR_TRIBUTE_SENT, newDiplomacy, RELATION_ALLY, RELATION_ENEMY, RELATION_NEUTRAL } from './diplomacy';
import { runReplay, sampleDiplomacyReplay4 } from './replay';
import { doEffect } from './techs';
import { CLUBMAN, MARKET, VILLAGER, WATCH_TOWER } from './units';
import { AI_ACTION_ATTACK } from './unit-ai';
import { VICTORY_SPECIAL } from './victory';
import { TILE_BLACK, TILE_VISIBLE } from './visibility';
import { World, type Snapshot, type StartUnit } from './world';

const GOLD = 3;
const WRITING_EFFECT = 113;

function world(...units: StartUnit[]): World {
  return new World({ players: 5, units, victory: { type: VICTORY_SPECIAL } });
}

function fourVillagers(): StartUnit[] {
  return [
    { owner: 1, type: VILLAGER, x: 5.5, y: 5.5 },
    { owner: 2, type: VILLAGER, x: 40.5, y: 5.5 },
    { owner: 3, type: VILLAGER, x: 5.5, y: 40.5 },
    { owner: 4, type: VILLAGER, x: 40.5, y: 40.5 },
  ];
}

function order(w: World, player: number, command: Command): void {
  w.addBatch(w.turn, player, [command]);
  for (let i = 0; i < 3; i++) w.runTurn();
}

describe('W03: 4-player diplomacy stances and combat rules', () => {
  test('newDiplomacy(5) initializes 5x5 matrix: Gaia neutral, 1..4 mutually enemy, flags false', () => {
    const w = world(...fourVillagers());
    expect(w.diplomacy.relations).toEqual([
      [RELATION_NEUTRAL, RELATION_ENEMY, RELATION_ENEMY, RELATION_ENEMY, RELATION_ENEMY],
      [RELATION_NEUTRAL, RELATION_NEUTRAL, RELATION_ENEMY, RELATION_ENEMY, RELATION_ENEMY],
      [RELATION_NEUTRAL, RELATION_ENEMY, RELATION_NEUTRAL, RELATION_ENEMY, RELATION_ENEMY],
      [RELATION_NEUTRAL, RELATION_ENEMY, RELATION_ENEMY, RELATION_NEUTRAL, RELATION_ENEMY],
      [RELATION_NEUTRAL, RELATION_ENEMY, RELATION_ENEMY, RELATION_ENEMY, RELATION_NEUTRAL],
    ]);
    expect(w.diplomacy.alliedVictory).toEqual([false, false, false, false, false]);
    expect(w.diplomacy.alliedLos).toEqual([false, false, false, false, false]);
    expect(w.isEnemy(3, 4)).toBe(true);
    expect(w.isEnemy(3, 0)).toBe(false);
    expect(w.isAlly(3, 3)).toBe(true);
  });

  test('one-sided stances among 4 players affect only sender->target and reject invalid targets', () => {
    const w = world(...fourVillagers());
    order(w, 1, { type: 'relation', player: 3, relation: RELATION_ALLY });
    order(w, 2, { type: 'relation', player: 4, relation: RELATION_NEUTRAL });
    expect([w.relation(1, 3), w.relation(3, 1), w.isAlly(1, 3), w.isAlly(3, 1)]).toEqual([RELATION_ALLY, RELATION_ENEMY, true, false]);
    expect([w.relation(2, 4), w.relation(4, 2), w.isEnemy(2, 4), w.isEnemy(4, 2)]).toEqual([RELATION_NEUTRAL, RELATION_ENEMY, false, true]);

    const before = JSON.stringify(w.diplomacy);
    order(w, 4, { type: 'relation', player: 4, relation: RELATION_ALLY });
    order(w, 4, { type: 'relation', player: 0, relation: RELATION_ALLY });
    order(w, 4, { type: 'relation', player: 5, relation: RELATION_ALLY });
    expect(JSON.stringify(w.diplomacy)).toBe(before);
  });

  test('Watch Tower targets enemy P2 but spares neutral P3 and ally P4', () => {
    const w = world(
      { owner: 1, type: WATCH_TOWER, x: 20.5, y: 20.5 },
      { owner: 2, type: VILLAGER, x: 23.5, y: 20.5 },
      { owner: 3, type: VILLAGER, x: 20.5, y: 23.5 },
      { owner: 4, type: VILLAGER, x: 17.5, y: 20.5 },
    );
    order(w, 1, { type: 'relation', player: 3, relation: RELATION_NEUTRAL });
    order(w, 1, { type: 'relation', player: 4, relation: RELATION_ALLY });
    const tower = w.entities.get(1)!;
    for (let i = 0; i < 30 && tower.ai!.target === -1; i++) w.runTurn();
    expect([tower.ai!.action, tower.ai!.target]).toEqual([AI_ACTION_ATTACK, 2]);
  });

  test('Clubman ignores ally P4 and neutral P3 villagers, auto-attacks enemy P2', () => {
    const w = world(
      { owner: 1, type: CLUBMAN, x: 20.5, y: 20.5 },
      { owner: 3, type: VILLAGER, x: 22.5, y: 20.5 },
      { owner: 4, type: VILLAGER, x: 18.5, y: 20.5 },
    );
    order(w, 1, { type: 'relation', player: 3, relation: RELATION_NEUTRAL });
    order(w, 1, { type: 'relation', player: 4, relation: RELATION_ALLY });
    for (let i = 0; i < 20; i++) w.runTurn();
    expect(w.entities.get(1)!.ai!.target).toBe(-1);
  });
});

describe('W03: 4-player allied LOS (Writing) and tribute isolation', () => {
  test('Writing + mutual alliance between P1 and P3 shares P3 sight with P1 only, leaving P2 and P4 hidden', () => {
    const w = world(...fourVillagers());
    w.runTurn();
    expect([w.tileVisibility(1, 5, 40), w.tileVisibility(1, 40, 5), w.tileVisibility(1, 40, 40)]).toEqual([TILE_BLACK, TILE_BLACK, TILE_BLACK]);

    order(w, 1, { type: 'relation', player: 3, relation: RELATION_ALLY });
    order(w, 3, { type: 'relation', player: 1, relation: RELATION_ALLY });
    doEffect(w.gameContext(), 1, WRITING_EFFECT);

    expect(w.diplomacy.alliedLos).toEqual([false, true, false, false, false]);
    expect(w.tileVisibility(1, 5, 40)).toBe(TILE_VISIBLE);
    expect(w.tileVisibility(1, 40, 5)).toBe(TILE_BLACK);
    expect(w.tileVisibility(1, 40, 40)).toBe(TILE_BLACK);
    expect(w.tileVisibility(3, 5, 5)).toBe(TILE_BLACK);
    expect(w.tileVisibility(2, 5, 40)).toBe(TILE_BLACK);
    expect(w.tileVisibility(4, 5, 40)).toBe(TILE_BLACK);

    // Breaking mutual alliance revokes shared LOS.
    order(w, 3, { type: 'relation', player: 1, relation: RELATION_ENEMY });
    expect(w.tileVisibility(1, 5, 40)).toBe(TILE_BLACK);
  });

  test('tribute between P1 and P4 updates only P1 and P4 stockpiles and ATTR_TRIBUTE_SENT', () => {
    const w = world(
      { owner: 1, type: MARKET, x: 5.5, y: 5.5 },
      { owner: 2, type: VILLAGER, x: 40.5, y: 5.5 },
      { owner: 3, type: VILLAGER, x: 5.5, y: 40.5 },
      { owner: 4, type: VILLAGER, x: 40.5, y: 40.5 },
    );
    w.attributes[1]![GOLD] = 500;
    w.attributes[2]![GOLD] = 111;
    w.attributes[3]![GOLD] = 222;
    w.attributes[4]![GOLD] = 0;

    expect(w.attributes[1]![ATTR_TRIBUTE_FEE]).toBe(0.25);
    order(w, 1, { type: 'tribute', player: 4, resource: GOLD, amount: 100 });
    expect([w.attributes[1]![GOLD], w.attributes[2]![GOLD], w.attributes[3]![GOLD], w.attributes[4]![GOLD]]).toEqual([375, 111, 222, 100]);
    expect([
      w.attributes[1]![ATTR_TRIBUTE_SENT],
      w.attributes[2]![ATTR_TRIBUTE_SENT],
      w.attributes[3]![ATTR_TRIBUTE_SENT],
      w.attributes[4]![ATTR_TRIBUTE_SENT],
    ]).toEqual([125, 0, 0, -100]);

    // Tribute to Gaia, self, or out-of-range player 5 is ignored.
    order(w, 1, { type: 'tribute', player: 0, resource: GOLD, amount: 50 });
    order(w, 1, { type: 'tribute', player: 1, resource: GOLD, amount: 50 });
    order(w, 1, { type: 'tribute', player: 5, resource: GOLD, amount: 50 });
    expect(w.attributes[1]![GOLD]).toBe(375);
  });

  test('snapshot preserves 5-player diplomacy state and mutual-ally visibility masks', () => {
    const w = world(...fourVillagers());
    order(w, 1, { type: 'relation', player: 4, relation: RELATION_ALLY });
    order(w, 4, { type: 'relation', player: 1, relation: RELATION_ALLY });
    order(w, 4, { type: 'allied-victory', on: true });
    doEffect(w.gameContext(), 1, WRITING_EFFECT);

    const restored = World.restore(JSON.parse(JSON.stringify(w.snapshot())) as Snapshot);
    expect(restored.diplomacy).toEqual(w.diplomacy);
    expect(restored.visibility.mutualVisible).toEqual(w.visibility.mutualVisible);
    expect(restored.visibility.mutualExplored).toEqual(w.visibility.mutualExplored);
    expect(restored.hash()).toBe(w.hash());
  });
});

describe('W03 + W05: 4-player diplomacy replay determinism', () => {
  test('sampleDiplomacyReplay4 replays identically twice and continues after player 4 resigns', () => {
    const log = sampleDiplomacyReplay4(80);
    expect(log.players).toBe(5);
    const kinds = new Set(log.batches.flatMap((b) => b.commands.map((c) => c.type)));
    expect(['relation', 'allied-victory', 'tribute', 'resign'].every((k) => kinds.has(k as Command['type']))).toBe(true);

    const w = new World({ players: log.players, randomSeed: log.randomSeed, units: log.units });
    const a = runReplay(log, w);
    expect(runReplay(log)).toEqual(a);
    expect(w.playerStatus(4)).toBe(2);
    expect(w.gameOver).toBe(false);
    expect(JSON.stringify(w.diplomacy.relations)).not.toBe(JSON.stringify(newDiplomacy(5).relations));
  }, 30_000);
});
