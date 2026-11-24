import { describe, expect, test, vi } from 'vitest';
import {
  ALLIGATOR,
  ATTR_FOOD,
  ATTR_GOLD,
  ATTR_STONE,
  ATTR_WOOD,
  BARRACKS,
  BOWMAN,
  CLUBMAN,
  doTech,
  ELEPHANT,
  FARM,
  FORAGE,
  GAZELLE,
  HOUSE,
  LION,
  MINE_GOLD,
  MINE_STONE,
  ObjectState,
  SMALL_WALL,
  TECH_DONE,
  TERRAIN_GRASS,
  TERRAIN_WATER,
  TILE_BLACK,
  TILE_FOGGED,
  TILE_VISIBLE,
  TileMap,
  TOWN_CENTER,
  TREES,
  VICTORY_SPECIAL,
  VILLAGER,
  World,
  type StartUnit,
} from '@aoe/sim';
import { createBotObservation, createEmptyBotMemory } from './observation';
import { BOT_CONTRACT_VERSION } from './types';

const DOCK = 45;
const FISHING_BOAT = 13;
const WAR_BOAT = 19;
const FISH_SALMON = 53;
const TERRAIN_BEACH = 2;
const TERRAIN_SHALLOWS = 4;
const TECH_AXEMAN = 63;

function makeGrassMap(size = 48): TileMap {
  return new TileMap(size, size);
}

function makeSplitIslandMap(size = 48): TileMap {
  const map = new TileMap(size, size);
  for (let x = 0; x < size; x++) {
    for (let y = 0; y < size; y++) {
      if (x >= 20 && x <= 24) map.setTile(x, y, TERRAIN_WATER);
      else if (x === 19 || x === 25) map.setTile(x, y, TERRAIN_BEACH);
      else map.setTile(x, y, TERRAIN_GRASS);
    }
  }
  return map;
}

