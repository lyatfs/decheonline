import { describe, expect, test } from 'vitest';
import { DEFAULT_GAME_SETTINGS, lobbyWorldOptions } from './game-settings';
import { TEST_MAP_SIZE } from './map';
import { add32, mul32, sub32, toInt } from './num';
import { ELEPHANT, FORAGE, GAZELLE, MINE_GOLD, MINE_STONE, TOWN_CENTER, TREES, unitType, VILLAGER } from './units';
import { TILE_BLACK, TILE_VISIBLE } from './visibility';
import { COMMAND_DELAY_TURNS, startingObjects, startingUnits, World, type Snapshot } from './world';

const ATTR_FOOD = 0;

function expectedCells(world: World): Uint8Array {
  const { cellsX, cellsY } = world.pathing;
  const cells = new Uint8Array(cellsX * cellsY);
  for (const e of world.entities.all()) {
    if (!e.stamped) continue;
    const t = unitType(e.type);
    const minX = Math.max(0, toInt(mul32(sub32(e.x, t.radiusX), 4)));
    const minY = Math.max(0, toInt(mul32(sub32(e.y, t.radiusY), 4)));
    const maxX = toInt(mul32(add32(t.radiusX, e.x), 4));
    const maxY = toInt(mul32(add32(t.radiusY, e.y), 4));
    for (let x = minX; x < maxX; x++) for (let y = minY; y < maxY; y++) cells[x * cellsY + y]! += 1;
  }
  return cells;
}

describe('W01: fixed test map with 4 human players (players = 5, 0 = Gaia, 1..4 = humans)', () => {
  test('startingUnits(5) and startingObjects(5) spawn 4 distinct bases with TC, 3 villagers and Gaia resources, no modulo wrap', () => {
    const units = startingUnits(5);
    expect(units).toHaveLength(12);
    for (const p of [1, 2, 3, 4]) {
      expect(units.filter((u) => u.owner === p && u.type === VILLAGER)).toHaveLength(3);
    }

    const objects = startingObjects(5);
    // Per player: 3 villagers + 1 TC = 4 (16 total). Per base Gaia: 8 trees + 3 forage + 2 gold + 1 stone + 1 gazelle + 1 elephant = 16 (64 total).
    expect(objects).toHaveLength(80);
    expect(objects.filter((o) => o.owner === 0)).toHaveLength(64);
    expect(objects.filter((o) => o.owner === 0 && (TREES as readonly number[]).includes(o.type))).toHaveLength(32);
    expect(objects.filter((o) => o.owner === 0 && o.type === FORAGE)).toHaveLength(12);
    expect(objects.filter((o) => o.owner === 0 && o.type === MINE_GOLD)).toHaveLength(8);
    expect(objects.filter((o) => o.owner === 0 && o.type === MINE_STONE)).toHaveLength(4);
    expect(objects.filter((o) => o.owner === 0 && o.type === GAZELLE)).toHaveLength(4);
    expect(objects.filter((o) => o.owner === 0 && o.type === ELEPHANT)).toHaveLength(4);

    // All coordinates fit strictly inside the 48x48 test map without clamping/wrapping onto the border.
    for (const o of objects) {
      expect(o.x).toBeGreaterThanOrEqual(0);
      expect(o.x).toBeLessThan(TEST_MAP_SIZE);
      expect(o.y).toBeGreaterThanOrEqual(0);
      expect(o.y).toBeLessThan(TEST_MAP_SIZE);
    }

    const w = new World({ players: 5, randomSeed: 14, units: objects });
    const tcs = [1, 2, 3, 4].map((p) => {
      const own = [...w.entities.ofPlayer(p)];
      const tc = own.filter((e) => e.type === TOWN_CENTER);
      const vills = own.filter((e) => e.type === VILLAGER);
      expect(tc).toHaveLength(1);
      expect(vills).toHaveLength(3);
      return tc[0]!;
    });

    // All 4 TCs are distinct and well separated across the map.
    const tcKeys = new Set(tcs.map((tc) => `${Math.trunc(tc.x)},${Math.trunc(tc.y)}`));
    expect(tcKeys.size).toBe(4);
    for (let i = 0; i < tcs.length; i++) {
      for (let j = i + 1; j < tcs.length; j++) {
        const dist = Math.max(Math.abs(tcs[i]!.x - tcs[j]!.x), Math.abs(tcs[i]!.y - tcs[j]!.y));
        expect(dist).toBeGreaterThanOrEqual(15);
      }
    }

    // Every placed object sits on passable land terrain and no two starting footprints overlap on the obstruction map.
    for (const e of w.entities.all()) {
      const terrain = w.map.terrainAt(toInt(e.x), toInt(e.y));
      expect(unitType(e.type).terrainTable[terrain]).toBeGreaterThan(0);
    }
    expect(w.pathing.cells).toEqual(expectedCells(w));
    expect(Math.max(...w.pathing.cells)).toBeLessThanOrEqual(1);
  });

  test('lobbyWorldOptions with 4 human civs builds players=5 with Gaia at index 0 and slot+1 owners', () => {
    const options = lobbyWorldOptions(42, DEFAULT_GAME_SETTINGS, [1, 2, 3, 4], true);
    expect(options.players).toBe(5);
    expect(options.civs).toEqual([0, 1, 2, 3, 4]);
    const w = new World(options);
    expect(w.players).toBe(5);
    expect([...w.civs]).toEqual([0, 1, 2, 3, 4]);
    expect(w.playerStatus(0)).toBe(0);
    for (const p of [1, 2, 3, 4]) {
      expect(w.playerStatus(p)).toBe(0);
      expect([...w.entities.ofPlayer(p)]).toHaveLength(4);
    }
  });
});

