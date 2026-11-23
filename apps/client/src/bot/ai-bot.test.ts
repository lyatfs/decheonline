import { describe, expect, test } from 'vitest';
import {
  ARCHERY_RANGE,
  ATTR_FOOD,
  ATTR_GOLD,
  ATTR_HEADROOM,
  ATTR_STONE,
  ATTR_WOOD,
  BARRACKS,
  BRONZE_AGE,
  checkPlacement,
  CLUBMAN,
  COMMAND_DELAY_TURNS,
  ELEPHANT,
  FARM,
  FORAGE,
  GRANARY,
  HOUSE,
  IRON_AGE,
  MARKET,
  master,
  MINE_GOLD,
  ObjectState,
  STABLE,
  startingObjects,
  STORAGE_PIT,
  TECH_DONE,
  TERRAIN_GRASS,
  TERRAIN_WATER,
  TILE_BLACK,
  TileMap,
  toInt,
  TOOL_AGE,
  TOWN_CENTER,
  VICTORY_SPECIAL,
  VILLAGER,
  World,
  type Command,
  type StartUnit,
} from '@aoe/sim';
import { AiBot } from './ai-bot';

const DOCK = 45;
const FISHING_BOAT = 13;
const FISHERMAN = 119;
const FISH_SALMON = 53;
const FISH_SHORE_JUMP = 260;
const GOVERNMENT_CENTER = 82;
const TEMPLE = 104;
const SIEGE_WORKSHOP = 49;
const ACADEMY = 0;
const ATTR_AGE = 6;
const TECH_WOODWORKING = 107;
const TECH_AXEMAN = 63;

function stepWorldWithBot(world: World, bot: AiBot, turns: number, player = 2): Command[] {
  const issued: Command[] = [];
  for (let i = 0; i < turns; i++) {
    if (i % 2 === 0) {
      const cmds = bot.step(world);
      if (cmds.length > 0) {
        issued.push(...cmds);
        world.addBatch(world.turn, player, cmds);
      }
    }
    world.runTurn();
  }
  return issued;
}

function revealArea(world: World, player: number, cx: number, cy: number, radius: number): void {
  world.visibility.exploreRect(player, cx - radius, cy - radius, cx + radius, cy + radius);
}