describe('T01 P01 — Strict Fog-of-War DTO, own units/buildings, masters & read-only purity', () => {
  test('never exposes TILE_BLACK enemies or resources and populates DTO fields accurately without mutating World', () => {
    const map = makeGrassMap(48);
    const units: StartUnit[] = [
      { owner: 2, type: TOWN_CENTER, x: 10.5, y: 10.5 },
      { owner: 2, type: VILLAGER, x: 8.5, y: 10.5 },
      { owner: 2, type: CLUBMAN, x: 11.5, y: 12.5 },
      { owner: 2, type: BARRACKS, x: 14.5, y: 10.5 },
      { owner: 2, type: FARM, x: 8.5, y: 14.5 },
      // Visible near TC
      { owner: 0, type: FORAGE, x: 12.5, y: 10.5 },
      { owner: 1, type: CLUBMAN, x: 13.5, y: 12.5 },
      // Strictly in TILE_BLACK far away
      { owner: 0, type: MINE_GOLD, x: 42.5, y: 42.5 },
      { owner: 0, type: GAZELLE, x: 40.5, y: 42.5 },
      { owner: 1, type: VILLAGER, x: 42.5, y: 40.5 },
      { owner: 1, type: TOWN_CENTER, x: 40.5, y: 40.5 },
    ];
    const world = new World({ players: 3, map, units, victory: { type: VICTORY_SPECIAL } });

    // Create an unbuilt House so we verify isUnbuilt
    const unbuiltHouse = world.createObject(2, HOUSE, 6.5, 10.5, 0);
    expect(unbuiltHouse.state).toBe(ObjectState.Unbuilt);

    // Queue a Clubman in Barracks and advance 1 turn so Farm starts makeTimer
    const barracks = [...world.entities.ofPlayer(2)].find((e) => e.type === BARRACKS)!;
    world.addBatch(world.turn, 2, [{ type: 'queue', building: barracks.id, unit: CLUBMAN, count: 2 }]);
    for (let i = 0; i < 4; i++) world.runTurn();

    expect(world.tileVisibility(2, 42, 42)).toBe(TILE_BLACK);
    expect(world.tileVisibility(2, 40, 40)).toBe(TILE_BLACK);

    const dateSpy = vi.spyOn(Date, 'now').mockImplementation(() => {
      throw new Error('Date.now must not be called');
    });
    const randSpy = vi.spyOn(Math, 'random').mockImplementation(() => {
      throw new Error('Math.random must not be called');
    });

    try {
      const hashBefore = world.hash();
      const seedBefore = world.randomSeed;

      const { observation: obs } = createBotObservation(world, 2);

      expect(obs.contractVersion).toBe(BOT_CONTRACT_VERSION);
      expect(obs.player).toBe(2);
      expect(obs.turn).toBe(world.turn);
      expect(obs.worldTime).toBe(world.worldTime);
      expect(obs.mapWidth).toBe(48);
      expect(obs.mapHeight).toBe(48);
      expect(obs.resources.food).toBe(world.attributes[2]![ATTR_FOOD]);
      expect(obs.resources.wood).toBe(world.attributes[2]![ATTR_WOOD]);
      expect(obs.resources.stone).toBe(world.attributes[2]![ATTR_STONE]);
      expect(obs.resources.gold).toBe(world.attributes[2]![ATTR_GOLD]);

      // No raw world.entities leakage
      expect((obs as unknown as Record<string, unknown>)['entities']).toBeUndefined();

      // TILE_BLACK entities must NOT appear
      expect(obs.knownResources.some((r) => r.x > 35)).toBe(false);
      expect(obs.knownEnemies.some((e) => e.x > 35)).toBe(false);

      // Visible ones DO appear
      expect(obs.knownResources.some((r) => r.type === FORAGE && r.visibleNow)).toBe(true);
      expect(obs.knownEnemies.some((e) => e.type === CLUBMAN && e.visibleNow)).toBe(true);

      // Own buildings: Farm makeTimer, unbuilt House, queued Barracks
      const obsFarm = obs.ownBuildings.find((b) => b.type === FARM);
      expect(obsFarm).toBeDefined();
      expect(obsFarm!.makeTimer).not.toBeNull();
      expect(obsFarm!.makeTimer!).toBeGreaterThan(0);
      expect(obsFarm!.isUnbuilt).toBe(false);

      const obsHouse = obs.ownBuildings.find((b) => b.id === unbuiltHouse.id);
      expect(obsHouse).toBeDefined();
      expect(obsHouse!.isUnbuilt).toBe(true);

      const obsBarracks = obs.ownBuildings.find((b) => b.id === barracks.id);
      expect(obsBarracks).toBeDefined();
      expect(obsBarracks!.queueLength).toBeGreaterThanOrEqual(1);
      expect(obsBarracks!.queuedUnits.length).toBeGreaterThanOrEqual(1);
      expect(obsBarracks!.isBusy).toBe(true);

      // Own units classification
      const obsVillager = obs.ownUnits.find((u) => u.type === VILLAGER);
      expect(obsVillager?.isVillager).toBe(true);
      expect(obsVillager?.isMilitary).toBe(false);
      expect(obsVillager?.isNaval).toBe(false);

      const obsClubman = obs.ownUnits.find((u) => u.type === CLUBMAN);
      expect(obsClubman?.isVillager).toBe(false);
      expect(obsClubman?.isMilitary).toBe(true);
      expect(obsClubman?.isNaval).toBe(false);

      // Zero mutation of world state or RNG during observation & queries
      expect(obs.canReach(obsVillager!.id, 14.5, 10.5, 2.5, true)).toBe(true);
      expect(obs.findBuildPlacement(HOUSE, 10.5, 10.5, 16, obsVillager!.id)).not.toBeNull();
      expect(obs.findNearestExploreTarget(obsVillager!.id, 123)).not.toBeNull();
      expect(world.hash()).toBe(hashBefore);
      expect(world.randomSeed).toBe(seedBefore);

      // enabledMasters reflects copyObj-mutated stats
      doTech(world.gameContext(), 2, TECH_AXEMAN);
      const hashAfterUpgrade = world.hash();
      const { observation: obsAfterUpgrade } = createBotObservation(world, 2);
      expect(obsAfterUpgrade.techStates[TECH_AXEMAN]).toBe(TECH_DONE);
      expect(obsAfterUpgrade.enabledMasters[CLUBMAN]?.hitPoints).toBe(world.masters[2]![CLUBMAN]!.hitPoints);
      expect(obsAfterUpgrade.enabledMasters[CLUBMAN]?.hitPoints).toBeGreaterThan(obs.enabledMasters[CLUBMAN]!.hitPoints);
      expect(obsAfterUpgrade.enabledMasters[CLUBMAN]?.combat?.attacks).toEqual(
        world.masters[2]![CLUBMAN]!.combat?.attacks,
      );
      expect(obsAfterUpgrade.enabledMasters[BOWMAN]?.enabled).toBe(world.masters[2]![BOWMAN]!.enabled);
      expect(world.hash()).toBe(hashAfterUpgrade);
    } finally {
      dateSpy.mockRestore();
      randSpy.mockRestore();
    }
  });
});