describe('W03: Gaia + owners 1..4 ownership and LOS isolation', () => {
  test('each human player sees only its own base; Gaia resource vision is not shared', () => {
    const w = new World({ players: 5, randomSeed: 7, units: startingObjects(5) });
    expect(w.visibility.explored[0]).toBeGreaterThan(0);
    for (let player = 0; player < 5; player++) expect(w.visibility.mutualVisible[player]).toBe(1 << player);
    const tcs = [1, 2, 3, 4].map((p) => [...w.entities.ofPlayer(p)].find((e) => e.type === TOWN_CENTER)!);
    for (let p = 1; p <= 4; p++) {
      expect(w.visibility.explored[p]).toBeGreaterThan(0);
      for (let q = 1; q <= 4; q++) {
        const tc = tcs[q - 1]!;
        const vis = w.tileVisibility(p, toInt(tc.x), toInt(tc.y));
        expect(vis).toBe(p === q ? TILE_VISIBLE : TILE_BLACK);
      }
    }
  });

  test('commands issued by player p cannot move, queue, or cancel units owned by q !== p (including Gaia)', () => {
    const w = new World({ players: 5, randomSeed: 7, units: startingObjects(5) });
    const p1Vill = [...w.entities.ofPlayer(1)].find((e) => e.type === VILLAGER)!;
    const p2Tc = [...w.entities.ofPlayer(2)].find((e) => e.type === TOWN_CENTER)!;
    const p3Vill = [...w.entities.ofPlayer(3)].find((e) => e.type === VILLAGER)!;
    const p4Tc = [...w.entities.ofPlayer(4)].find((e) => e.type === TOWN_CENTER)!;
    const gaiaTree = [...w.entities.ofPlayer(0)].find((e) => (TREES as readonly number[]).includes(e.type))!;

    const p1Pos = [p1Vill.x, p1Vill.y];
    const p3Pos = [p3Vill.x, p3Vill.y];
    const p2FoodBefore = w.attributes[2]![ATTR_FOOD]!;
    const p4FoodBefore = w.attributes[4]![ATTR_FOOD]!;

    // Player 4 tries to control P1's villager, P2's TC, and Gaia's tree.
    w.addBatch(0, 4, [
      { type: 'move', units: [p1Vill.id], x: 24.5, y: 24.5 },
      { type: 'queue', building: p2Tc.id, unit: VILLAGER, count: 1 },
      { type: 'cancel', target: p3Vill.id },
      { type: 'cancel', target: gaiaTree.id },
    ]);
    // Player 3 queues a villager at its own TC and moves its own villager.
    w.addBatch(0, 3, [
      { type: 'move', units: [p3Vill.id], x: p3Vill.x - 2, y: p3Vill.y - 2 },
      { type: 'queue', building: p4Tc.id, unit: VILLAGER, count: 1 },
    ]);

    // Applying the batch and advancing its movement action are separate sim steps.
    for (let i = 0; i < COMMAND_DELAY_TURNS + 8; i++) w.runTurn();

    expect([p1Vill.x, p1Vill.y]).toEqual(p1Pos);
    expect(p2Tc.queue).toEqual([]);
    expect(w.attributes[2]![ATTR_FOOD]).toBe(p2FoodBefore);
    expect(p4Tc.queue).toEqual([]);
    expect(w.attributes[4]![ATTR_FOOD]).toBe(p4FoodBefore);
    expect(p3Vill.state).toBe(2);
    expect(gaiaTree.state).toBe(2);
    expect([p3Vill.x, p3Vill.y]).not.toEqual(p3Pos);
  });

  test('each player 1..4 independently queues training and pays only from its own stockpile', () => {
    const w = new World({ players: 5, randomSeed: 9, units: startingObjects(5) });
    const p3Tc = [...w.entities.ofPlayer(3)].find((e) => e.type === TOWN_CENTER)!;
    w.addBatch(0, 3, [{ type: 'queue', building: p3Tc.id, unit: VILLAGER, count: 1 }]);
    for (let i = 0; i <= COMMAND_DELAY_TURNS; i++) w.runTurn();
    expect(w.attributes[1]![ATTR_FOOD]).toBe(200);
    expect(w.attributes[2]![ATTR_FOOD]).toBe(200);
    expect(w.attributes[3]![ATTR_FOOD]).toBe(150);
    expect(w.attributes[4]![ATTR_FOOD]).toBe(200);
    expect(p3Tc.train?.unit ?? p3Tc.queue?.[0]?.unit).toBe(VILLAGER);
  });
});