describe('AiBot — Issue 3.6.1: Visibility & Reachability (pathing.zones)', () => {
  test('ignores TILE_BLACK enemies and isolated-island resources/enemies, and scouts within reachable land zone', () => {
    const w = 48;
    const h = 48;
    const map = new TileMap(w, h);
    for (let x = 0; x < w; x++) {
      for (let y = 0; y < h; y++) {
        // Water channel x = 20..24 splits west mainland (0..19) from east island (25..47)
        map.setTile(x, y, x >= 20 && x <= 24 ? TERRAIN_WATER : TERRAIN_GRASS);
      }
    }

    const units: StartUnit[] = [
      // Player 2 (bot) on west mainland
      { owner: 2, type: TOWN_CENTER, x: 10.5, y: 10.5 },
      { owner: 2, type: HOUSE, x: 5.5, y: 10.5 },
      { owner: 2, type: VILLAGER, x: 8.5, y: 10.5 },
      { owner: 2, type: VILLAGER, x: 9.5, y: 10.5 },
      { owner: 2, type: VILLAGER, x: 8.5, y: 11.5 },
      { owner: 2, type: CLUBMAN, x: 11.5, y: 12.5 },
      // Reachable, visible forage on west mainland
      { owner: 0, type: FORAGE, x: 13.5, y: 10.5 },
      // Isolated island forage & gold (even if explored, unreachable by land)
      { owner: 0, type: FORAGE, x: 35.5, y: 10.5 },
      { owner: 0, type: MINE_GOLD, x: 36.5, y: 12.5 },
      // Enemy villager on mainland far away in TILE_BLACK
      { owner: 1, type: VILLAGER, x: 10.5, y: 42.5 },
      // Enemy soldier on isolated island
      { owner: 1, type: CLUBMAN, x: 35.5, y: 15.5 },
    ];

    const world = new World({ players: 3, map, units, victory: { type: VICTORY_SPECIAL } });
    // Even if the island is revealed, pathing.zones must block targeting it
    revealArea(world, 2, 35, 12, 5);
    // Keep enemy villager at (10, 42) strictly in TILE_BLACK
    expect(world.tileVisibility(2, 10, 42)).toBe(TILE_BLACK);

    const bot = new AiBot('ROOM', 'Bot', 2, 2);
    const cmds = stepWorldWithBot(world, bot, 6, 2);

    const workCmds = cmds.filter((c) => c.type === 'work');
    const attackCmds = cmds.filter((c) => c.type === 'attack');
    const moveCmds = cmds.filter((c) => c.type === 'move');

    const reachableForage = [...world.entities.all()].find((e) => e.type === FORAGE && e.x < 20)!;
    const islandIds = new Set(
      [...world.entities.all()].filter((e) => e.x > 25).map((e) => e.id),
    );
    const hiddenEnemy = [...world.entities.all()].find((e) => e.owner === 1 && e.y > 40)!;

    expect(workCmds.length).toBeGreaterThan(0);
    for (const c of workCmds) {
      if (c.type === 'work') {
        expect(islandIds.has(c.target)).toBe(false);
        expect(c.target).toBe(reachableForage.id);
      }
    }

    // Never attacks TILE_BLACK enemy or isolated island enemy
    for (const c of attackCmds) {
      if (c.type === 'attack') {
        expect(c.target).not.toBe(hiddenEnemy.id);
        expect(islandIds.has(c.target)).toBe(false);
      }
    }
    expect(attackCmds.length).toBe(0);

    // Idle soldier scouts toward an unexplored tile inside its reachable mainland zone (x < 20)
    expect(moveCmds.length).toBeGreaterThan(0);
    const landZones = world.pathing.zones.of(master(world, 2, VILLAGER));
    const mainlandZone = landZones.at(w, 11, 12);
    for (const c of moveCmds) {
      if (c.type === 'move') {
        expect(c.x).toBeLessThan(20);
        expect(landZones.at(w, toInt(c.x), toInt(c.y))).toBe(mainlandZone);
      }
    }
  });
});