describe('T01 P02 & P03 — Isolated island, actor-specific reachability, placement & scouting', () => {
  test('distinguishes land villager vs boat terrain restrictions and blocks isolated island targets', () => {
    const map = makeSplitIslandMap(48);
    const units: StartUnit[] = [
      { owner: 2, type: TOWN_CENTER, x: 10.5, y: 10.5 },
      { owner: 2, type: VILLAGER, x: 18.5, y: 10.5 }, // near west beach
      { owner: 2, type: FISHING_BOAT, x: 22.5, y: 10.5 }, // in water channel
      { owner: 2, type: WAR_BOAT, x: 22.5, y: 15.5 }, // in water channel
      // Fish in water channel
      { owner: 0, type: FISH_SALMON, x: 22.5, y: 20.5 },
      // Fish in hidden TILE_BLACK water pond far south? No, let's keep a second pond below
      // Forage on east island (explored but unreachable by land!)
      { owner: 0, type: FORAGE, x: 35.5, y: 10.5 },
      // Enemy on east island
      { owner: 1, type: CLUBMAN, x: 35.5, y: 14.5 },
    ];
    const world = new World({ players: 3, map, units, victory: { type: VICTORY_SPECIAL } });
    // Reveal the channel and east island
    world.visibility.exploreRect(2, 17, 8, 38, 22);

    const villager = [...world.entities.ofPlayer(2)].find((e) => e.type === VILLAGER)!;
    const fishingBoat = [...world.entities.ofPlayer(2)].find((e) => e.type === FISHING_BOAT)!;
    const warBoat = [...world.entities.ofPlayer(2)].find((e) => e.type === WAR_BOAT)!;

    const { observation: obs } = createBotObservation(world, 2);

    // Villager can reach west mainland, CANNOT reach east island or deep water
    expect(obs.canReach(villager.id, 10.5, 10.5, 1.5)).toBe(true);
    expect(obs.canReach(villager.id, 35.5, 10.5, 1.5)).toBe(false);
    expect(obs.canReach(villager.id, 22.5, 20.5, 1.5)).toBe(false);

    // Ships CAN reach water fish in channel, CANNOT reach inland grass
    expect(obs.canReach(fishingBoat.id, 22.5, 20.5, 1.5)).toBe(true);
    expect(obs.canReach(warBoat.id, 22.5, 20.5, 1.5)).toBe(true);
    expect(obs.canReach(fishingBoat.id, 10.5, 10.5, 0)).toBe(false);
    expect(obs.canReach(warBoat.id, 35.5, 10.5, 0)).toBe(false);

    // Shallows bridge allows villager across water when present
    const shallowsMap = makeSplitIslandMap(48);
    for (let x = 20; x <= 24; x++) shallowsMap.setTile(x, 30, TERRAIN_SHALLOWS);
    const wShallows = new World({
      players: 3,
      map: shallowsMap,
      units: [
        { owner: 2, type: TOWN_CENTER, x: 10.5, y: 30.5 },
        { owner: 2, type: VILLAGER, x: 18.5, y: 30.5 },
        { owner: 2, type: FISHING_BOAT, x: 22.5, y: 25.5 },
      ],
      victory: { type: VICTORY_SPECIAL },
    });
    const vShallows = [...wShallows.entities.ofPlayer(2)].find((e) => e.type === VILLAGER)!;
    const bShallows = [...wShallows.entities.ofPlayer(2)].find((e) => e.type === FISHING_BOAT)!;
    const { observation: obsShallows } = createBotObservation(wShallows, 2);
    expect(obsShallows.canReach(vShallows.id, 35.5, 30.5, 0)).toBe(true);
    expect(obsShallows.canReach(bShallows.id, 22.5, 35.5, 0)).toBe(true); // boats also cross shallows

    // Build & dock placement with actorId stay reachable to actorId
    const buildSpot = obs.findBuildPlacement(HOUSE, 18.5, 10.5, 16, villager.id);
    expect(buildSpot).not.toBeNull();
    expect(buildSpot!.x).toBeLessThan(20);
    expect(obs.canPlaceBuilding(HOUSE, buildSpot!.x, buildSpot!.y)).toBe(true);
    expect(obs.canReach(villager.id, buildSpot!.x, buildSpot!.y, 3)).toBe(true);

    const dockSpot = obs.findDockPlacement(18.5, 10.5, villager.id);
    expect(dockSpot).not.toBeNull();
    expect(dockSpot!.x).toBeGreaterThanOrEqual(19);
    expect(dockSpot!.x).toBeLessThan(25);
    expect(obs.canPlaceBuilding(DOCK, dockSpot!.x, dockSpot!.y)).toBe(true);
    expect(obs.canReach(villager.id, dockSpot!.x, dockSpot!.y, 2.5)).toBe(true);

    // Deterministic scouting returns reachable TILE_BLACK for each actor's passability
    const landExploreA = obs.findNearestExploreTarget(villager.id, 42);
    const landExploreB = obs.findNearestExploreTarget(villager.id, 42);
    expect(landExploreA).toEqual(landExploreB);
    expect(landExploreA).not.toBeNull();
    expect(landExploreA!.x).toBeLessThan(20);
    expect(obs.isTileExplored(Math.trunc(landExploreA!.x), Math.trunc(landExploreA!.y))).toBe(false);
    expect(obs.canReach(villager.id, landExploreA!.x, landExploreA!.y, 0, true)).toBe(true);

    const seaExplore = obs.findNearestExploreTarget(warBoat.id, 42);
    expect(seaExplore).not.toBeNull();
    expect(seaExplore!.x).toBeGreaterThanOrEqual(20);
    expect(seaExplore!.x).toBeLessThanOrEqual(24);
    expect(obs.isTileExplored(Math.trunc(seaExplore!.x), Math.trunc(seaExplore!.y))).toBe(false);
    expect(obs.canReach(warBoat.id, seaExplore!.x, seaExplore!.y, 0, true)).toBe(true);
  });

  test('findDockPlacement never cheats using TILE_BLACK fish', () => {
    const map = new TileMap(48, 48);
    for (let x = 0; x < 48; x++) {
      for (let y = 0; y < 48; y++) {
        if (x >= 18 && x <= 22 && y >= 5 && y <= 15) map.setTile(x, y, TERRAIN_WATER);
        else if (x >= 17 && x <= 23 && y >= 4 && y <= 16) map.setTile(x, y, TERRAIN_BEACH);
        else if (x >= 35 && x <= 42 && y >= 35 && y <= 42) map.setTile(x, y, TERRAIN_WATER);
        else if (x >= 34 && x <= 43 && y >= 34 && y <= 43) map.setTile(x, y, TERRAIN_BEACH);
        else map.setTile(x, y, TERRAIN_GRASS);
      }
    }
    const units: StartUnit[] = [
      { owner: 2, type: TOWN_CENTER, x: 10.5, y: 10.5 },
      { owner: 2, type: VILLAGER, x: 14.5, y: 10.5 },
      // Only fish is in far south-east pond in TILE_BLACK
      { owner: 0, type: FISH_SALMON, x: 38.5, y: 38.5 },
    ];
    const world = new World({ players: 3, map, units, victory: { type: VICTORY_SPECIAL } });
    world.visibility.exploreRect(2, 8, 4, 24, 17);
    expect(world.tileVisibility(2, 38, 38)).toBe(TILE_BLACK);

    const villager = [...world.entities.ofPlayer(2)].find((e) => e.type === VILLAGER)!;
    const { observation: obs } = createBotObservation(world, 2);
    const dockSpot = obs.findDockPlacement(14.5, 10.5, villager.id);
    // Must place at the visible near pond, never jump to the hidden TILE_BLACK pond
    expect(dockSpot).not.toBeNull();
    expect(dockSpot!.x).toBeLessThan(25);
    expect(dockSpot!.y).toBeLessThan(20);
  });
});