describe('W05: 4-player syncChecksum and JSON snapshot fidelity', () => {
  test('syncChecksum agrees on twin 4-player worlds and detects changes to any player 1..4', () => {
    const opts = { players: 5, randomSeed: 123, units: startingObjects(5) };
    const a = new World(opts);
    const b = new World(opts);
    for (let t = 0; t < 5; t++) {
      a.runTurn();
      b.runTurn();
    }
    const base = a.syncChecksum();
    expect(b.syncChecksum()).toBe(base);

    for (const p of [1, 2, 3, 4]) {
      a.attributes[p]![ATTR_FOOD]! += 1;
      expect(a.syncChecksum()).not.toBe(base);
      a.attributes[p]![ATTR_FOOD]! -= 1;
      expect(a.syncChecksum()).toBe(base);
    }
  });

  test('JSON snapshot preserves all 5 player slots and produces identical future hashes after restore', () => {
    const w = new World({ players: 5, randomSeed: 321, civs: [0, 1, 5, 10, 16], units: startingObjects(5) });
    for (const p of [1, 2, 3, 4]) {
      const vill = [...w.entities.ofPlayer(p)].find((e) => e.type === VILLAGER)!;
      w.addBatch(0, p, [{ type: 'move', units: [vill.id], x: 24.5, y: 24.5 }]);
    }
    for (let t = 0; t < 6; t++) w.runTurn();

    const json = JSON.parse(JSON.stringify(w.snapshot())) as Snapshot;
    const restored = World.restore(json);
    expect(restored.players).toBe(5);
    expect([...restored.civs]).toEqual([0, 1, 5, 10, 16]);
    expect(restored.attributes).toHaveLength(5);
    expect(restored.victory.status).toHaveLength(5);
    expect(restored.diplomacy.relations).toHaveLength(5);
    expect(restored.hash()).toBe(w.hash());

    for (let t = 0; t < 10; t++) {
      w.runTurn();
      restored.runTurn();
      expect(restored.hash()).toBe(w.hash());
    }
  });
});