describe('AiBot — Issue 3.6.2: Eliminate Attack Command Spam', () => {
  test('does not re-issue attack to units already actively attacking or while command is in transit', () => {
    const map = new TileMap(48, 48);
    const units: StartUnit[] = [
      { owner: 2, type: TOWN_CENTER, x: 8.5, y: 8.5 },
      { owner: 2, type: CLUBMAN, x: 11.5, y: 10.5 }, // Soldier 1: will fight enemyA
      { owner: 2, type: CLUBMAN, x: 10.5, y: 12.5 }, // Soldier 2
      { owner: 2, type: CLUBMAN, x: 11.5, y: 12.5 }, // Soldier 3
      { owner: 2, type: CLUBMAN, x: 12.5, y: 12.5 }, // Soldier 4
      { owner: 2, type: CLUBMAN, x: 13.5, y: 12.5 }, // Soldier 5
      { owner: 1, type: CLUBMAN, x: 12.5, y: 10.5 }, // enemyA adjacent to Soldier 1
      { owner: 1, type: TOWN_CENTER, x: 20.5, y: 10.5 }, // enemyB
    ];
    const world = new World({ players: 3, map, units, victory: { type: VICTORY_SPECIAL } });
    revealArea(world, 2, 15, 10, 10);

    const botSoldiers = [...world.entities.ofPlayer(2)].filter((e) => e.type === CLUBMAN);
    const soldier1 = botSoldiers[0]!;
    const enemyA = [...world.entities.ofPlayer(1)].find((e) => e.type === CLUBMAN)!;
    const enemyB = [...world.entities.ofPlayer(1)].find((e) => e.type === TOWN_CENTER)!;

    // Order Soldier 1 onto enemyA and advance until Soldier 1 is actively attacking enemyA
    world.addBatch(world.turn, 2, [{ type: 'attack', units: [soldier1.id], target: enemyA.id }]);
    for (let i = 0; i < 6 && (!soldier1.attack || soldier1.attack.target !== enemyA.id); i++) {
      world.runTurn();
    }
    expect(soldier1.attack?.target).toBe(enemyA.id);

    const bot = new AiBot('ROOM', 'Bot', 2, 2);

    // Tick 0: idle soldiers (2..5) may receive attack, but Soldier 1 (actively attacking enemyA) MUST NOT
    const tick0 = bot.step(world);
    const attacks0 = tick0.filter((c): c is Extract<Command, { type: 'attack' }> => c.type === 'attack');
    expect(attacks0.length).toBeGreaterThan(0);
    for (const a of attacks0) {
      expect(a.units).not.toContain(soldier1.id);
    }
    world.addBatch(world.turn, 2, tick0);

    // Advance 2 turns (during COMMAND_DELAY_TURNS transit) and think again
    world.runTurn();
    world.runTurn();
    const tick2 = bot.step(world);
    const attacks2 = tick2.filter((c): c is Extract<Command, { type: 'attack' }> => c.type === 'attack');
    // Neither Soldier 1 nor Soldiers 2..5 (on cooldown / actively moving to target) should be spammed
    expect(attacks2.length).toBe(0);
    expect(soldier1.attack?.target).toBe(enemyA.id);

    // Advance a few more turns while combat continues: still no spam on Soldier 1
    world.runTurn();
    world.runTurn();
    const tick4 = bot.step(world);
    const attacks4 = tick4.filter((c): c is Extract<Command, { type: 'attack' }> => c.type === 'attack');
    for (const a of attacks4) {
      expect(a.units).not.toContain(soldier1.id);
    }

    // Once enemyA dies, Soldier 1 becomes eligible and targets enemyB
    enemyA.hp = 0;
    enemyA.state = ObjectState.Dying;
    for (let i = 0; i < 6; i++) world.runTurn();
    const afterDeath = bot.step(world);
    const attacksAfter = afterDeath.filter((c): c is Extract<Command, { type: 'attack' }> => c.type === 'attack');
    expect(attacksAfter.some((a) => a.units.includes(soldier1.id) && a.target === enemyB.id)).toBe(true);
  });
});

