import { describe, expect, test } from 'vitest';
import { DEFAULT_GAME_SETTINGS, LOBBY_MAP_TYPES, lobbyWorldOptions } from './game-settings';
import { toInt } from './num';
import {
  MAP_ALL_LAND,
  MAP_CONTINENTAL,
  MAP_HILLY,
  MAP_LAKE,
  MAP_LARGE,
  MAP_MEDIUM,
  MAP_MOSTLY_LAND,
  MAP_SMALL,
  MAP_TINY,
  RmmController,
} from './rmm-controller';
import { rmmFixture } from './rmm-testing';
import { FORAGE, MINE_GOLD, MINE_STONE, TOWN_CENTER, unitType, VILLAGER } from './units';
import { AGE_NOMAD, World } from './world';

const tile = (x: number, y: number) => [toInt(x), toInt(y)] as const;

describe('W02: RmmController with 4 human players', () => {
  test('RmmController.init creates 4 distinct in-bounds land points for players 1..4 across all 9 map types', () => {
    for (const type of LOBBY_MAP_TYPES) {
      const { m } = rmmFixture(MAP_SMALL, MAP_SMALL, 101 + type);
      const c = new RmmController(m, { type, players: 4, fixedPositions: true, nomad: false, allied: () => false });
      c.init();
      const playerLands = c.objects.lands.filter((l) => l.player >= 1 && l.player <= 4);
      expect(playerLands.map((l) => l.player), `map type ${type}`).toEqual([1, 2, 3, 4]);
      const coords = new Set(playerLands.map((l) => `${l.x},${l.y}`));
      expect(coords.size, `map type ${type}`).toBe(4);
      for (const l of playerLands) {
        expect(l.x).toBeGreaterThanOrEqual(0);
        expect(l.x).toBeLessThan(MAP_SMALL);
        expect(l.y).toBeGreaterThanOrEqual(0);
        expect(l.y).toBeLessThan(MAP_SMALL);
      }
    }
  });
});

describe('W02: seeded random map generation for 4 human players (players = 5)', () => {
  test('every map type (0..8) spawns 1 TC and 3 Villagers per player 1..4 on Tiny maps with non-overlapping land footprints', () => {
    for (const type of LOBBY_MAP_TYPES) {
      const w = new World({ players: 5, randomSeed: 888 + type, randomMap: { type, size: MAP_TINY } });
      const objects = [...w.entities.all()];
      const tcs: { owner: number; x: number; y: number }[] = [];
      for (const p of [1, 2, 3, 4]) {
        const tc = objects.filter((e) => e.owner === p && e.type === TOWN_CENTER);
        const vills = objects.filter((e) => e.owner === p && e.type === VILLAGER);
        expect(tc, `type ${type} player ${p}`).toHaveLength(1);
        expect(vills, `type ${type} player ${p}`).toHaveLength(3);
        const center = tc[0]!;
        const terrain = w.map.terrainAt(toInt(center.x), toInt(center.y));
        expect(unitType(TOWN_CENTER).terrainTable[terrain], `type ${type} player ${p} TC terrain`).toBeGreaterThan(0);
        for (const v of vills) {
          const vt = w.map.terrainAt(toInt(v.x), toInt(v.y));
          expect(unitType(VILLAGER).terrainTable[vt], `type ${type} player ${p} villager terrain`).toBeGreaterThan(0);
        }
        tcs.push({ owner: p, x: center.x, y: center.y });
      }
      // Verify 4 distinct, non-overlapping TC footprints.
      for (let i = 0; i < tcs.length; i++) {
        for (let j = i + 1; j < tcs.length; j++) {
          const dist = Math.max(Math.abs(tcs[i]!.x - tcs[j]!.x), Math.abs(tcs[i]!.y - tcs[j]!.y));
          expect(dist, `type ${type} players ${i + 1}&${j + 1}`).toBeGreaterThanOrEqual(8);
        }
      }
    }
  }, 30_000);

  test('Mostly Land Large (multiplayer default) gives all 4 players starting resources within expected radius', () => {
    for (const seed of [101, 20261115]) {
      const w = new World({ players: 5, randomSeed: seed, randomMap: { type: MAP_MOSTLY_LAND, size: MAP_LARGE } });
      const objects = [...w.entities.all()];
      for (const p of [1, 2, 3, 4]) {
        const tc = objects.find((e) => e.owner === p && e.type === TOWN_CENTER)!;
        const [cx, cy] = tile(tc.x, tc.y);
        const dist = (x: number, y: number) => Math.max(Math.abs(toInt(x) - cx), Math.abs(toInt(y) - cy));
        const within = (type: number, max: number) => objects.filter((e) => e.type === type && dist(e.x, e.y) <= max);
        expect(within(FORAGE, 19).length, `seed ${seed} player ${p} forage`).toBeGreaterThanOrEqual(5);
        expect(within(MINE_GOLD, 37).length, `seed ${seed} player ${p} gold`).toBeGreaterThanOrEqual(8);
        expect(within(MINE_STONE, 37).length, `seed ${seed} player ${p} stone`).toBeGreaterThanOrEqual(7);
      }
    }
  }, 30_000);

  test('All Land and Mostly Land connect all 4 players in the villager land/shallows zone map (reachability)', () => {
    for (const [type, size, seed] of [
      [MAP_ALL_LAND, MAP_SMALL, 501],
      [MAP_MOSTLY_LAND, MAP_MEDIUM, 502],
      [MAP_HILLY, MAP_MEDIUM, 503],
    ] as const) {
      const w = new World({ players: 5, randomSeed: seed, randomMap: { type, size } });
      const zones = w.pathing.zones.of(unitType(VILLAGER));
      const playerZones = [1, 2, 3, 4].map((p) => {
        const vill = [...w.entities.ofPlayer(p)].find((e) => e.type === VILLAGER)!;
        return zones.at(w.map.width, toInt(vill.x), toInt(vill.y));
      });
      expect(new Set(playerZones).size, `type ${type} seed ${seed}`).toBe(1);
    }
  }, 30_000);

  test('Continental and Lake Medium maps spawn 4 players deterministically and distinct by seed', () => {
    for (const type of [MAP_CONTINENTAL, MAP_LAKE]) {
      const a = new World({ players: 5, randomSeed: 707, randomMap: { type, size: MAP_MEDIUM } });
      const b = new World({ players: 5, randomSeed: 707, randomMap: { type, size: MAP_MEDIUM } });
      const c = new World({ players: 5, randomSeed: 708, randomMap: { type, size: MAP_MEDIUM } });
      expect(a.hash()).toBe(b.hash());
      expect(c.hash()).not.toBe(a.hash());
      for (const p of [1, 2, 3, 4]) {
        expect([...a.entities.ofPlayer(p)].filter((e) => e.type === TOWN_CENTER)).toHaveLength(1);
        expect([...a.entities.ofPlayer(p)].filter((e) => e.type === VILLAGER)).toHaveLength(3);
      }
    }
  }, 30_000);

  test('Nomad starting age gives each of the 4 players 1 Villager and 0 Town Centers', () => {
    const opts = lobbyWorldOptions(909, { ...DEFAULT_GAME_SETTINGS, mapSize: MAP_SMALL, startingAge: AGE_NOMAD }, [1, 2, 3, 4]);
    const w = new World(opts);
    for (const p of [1, 2, 3, 4]) {
      const own = [...w.entities.ofPlayer(p)];
      expect(own.filter((e) => e.type === TOWN_CENTER)).toHaveLength(0);
      expect(own.filter((e) => e.type === VILLAGER)).toHaveLength(1);
    }
  });
});