describe('T01 P04 — Mobile vs static fog memory, target death/conversion, zone wrap, dynamic obstacles', () => {
  test('drops mobile enemies and mobile fauna (Gazelle, Elephant, Lion, Alligator) when leaving TILE_VISIBLE or dying', () => {
    const map = makeGrassMap(48);
    const units: StartUnit[] = [
      { owner: 2, type: TOWN_CENTER, x: 10.5, y: 10.5 },
      { owner: 1, type: CLUBMAN, x: 25.5, y: 25.5 },
      { owner: 0, type: GAZELLE, x: 26.5, y: 25.5 },
      { owner: 0, type: ELEPHANT, x: 27.5, y: 25.5 },
      { owner: 0, type: LION, x: 28.5, y: 25.5 },
      { owner: 0, type: ALLIGATOR, x: 29.5, y: 25.5 },
    ];
    const world = new World({ players: 3, map, units, victory: { type: VICTORY_SPECIAL } });

    // Explore area around (27, 25) -> TILE_VISIBLE
    world.visibility.exploreRect(2, 24, 23, 31, 27);
    expect(world.tileVisibility(2, 25, 25)).toBe(TILE_VISIBLE);

    let mem = createEmptyBotMemory();
    const r1 = createBotObservation(world, 2, mem);
    mem = r1.memory;

    expect(r1.observation.knownEnemies.some((e) => e.type === CLUBMAN && e.visibleNow)).toBe(true);
    const resTypes1 = new Map(r1.observation.knownResources.map((r) => [r.type, r]));
    expect(resTypes1.get(GAZELLE)?.visibleNow).toBe(true);
    expect(resTypes1.get(GAZELLE)?.isDangerous).toBe(false);
    expect(resTypes1.get(ELEPHANT)?.visibleNow).toBe(true);
    expect(resTypes1.get(ELEPHANT)?.isDangerous).toBe(true);
    expect(resTypes1.get(LION)?.visibleNow).toBe(true);
    expect(resTypes1.get(LION)?.isDangerous).toBe(true);
    expect(resTypes1.get(ALLIGATOR)?.visibleNow).toBe(true);
    expect(resTypes1.get(ALLIGATOR)?.isDangerous).toBe(true);

    // Now area becomes TILE_FOGGED: ALL mobile targets must vanish immediately!
    world.visibility.unexploreRect(2, 24, 23, 31, 27);
    expect(world.tileVisibility(2, 25, 25)).toBe(TILE_FOGGED);

    const r2 = createBotObservation(world, 2, mem);
    mem = r2.memory;
    expect(r2.observation.knownEnemies.some((e) => e.type === CLUBMAN)).toBe(false);
    expect(r2.observation.knownResources.some((r) => [GAZELLE, ELEPHANT, LION, ALLIGATOR].includes(r.type))).toBe(false);

    // Re-explore -> TILE_VISIBLE again, then kill them while visible -> must NOT remain!
    world.visibility.exploreRect(2, 24, 23, 31, 27);
    for (const e of world.entities.all()) {
      if (e.x > 24 && (e.owner === 1 || [GAZELLE, ELEPHANT, LION, ALLIGATOR].includes(e.type))) {
        e.state = ObjectState.Dead;
        e.hp = 0;
      }
    }
    const r3 = createBotObservation(world, 2, mem);
    expect(r3.observation.knownEnemies.some((e) => e.type === CLUBMAN)).toBe(false);
    expect(r3.observation.knownResources.some((r) => [GAZELLE, ELEPHANT, LION, ALLIGATOR].includes(r.type))).toBe(false);
  });

  test('remembers fogged static buildings/resources without peeking live changes, and reconciles when TILE_VISIBLE returns', () => {
    const map = makeGrassMap(48);
    const units: StartUnit[] = [
      { owner: 2, type: TOWN_CENTER, x: 8.5, y: 8.5 },
      { owner: 1, type: BARRACKS, x: 30.5, y: 30.5 },
      { owner: 1, type: HOUSE, x: 35.5, y: 30.5 },
      { owner: 0, type: MINE_GOLD, x: 30.5, y: 35.5 },
      { owner: 0, type: TREES[0], x: 35.5, y: 35.5 },
    ];
    const world = new World({ players: 3, map, units, victory: { type: VICTORY_SPECIAL } });
    world.runTurn();

    // Scout sees static objects at turn 1
    world.visibility.exploreRect(2, 28, 28, 37, 37);
    const seenTurn = world.turn;
    const r1 = createBotObservation(world, 2, createEmptyBotMemory());
    let mem = r1.memory;

    const barracks = [...world.entities.ofPlayer(1)].find((e) => e.type === BARRACKS)!;
    const house = [...world.entities.ofPlayer(1)].find((e) => e.type === HOUSE)!;
    const gold = [...world.entities.all()].find((e) => e.type === MINE_GOLD)!;
    const tree = [...world.entities.all()].find((e) => e.type === TREES[0])!;

    expect(r1.observation.knownEnemies.find((e) => e.id === barracks.id)?.visibleNow).toBe(true);
    expect(r1.observation.knownEnemies.find((e) => e.id === house.id)?.visibleNow).toBe(true);
    expect(r1.observation.knownResources.find((r) => r.id === gold.id)?.visibleNow).toBe(true);
    expect(r1.observation.knownResources.find((r) => r.id === tree.id)?.visibleNow).toBe(true);

    // Lose sight -> TILE_FOGGED
    world.visibility.unexploreRect(2, 28, 28, 37, 37);
    world.runTurn();

    // While TILE_FOGGED: destroy Barracks, convert House to player 2, deplete Gold, damage Tree
    barracks.state = ObjectState.PendingRemoval;
    barracks.hp = 0;
    house.owner = 2;
    gold.heldAmount = 0;
    gold.state = ObjectState.PendingRemoval;
    tree.heldAmount = 10;

    const r2 = createBotObservation(world, 2, mem);
    mem = r2.memory;

    // Must still report remembered snapshot (never peek live destruction/ownership/depletion while fogged!)
    const fogBarracks = r2.observation.knownEnemies.find((e) => e.id === barracks.id);
    expect(fogBarracks).toBeDefined();
    expect(fogBarracks!.visibleNow).toBe(false);
    expect(fogBarracks!.lastSeenTurn).toBe(seenTurn);

    const fogHouse = r2.observation.knownEnemies.find((e) => e.id === house.id);
    expect(fogHouse).toBeDefined();
    expect(fogHouse!.visibleNow).toBe(false);
    expect(fogHouse!.owner).toBe(1);

    const fogGold = r2.observation.knownResources.find((r) => r.id === gold.id);
    expect(fogGold).toBeDefined();
    expect(fogGold!.visibleNow).toBe(false);
    expect(fogGold!.heldAmount).toBeGreaterThan(0);

    const fogTree = r2.observation.knownResources.find((r) => r.id === tree.id);
    expect(fogTree).toBeDefined();
    expect(fogTree!.visibleNow).toBe(false);
    expect(fogTree!.heldAmount).toBe(75);

    // Return sight -> TILE_VISIBLE: dead barracks, converted house, depleted gold must be purged; tree refreshed!
    world.visibility.exploreRect(2, 28, 28, 37, 37);
    const r3 = createBotObservation(world, 2, mem);

    expect(r3.observation.knownEnemies.find((e) => e.id === barracks.id)).toBeUndefined();
    expect(r3.observation.knownEnemies.find((e) => e.id === house.id)).toBeUndefined();
    expect(r3.observation.knownResources.find((r) => r.id === gold.id)).toBeUndefined();

    const visTree = r3.observation.knownResources.find((r) => r.id === tree.id);
    expect(visTree).toBeDefined();
    expect(visTree!.visibleNow).toBe(true);
    expect(visTree!.heldAmount).toBe(10);
    expect(visTree!.lastSeenTurn).toBe(world.turn);
  });

  test('respects revealMap explored static resources without leaking TILE_BLACK', () => {
    const map = makeGrassMap(48);
    const units: StartUnit[] = [
      { owner: 2, type: TOWN_CENTER, x: 8.5, y: 8.5 },
      { owner: 0, type: MINE_STONE, x: 36.5, y: 36.5 },
      { owner: 1, type: BARRACKS, x: 38.5, y: 38.5 },
    ];
    const world = new World({ players: 3, map, units, revealMap: true, victory: { type: VICTORY_SPECIAL } });
    world.runTurn();

    expect(world.tileVisibility(2, 36, 36)).toBe(TILE_FOGGED);
    const { observation: obs } = createBotObservation(world, 2);

    const stone = obs.knownResources.find((r) => r.type === MINE_STONE);
    expect(stone).toBeDefined();
    expect(stone!.visibleNow).toBe(false);
    // Reveal Map does NOT reveal fogged enemy buildings that were never seen in TILE_VISIBLE
    expect(obs.knownEnemies.find((e) => e.type === BARRACKS)).toBeUndefined();
  });

  test('handles zone-label wrap (>255 zones) and dynamic wall obstacles with checkDynamicPath = true without mutating World', () => {
    // 1. Dynamic wall obstacle inside the SAME connected land zone
    const map = makeGrassMap(48);
    const wallUnits: StartUnit[] = [
      { owner: 2, type: TOWN_CENTER, x: 8.5, y: 8.5 },
      { owner: 2, type: VILLAGER, x: 10.5, y: 12.5 },
      { owner: 1, type: CLUBMAN, x: 18.5, y: 12.5 },
    ];
    // Complete wall enclosure around (18.5, 12.5) at x=16..20, y=10..14
    for (let x = 16; x <= 20; x++) {
      wallUnits.push({ owner: 1, type: SMALL_WALL, x: x + 0.5, y: 10.5 });
      wallUnits.push({ owner: 1, type: SMALL_WALL, x: x + 0.5, y: 14.5 });
    }
    for (let y = 11; y <= 13; y++) {
      wallUnits.push({ owner: 1, type: SMALL_WALL, x: 16.5, y: y + 0.5 });
      wallUnits.push({ owner: 1, type: SMALL_WALL, x: 20.5, y: y + 0.5 });
    }
    const worldWall = new World({ players: 3, map, units: wallUnits, victory: { type: VICTORY_SPECIAL } });
    const villager = [...worldWall.entities.ofPlayer(2)].find((e) => e.type === VILLAGER)!;
    const { observation: obsWall } = createBotObservation(worldWall, 2);

    const hashBefore = worldWall.hash();
    const seedBefore = worldWall.randomSeed;

    // Zone precheck passes (same grass zone), dynamic A* catches the wall enclosure!
    expect(obsWall.canReach(villager.id, 18.5, 12.5, 1.5, false)).toBe(true);
    expect(obsWall.canReach(villager.id, 18.5, 12.5, 1.5, true)).toBe(false);
    expect(worldWall.hash()).toBe(hashBefore);
    expect(worldWall.randomSeed).toBe(seedBefore);

    // 2. Zone-label wrap case (>255 4-connected regions so zone 0 and zone 255 share byte label 0)
    const wrapSize = 36;
    const wrapMap = new TileMap(wrapSize, wrapSize);
    for (let y = 0; y < wrapSize; y++) {
      for (let x = 0; x < wrapSize; x++) {
        // Checkerboard of 1-tile grass islands surrounded by water -> >600 distinct 4-connected regions!
        wrapMap.setTile(x, y, (x + y) % 2 === 0 ? TERRAIN_GRASS : TERRAIN_WATER);
      }
    }
    const wWrap = new World({
      players: 3,
      map: wrapMap,
      units: [
        { owner: 2, type: TOWN_CENTER, x: 0.5, y: 0.5 },
        { owner: 2, type: VILLAGER, x: 0.5, y: 0.5 },
      ],
      victory: { type: VICTORY_SPECIAL },
    });
    const wrapVillager = [...wWrap.entities.ofPlayer(2)].find((e) => e.type === VILLAGER)!;
    const zones = wWrap.pathing.zones.of(wWrap.masters[2]![VILLAGER]!);
    const startLabel = zones.at(wrapSize, 0, 0);
    // Find another grass tile far away that wrapped to the exact same byte label
    let wrappedCol = -1;
    let wrappedRow = -1;
    for (let y = 10; y < wrapSize && wrappedCol === -1; y++) {
      for (let x = 0; x < wrapSize; x++) {
        if ((x + y) % 2 === 0 && zones.at(wrapSize, x, y) === startLabel) {
          wrappedCol = x;
          wrappedRow = y;
          break;
        }
      }
    }
    expect(wrappedCol).toBeGreaterThanOrEqual(0);
    const { observation: obsWrap } = createBotObservation(wWrap, 2);
    // Dynamic path check MUST reject the wrapped disconnected island!
    expect(obsWrap.canReach(wrapVillager.id, wrappedCol + 0.5, wrappedRow + 0.5, 0, true)).toBe(false);
  });

  test('tracks researchingTech, isActivelyEngaged clearing on target death/fog, transport cargo, and null explore when fully explored', () => {
    const map = makeSplitIslandMap(24);
    const units: StartUnit[] = [
      { owner: 2, type: TOWN_CENTER, x: 8.5, y: 10.5 },
      { owner: 2, type: 68 /* Granary */, x: 4.5, y: 10.5 },
      { owner: 2, type: BARRACKS, x: 4.5, y: 14.5 },
      { owner: 2, type: VILLAGER, x: 6.5, y: 10.5 },
      { owner: 2, type: CLUBMAN, x: 12.5, y: 10.5 },
      { owner: 2, type: 17 /* Transport Boat */, x: 22.5, y: 10.5 },
      { owner: 1, type: CLUBMAN, x: 13.5, y: 10.5 },
    ];
    const world = new World({ players: 3, map, units, victory: { type: VICTORY_SPECIAL } });
    const tc = [...world.entities.ofPlayer(2)].find((e) => e.type === TOWN_CENTER)!;
    const clubman = [...world.entities.ofPlayer(2)].find((e) => e.type === CLUBMAN)!;
    const enemy = [...world.entities.ofPlayer(1)].find((e) => e.type === CLUBMAN)!;
    const transport = [...world.entities.ofPlayer(2)].find((e) => e.type === 17)!;
    const passenger = world.createObject(2, CLUBMAN, 22.5, 10.5, 0);
    passenger.inside = transport.id;
    transport.cargo = [passenger.id];

    // Research Tool Age (101) at TC and attack enemy Clubman
    world.attributes[2]![ATTR_FOOD] = 800;
    world.addBatch(world.turn, 2, [
      { type: 'research', building: tc.id, tech: 101 },
      { type: 'attack', units: [clubman.id], target: enemy.id },
    ]);
    for (let i = 0; i < 4; i++) world.runTurn();

    const r1 = createBotObservation(world, 2);
    const obsTc = r1.observation.ownBuildings.find((b) => b.id === tc.id)!;
    expect(obsTc.researchingTech).toBe(101);
    expect(obsTc.isBusy).toBe(true);

    const obsClubman = r1.observation.ownUnits.find((u) => u.id === clubman.id)!;
    expect(obsClubman.attackTarget).toBe(enemy.id);
    expect(obsClubman.isActivelyEngaged).toBe(true);

    const obsTransport = r1.observation.ownUnits.find((u) => u.id === transport.id)!;
    expect(obsTransport.cargoCount).toBe(1);
    const obsPassenger = r1.observation.ownUnits.find((u) => u.id === passenger.id)!;
    expect(obsPassenger.inside).toBe(transport.id);
    expect(r1.observation.canReach(passenger.id, 22.5, 10.5, 0)).toBe(false);

    // Kill enemy while visible -> isActivelyEngaged becomes false
    enemy.state = ObjectState.Dead;
    enemy.hp = 0;
    const r2 = createBotObservation(world, 2, r1.memory);
    expect(r2.observation.ownUnits.find((u) => u.id === clubman.id)?.isActivelyEngaged).toBe(false);

    // Fully explore map -> findNearestExploreTarget returns null
    world.visibility.exploreAll(2);
    const r3 = createBotObservation(world, 2, r2.memory);
    expect(r3.observation.findNearestExploreTarget(clubman.id, 1)).toBeNull();
    expect(r3.observation.canReach(999999, 10.5, 10.5, 0)).toBe(false);
    expect(r3.observation.canReach(clubman.id, -5, 10.5, 0)).toBe(false);
  });
});