describe('AiBot — Issue 3.6.3: Economy, Buildings, Ages, Upgrades, Elephant & Fishing', () => {
  test('progresses economy, builds 2nd House/Barracks, Market, Farms, advances Tool -> Bronze -> Iron Age, researches upgrades and trains advanced units', () => {
    const world = new World({ players: 3, units: startingObjects(3), victory: { type: VICTORY_SPECIAL } });
    // Grant sufficient starting resources and quickBuild to exercise full progression end-to-end in real sim
    world.attributes[2]![ATTR_FOOD] = 4500;
    world.attributes[2]![ATTR_WOOD] = 3500;
    world.attributes[2]![ATTR_GOLD] = 2500;
    world.attributes[2]![ATTR_STONE] = 600;
    world.cheats.quickBuild = true;

    const bot = new AiBot('ROOM', 'Bot', 2, 2);
    const cmds = stepWorldWithBot(world, bot, 850, 2);

    const p2Entities = [...world.entities.ofPlayer(2)].filter((e) => e.state === ObjectState.Active);
    const countOf = (type: number) => p2Entities.filter((e) => e.type === type).length;

    // Buildings: >= 2 Houses, Granary, Storage Pit, >= 2 Barracks, Market, Farm, Range, Stable, >= 2 Bronze Age buildings
    expect(countOf(HOUSE)).toBeGreaterThanOrEqual(2);
    expect(countOf(GRANARY)).toBeGreaterThanOrEqual(1);
    expect(countOf(STORAGE_PIT)).toBeGreaterThanOrEqual(1);
    expect(countOf(BARRACKS)).toBeGreaterThanOrEqual(2);
    expect(countOf(MARKET)).toBeGreaterThanOrEqual(1);
    expect(countOf(ARCHERY_RANGE)).toBeGreaterThanOrEqual(1);
    expect(countOf(STABLE)).toBeGreaterThanOrEqual(1);
    expect(countOf(FARM)).toBeGreaterThanOrEqual(1);
    const bronzeBuildings =
      countOf(GOVERNMENT_CENTER) + countOf(TEMPLE) + countOf(SIEGE_WORKSHOP) + countOf(ACADEMY);
    expect(bronzeBuildings).toBeGreaterThanOrEqual(2);

    // Ages: Tool -> Bronze -> Iron Age
    expect(world.techs[2]![TOOL_AGE]).toBe(TECH_DONE);
    expect(world.techs[2]![BRONZE_AGE]).toBe(TECH_DONE);
    expect(world.techs[2]![IRON_AGE]).toBe(TECH_DONE);
    expect(world.attributes[2]![ATTR_AGE]).toBe(4);

    // Tech upgrades researched (e.g. Woodworking 107 / Axeman 63)
    const researchCmds = cmds.filter((c): c is Extract<Command, { type: 'research' }> => c.type === 'research');
    expect(researchCmds.some((c) => c.tech === TECH_WOODWORKING || c.tech === TECH_AXEMAN)).toBe(true);

    // Trains advanced units (not just Clubman/Bowman/Scout)
    const queueCmds = cmds.filter((c): c is Extract<Command, { type: 'queue' }> => c.type === 'queue');
    const trainedTypes = new Set(queueCmds.map((c) => c.unit));
    expect(
      trainedTypes.has(75) ||
        trainedTypes.has(5) ||
        trainedTypes.has(37) ||
        trainedTypes.has(93) ||
        trainedTypes.has(35) ||
        trainedTypes.has(338),
    ).toBe(true);
  });

  test('never issues research while a building has an active train or queue, and reaches Tool Age from standard 200F/200W start', () => {
    const world = new World({ players: 3, units: startingObjects(3) });
    const bot = new AiBot('ROOM', 'Bot', 2, 2);

    // Explicitly verify research is NOT issued when TC has a villager queued/training
    const tc = [...world.entities.ofPlayer(2)].find((e) => e.type === TOWN_CENTER)!;
    world.attributes[2]![ATTR_FOOD] = 600;
    world.techs[2]![TOOL_AGE] = 1; // TECH_AVAILABLE
    world.addBatch(world.turn, 2, [{ type: 'queue', building: tc.id, unit: VILLAGER, count: 1 }]);
    for (let i = 0; i <= COMMAND_DELAY_TURNS + 1; i++) world.runTurn();
    expect(tc.train).not.toBeNull();
    const whileTraining = bot.step(world);
    expect(whileTraining.some((c) => c.type === 'research' && c.building === tc.id)).toBe(false);

    // Fresh standard game (200F, 200W, 150S, 0G, quickBuild = false): gathers food > 250 and advances to Tool Age
    const fresh = new World({ players: 3, units: startingObjects(3) });
    const freshBot = new AiBot('ROOM', 'Bot', 2, 2);
    stepWorldWithBot(fresh, freshBot, 1300, 2);
    expect(fresh.techs[2]![TOOL_AGE]).toBe(TECH_DONE);
    expect(fresh.attributes[2]![ATTR_AGE]).toBeGreaterThanOrEqual(2);
  });

  test('does not withhold training or tech upgrades while TC is already actively researching Bronze Age', () => {
    const map = new TileMap(40, 40);
    const units: StartUnit[] = [
      { owner: 2, type: TOWN_CENTER, x: 10.5, y: 10.5 },
      { owner: 2, type: HOUSE, x: 6.5, y: 10.5 },
      { owner: 2, type: HOUSE, x: 6.5, y: 13.5 },
      { owner: 2, type: MARKET, x: 14.5, y: 10.5 },
      { owner: 2, type: BARRACKS, x: 14.5, y: 14.5 },
      { owner: 2, type: VILLAGER, x: 8.5, y: 10.5 },
      { owner: 2, type: VILLAGER, x: 8.5, y: 11.5 },
      { owner: 2, type: VILLAGER, x: 8.5, y: 12.5 },
      { owner: 2, type: VILLAGER, x: 9.5, y: 12.5 },
      { owner: 2, type: VILLAGER, x: 10.5, y: 12.5 },
      { owner: 2, type: VILLAGER, x: 11.5, y: 12.5 },
      { owner: 2, type: VILLAGER, x: 12.5, y: 12.5 },
    ];
    const world = new World({ players: 3, map, units, victory: { type: VICTORY_SPECIAL } });
    const tc = [...world.entities.ofPlayer(2)].find((e) => e.type === TOWN_CENTER)!;
    const barracks = [...world.entities.ofPlayer(2)].find((e) => e.type === BARRACKS)!;
    world.attributes[2]![ATTR_AGE] = 2;
    world.attributes[2]![ATTR_FOOD] = 900;
    world.attributes[2]![ATTR_WOOD] = 400;
    world.attributes[2]![ATTR_HEADROOM] = 10;
    world.techs[2]![TOOL_AGE] = TECH_DONE;
    world.techs[2]![BRONZE_AGE] = 1; // TECH_AVAILABLE

    world.addBatch(world.turn, 2, [{ type: 'research', building: tc.id, tech: BRONZE_AGE }]);
    for (let i = 0; i <= COMMAND_DELAY_TURNS + 1; i++) world.runTurn();
    expect(tc.research?.tech).toBe(BRONZE_AGE);
    expect(world.attributes[2]![ATTR_FOOD]!).toBeLessThan(950);

    // Ensure enough food/wood for Barracks unit training even though food < 950
    world.attributes[2]![ATTR_FOOD] = 300;
    const bot = new AiBot('ROOM', 'Bot', 2, 2);
    const cmds = bot.step(world);
    expect(cmds.some((c) => c.type === 'queue' && c.building === barracks.id)).toBe(true);
  });

  test('hunts Elephant with >= 2 villagers in one group command and harvests food safely', () => {
    const map = new TileMap(40, 40);
    const units: StartUnit[] = [
      { owner: 2, type: TOWN_CENTER, x: 8.5, y: 10.5 },
      { owner: 2, type: VILLAGER, x: 11.5, y: 10.5 },
      { owner: 2, type: VILLAGER, x: 12.5, y: 10.5 },
      { owner: 2, type: VILLAGER, x: 11.5, y: 11.5 },
      { owner: 2, type: VILLAGER, x: 12.5, y: 11.5 },
      { owner: 0, type: ELEPHANT, x: 14.5, y: 11.5 },
    ];
    const world = new World({ players: 3, map, units, victory: { type: VICTORY_SPECIAL } });
    const startFood = world.attributes[2]![ATTR_FOOD]!;
    const elephant = [...world.entities.all()].find((e) => e.type === ELEPHANT)!;

    const bot = new AiBot('ROOM', 'Bot', 2, 2);
    const cmds = stepWorldWithBot(world, bot, 140, 2);
    const huntCmd = cmds.find((c): c is Extract<Command, { type: 'work' }> => c.type === 'work' && c.target === elephant.id);
    expect(huntCmd).toBeDefined();
    expect(huntCmd!.units.length).toBeGreaterThanOrEqual(2);

    for (let i = 0; i < 400 && elephant.state === ObjectState.Active; i++) {
      world.runTurn();
    }
    expect(elephant.state).toBeGreaterThan(ObjectState.Active);

    // Run additional turns for hunters to gather and drop off meat at Town Center
    for (let i = 0; i < 350; i++) world.runTurn();
    const aliveVillagers = [...world.entities.ofPlayer(2)].filter((e) => e.state === ObjectState.Active && e.type !== TOWN_CENTER);
    expect(aliveVillagers.length).toBeGreaterThanOrEqual(2);
    expect(world.attributes[2]![ATTR_FOOD]!).toBeGreaterThan(startFood);
  });

  test('gathers shore fish as Fisherman (119), builds Dock, trains Fishing Boat and fishes deep fish', () => {
    const w = 40;
    const h = 40;
    const map = new TileMap(w, h);
    for (let x = 0; x < w; x++) {
      for (let y = 0; y < h; y++) {
        // Beach at x = 15, Water at x >= 16
        map.setTile(x, y, x >= 16 ? TERRAIN_WATER : x === 15 ? 2 : TERRAIN_GRASS);
      }
    }
    const units: StartUnit[] = [
      { owner: 2, type: TOWN_CENTER, x: 8.5, y: 12.5 },
      { owner: 2, type: HOUSE, x: 5.5, y: 12.5 },
      { owner: 2, type: GRANARY, x: 5.5, y: 16.5 },
      { owner: 2, type: STORAGE_PIT, x: 8.5, y: 17.5 },
      { owner: 2, type: BARRACKS, x: 11.5, y: 17.5 },
      { owner: 2, type: VILLAGER, x: 13.5, y: 10.5 },
      { owner: 2, type: VILLAGER, x: 13.5, y: 11.5 },
      { owner: 2, type: VILLAGER, x: 13.5, y: 12.5 },
      { owner: 2, type: VILLAGER, x: 13.5, y: 13.5 },
      { owner: 2, type: VILLAGER, x: 13.5, y: 14.5 },
      { owner: 2, type: VILLAGER, x: 13.5, y: 15.5 },
      { owner: 0, type: FISH_SHORE_JUMP, x: 16.5, y: 11.5 },
      { owner: 0, type: FISH_SALMON, x: 20.5, y: 11.5 },
    ];
    const world = new World({ players: 3, map, units, victory: { type: VICTORY_SPECIAL } });
    world.attributes[2]![ATTR_WOOD] = 700;
    world.attributes[2]![ATTR_FOOD] = 100;
    world.cheats.quickBuild = true;
    revealArea(world, 2, 16, 12, 8);

    const bot = new AiBot('ROOM', 'Bot', 2, 2);
    const cmds = stepWorldWithBot(world, bot, 220, 2);

    // Villager converts to Fisherman (119) on shore fish
    const fishermen = [...world.entities.ofPlayer(2)].filter((e) => e.type === FISHERMAN && e.state === ObjectState.Active);
    expect(fishermen.length).toBeGreaterThanOrEqual(1);

    // Dock built on shore, Fishing Boat (13) trained and ordered onto deep fish
    const docks = [...world.entities.ofPlayer(2)].filter((e) => e.type === DOCK && e.state === ObjectState.Active);
    expect(docks.length).toBeGreaterThanOrEqual(1);
    const boats = [...world.entities.ofPlayer(2)].filter((e) => e.type === FISHING_BOAT && e.state === ObjectState.Active);
    expect(boats.length).toBeGreaterThanOrEqual(1);
    const boatWork = cmds.some((c) => c.type === 'work' && boats.some((b) => c.units.includes(b.id)));
    expect(boatWork).toBe(true);
  });
});

describe('AiBot — Issue 3.6.4: Robust findPlacement()', () => {
  test('places House outside congested radius > 16 when area around Town Center is completely blocked', () => {
    const w = 64;
    const h = 64;
    const map = new TileMap(w, h);
    const cx = 30;
    const cy = 30;

    const units: StartUnit[] = [
      { owner: 2, type: TOWN_CENTER, x: cx + 0.5, y: cy + 0.5 },
      { owner: 2, type: VILLAGER, x: cx - 2.5, y: cy + 0.5 },
    ];

    // Block all tiles within Chebyshev distance 3..16 around TC with water except a 1-tile walking bridge on east side
    for (let x = cx - 16; x <= cx + 16; x++) {
      for (let y = cy - 16; y <= cy + 16; y++) {
        if (Math.abs(x - cx) <= 2 && Math.abs(y - cy) <= 2) continue;
        if (x === cx - 3 && y === cy) continue; // Villager tile
        // Leave a 1-tile walking corridor at y === cy on the east side so landZones connects outside (too narrow for 2x2 House!)
        if (y === cy && x > cx + 2) continue;
        map.setTile(x, y, TERRAIN_WATER);
      }
    }

    const world = new World({ players: 3, map, units, victory: { type: VICTORY_SPECIAL } });
    world.attributes[2]![ATTR_WOOD] = 200;
    world.attributes[2]![ATTR_HEADROOM] = 1;
    // Reveal outer open land ring (distance 18..24) so visibleTo = this.player passes
    revealArea(world, 2, cx, cy, 24);

    const bot = new AiBot('ROOM', 'Bot', 2, 2);
    const cmds = bot.step(world);
    const buildHouse = cmds.find((c): c is Extract<Command, { type: 'build' }> => c.type === 'build' && c.unitType === HOUSE);

    expect(buildHouse).toBeDefined();
    expect(
      Math.max(Math.abs(buildHouse!.x - (cx + 0.5)), Math.abs(buildHouse!.y - (cy + 0.5))),
    ).toBeGreaterThan(16);

    // Confirm checkPlacement passes with visibleTo = 2 and World creates the House foundation
    const houseMaster = master(world, 2, HOUSE);
    expect(checkPlacement(world.gameContext(), houseMaster, buildHouse!.x, buildHouse!.y, true, true, 2)).toBe(0);

    world.addBatch(world.turn, 2, cmds);
    for (let i = 0; i <= COMMAND_DELAY_TURNS; i++) world.runTurn();
    const houses = [...world.entities.ofPlayer(2)].filter((e) => e.type === HOUSE);
    expect(houses.length).toBe(1);
  });

  test('finds an odd-offset 2x2 gap close to Town Center via step-1 fallback', () => {
    const map = new TileMap(40, 40);
    const cx = 20;
    const cy = 20;
    const units: StartUnit[] = [
      { owner: 2, type: TOWN_CENTER, x: cx + 0.5, y: cy + 0.5 },
      { owner: 2, type: VILLAGER, x: cx - 2.5, y: cy + 0.5 },
    ];
    // Surround TC on all tiles from distance 3..38 EXCEPT a 2x2 odd-aligned pocket at (25, 25) -> House center (26, 26)
    for (let x = 2; x < 38; x++) {
      for (let y = 2; y < 38; y++) {
        if (Math.abs(x - cx) <= 2 && Math.abs(y - cy) <= 2) continue;
        if (x === cx - 3 && y === cy) continue;
        if (y === cy && x > cx + 2 && x <= 25) continue;
        if (x === 25 && y >= cy && y <= 26) continue;
        if (x >= 25 && x <= 26 && y >= 25 && y <= 26) continue;
        map.setTile(x, y, TERRAIN_WATER);
      }
    }

    const world = new World({ players: 3, map, units, victory: { type: VICTORY_SPECIAL } });
    world.attributes[2]![ATTR_WOOD] = 200;
    world.attributes[2]![ATTR_HEADROOM] = 1;
    revealArea(world, 2, 26, 26, 4);

    const bot = new AiBot('ROOM', 'Bot', 2, 2);
    const cmds = bot.step(world);
    const buildHouse = cmds.find((c): c is Extract<Command, { type: 'build' }> => c.type === 'build' && c.unitType === HOUSE);
    expect(buildHouse).toBeDefined();
    expect(buildHouse!.x).toBe(26);
    expect(buildHouse!.y).toBe(26);
  });
});
