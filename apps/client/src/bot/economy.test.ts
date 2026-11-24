import { describe, expect, test, vi } from 'vitest';
import {
  ATTR_FARM_FOOD,
  ATTR_FOOD,
  ATTR_WOOD,
  COMMAND_DELAY_TURNS,
  ELEPHANT,
  FARM,
  FORAGE,
  GAZELLE,
  GRANARY,
  HOUSE,
  MARKET,
  MINE_GOLD,
  MINE_STONE,
  ObjectState,
  SMALL_WALL,
  STORAGE_PIT,
  TECH_AVAILABLE,
  TERRAIN_GRASS,
  TERRAIN_WATER,
  TileMap,
  TOWN_CENTER,
  TREES,
  VICTORY_SPECIAL,
  VILLAGER,
  WORK_FAILED,
  WORK_KILLING,
  WORK_WORKING,
  World,
  type Command,
  type StartUnit,
} from '@aoe/sim';
import {
  arbitrateIntents,
  createArbiterState,
  createPlannerInput,
  runProposeCommitCycle,
} from './budget';
import { getBotProfile } from './difficulty';
import { createBotObservation, createEmptyBotMemory } from './observation';
import {
  createEconomyPlanner,
  EconomyPlanner,
  isDepletedFarm,
  isProductiveFarm,
} from './economy';
import {
  BOT_CONTRACT_VERSION,
  type BotObservation,
  type BotPlanner,
  type BotPlannerState,
  type ObservedMaster,
  type ObservedOwnBuilding,
  type ObservedOwnUnit,
  type ObservedResource,
} from './types';

function makePlannerState(): BotPlannerState {
  return {
    lastThinkTime: -1,
    squads: [],
    nextSquadSeq: 1,
    depletedResourceIds: [],
    failedTargets: {},
    unitCooldownUntil: {},
    buildingCooldownUntil: {},
    memory: createEmptyBotMemory(),
  };
}

function makeMaster(
  id: number,
  overrides: Partial<ObservedMaster> = {},
): ObservedMaster {
  return {
    id,
    name: `Master-${id}`,
    masterType: 80,
    group: 3,
    hitPoints: 200,
    los: 4,
    fogFlag: 1,
    speed: 0,
    radiusX: 1.5,
    radiusY: 1.5,
    clearanceX: 1.5,
    clearanceY: 1.5,
    terrainRestriction: 0,
    unitLevel: 0,
    trackAsResource: 0,
    resourceGroup: 0,
    enabled: true,
    costs: [],
    trainTime: 20,
    trainLocationId: 0,
    combat: null,
    ...overrides,
  };
}

function makeUnit(
  overrides: Partial<ObservedOwnUnit> & { id: number },
): ObservedOwnUnit {
  return {
    type: VILLAGER,
    x: 10.5,
    y: 10.5,
    hp: 25,
    maxHp: 25,
    state: ObjectState.Active,
    heldType: -1,
    heldAmount: 0,
    isVillager: true,
    isMilitary: false,
    isNaval: false,
    isMoving: false,
    workTarget: null,
    workState: null,
    isWorkActive: false,
    attackTarget: null,
    attackState: null,
    isActivelyEngaged: false,
    inside: null,
    cargoCount: 0,
    ...overrides,
  };
}

function makeBuilding(
  overrides: Partial<ObservedOwnBuilding> & { id: number },
): ObservedOwnBuilding {
  return {
    type: TOWN_CENTER,
    x: 10.5,
    y: 10.5,
    hp: 600,
    maxHp: 600,
    state: ObjectState.Active,
    isUnbuilt: false,
    buildPoints: 100,
    requiredBuildPoints: 100,
    heldType: -1,
    heldAmount: 0,
    makeTimer: null,
    trainingUnit: null,
    queueLength: 0,
    queuedUnits: [],
    researchingTech: null,
    isBusy: false,
    ...overrides,
  };
}

function makeResource(
  overrides: Partial<ObservedResource> & { id: number; type: number },
): ObservedResource {
  return {
    x: 14.5,
    y: 10.5,
    state: ObjectState.Active,
    heldType: -1,
    heldAmount: 150,
    resourceGroup: 0,
    visibleNow: true,
    lastSeenTurn: 0,
    isDangerous: false,
    ...overrides,
  };
}

function makeSyntheticObservation(
  overrides: Partial<BotObservation> = {},
): BotObservation {
  const techStates = new Array<number>(130).fill(TECH_AVAILABLE);
  return {
    contractVersion: BOT_CONTRACT_VERSION,
    player: 2,
    turn: 0,
    worldTime: 0,
    age: 2,
    civ: 1,
    mapWidth: 48,
    mapHeight: 48,
    resources: { food: 200, wood: 200, stone: 150, gold: 0 },
    population: { current: 4, limit: 12, headroom: 8 },
    ownUnits: [
      makeUnit({ id: 1, x: 8.5, y: 10.5 }),
      makeUnit({ id: 2, x: 9.5, y: 10.5 }),
      makeUnit({ id: 3, x: 11.5, y: 10.5 }),
    ],
    ownBuildings: [
      makeBuilding({ id: 100, type: TOWN_CENTER, x: 10.5, y: 10.5 }),
      makeBuilding({ id: 101, type: MARKET, x: 15.5, y: 10.5 }),
    ],
    knownEnemies: [],
    knownResources: [],
    techStates,
    enabledMasters: {
      [VILLAGER]: makeMaster(VILLAGER, {
        masterType: 70,
        group: 4,
        hitPoints: 25,
        speed: 1.1,
        radiusX: 0.2,
        radiusY: 0.2,
        clearanceX: 0.2,
        clearanceY: 0.2,
        costs: [
          { type: ATTR_FOOD, amount: 50, flag: 1 },
          { type: 4, amount: 1, flag: 0 },
        ],
      }),
      [FARM]: makeMaster(FARM, {
        hitPoints: 50,
        costs: [{ type: ATTR_WOOD, amount: 75, flag: 1 }],
        trainTime: 30,
      }),
      [GRANARY]: makeMaster(GRANARY, {
        hitPoints: 350,
        costs: [{ type: ATTR_WOOD, amount: 120, flag: 1 }],
      }),
      [STORAGE_PIT]: makeMaster(STORAGE_PIT, {
        hitPoints: 350,
        costs: [{ type: ATTR_WOOD, amount: 120, flag: 1 }],
      }),
    },
    canReach: () => true,
    isTileExplored: () => true,
    isTileVisible: () => true,
    findNearestExploreTarget: () => null,
    canPlaceBuilding: () => true,
    findBuildPlacement: (_masterId, nearX, nearY) => ({
      x: Math.floor(nearX) + 4.5,
      y: Math.floor(nearY) + 0.5,
    }),
    findDockPlacement: () => null,
    ...overrides,
  };
}

function makeSplitIslandMap(size = 48): TileMap {
  const map = new TileMap(size, size);
  for (let x = 0; x < size; x++) {
    for (let y = 0; y < size; y++) {
      map.setTile(x, y, x >= 20 && x <= 24 ? TERRAIN_WATER : TERRAIN_GRASS);
    }
  }
  return map;
}

describe('T03 E01 — Farm transition after berries/gazelles deplete', () => {
  test('builds and assigns Farm when natural food is depleted after Tool/Market, and recovers food in real @aoe/sim', () => {
    const map = new TileMap(40, 40);
    const units: StartUnit[] = [
      { owner: 2, type: TOWN_CENTER, x: 10.5, y: 10.5 },
      { owner: 2, type: HOUSE, x: 6.5, y: 10.5 },
      { owner: 2, type: HOUSE, x: 6.5, y: 13.5 },
      { owner: 2, type: MARKET, x: 15.5, y: 10.5 },
      { owner: 2, type: VILLAGER, x: 9.5, y: 12.5 },
      { owner: 2, type: VILLAGER, x: 10.5, y: 12.5 },
      { owner: 2, type: VILLAGER, x: 11.5, y: 12.5 },
      // Depleted berry bush and dead/empty gazelle? Use an almost-empty berry (1 food) or none
      { owner: 0, type: FORAGE, x: 12.5, y: 12.5 },
    ];
    const world = new World({ players: 3, map, units, victory: { type: VICTORY_SPECIAL } });
    world.attributes[2]![ATTR_FOOD] = 120;
    world.attributes[2]![ATTR_WOOD] = 250;

    // Deplete the berry bush completely before bot runs
    const forage = [...world.entities.all()].find((e) => e.type === FORAGE)!;
    forage.heldAmount = 0;
    forage.state = ObjectState.PendingRemoval;
    for (let i = 0; i < 3; i++) world.runTurn();
    expect([...world.entities.all()].some((e) => e.type === FORAGE)).toBe(false);

    const planner = createEconomyPlanner();
    const arbiter = createArbiterState();
    const state = makePlannerState();
    const profile = getBotProfile('medium');
    let memory = createEmptyBotMemory();

    // Prevent villager training from draining all food during test assertions by setting targetVillagers low
    const farmTestProfile = { ...profile, targetVillagers: 3 };
    const foodAtStart = world.attributes[2]![ATTR_FOOD]!;
    const issued: Command[] = [];

    for (let t = 0; t < 500; t++) {
      if (t % 2 === 0) {
        const obsRes = createBotObservation(world, 2, memory);
        memory = obsRes.memory;
        const result = runProposeCommitCycle(
          [planner],
          obsRes.observation,
          farmTestProfile,
          arbiter,
          state,
          101,
        );
        if (result.commands.length > 0) {
          issued.push(...result.commands);
          world.addBatch(world.turn, 2, result.commands);
        }
      }
      world.runTurn();
    }

    const builtFarms = issued.filter(
      (c): c is Extract<Command, { type: 'build' }> => c.type === 'build' && c.unitType === FARM,
    );
    expect(builtFarms.length).toBeGreaterThanOrEqual(1);
    const activeFarms = [...world.entities.ofPlayer(2)].filter(
      (e) => e.type === FARM && e.state === ObjectState.Active,
    );
    expect(activeFarms.length).toBeGreaterThanOrEqual(1);
    expect(world.attributes[2]![ATTR_FOOD]!).toBeGreaterThan(foodAtStart);
  });

  test('does not propose Farm build when Farm master is disabled (no Market) or wood is insufficient', () => {
    const planner = new EconomyPlanner();
    const profile = getBotProfile('medium');
    const state = makePlannerState();
    const arbiter = createArbiterState();

    const obsDisabled = makeSyntheticObservation({
      resources: { food: 100, wood: 200, stone: 0, gold: 0 },
      enabledMasters: {
        ...makeSyntheticObservation().enabledMasters,
        [FARM]: makeMaster(FARM, {
          enabled: false,
          costs: [{ type: ATTR_WOOD, amount: 75, flag: 1 }],
        }),
      },
    });
    const resDisabled = runProposeCommitCycle([planner], obsDisabled, profile, arbiter, state, 1);
    expect(
      resDisabled.commands.some((c) => c.type === 'build' && c.unitType === FARM),
    ).toBe(false);

    const obsLowWood = makeSyntheticObservation({
      resources: { food: 100, wood: 50, stone: 0, gold: 0 },
    });
    const resLowWood = runProposeCommitCycle(
      [planner],
      obsLowWood,
      profile,
      createArbiterState(),
      makePlannerState(),
      1,
    );
    expect(
      resLowWood.commands.some((c) => c.type === 'build' && c.unitType === FARM),
    ).toBe(false);
  });
});

describe('T03 E02 — Farm depletion mechanics, multi-cycle replenishment & CTI=2 anti-spam', () => {
  test('classifies productive vs depleted farms per real @aoe/sim rules (makeTimer > 0 || heldAmount > 0)', () => {
    const freshGrowingFarm = makeBuilding({
      id: 1,
      type: FARM,
      state: ObjectState.Active,
      makeTimer: 250,
      heldAmount: 0,
    });
    const timerZeroWithRemainingFood = makeBuilding({
      id: 2,
      type: FARM,
      state: ObjectState.Active,
      makeTimer: 0,
      heldAmount: 5,
    });
    const emptyTimerZeroFarm = makeBuilding({
      id: 3,
      type: FARM,
      state: ObjectState.Active,
      makeTimer: 0,
      heldAmount: 0,
    });
    const dyingFarm = makeBuilding({
      id: 4,
      type: FARM,
      hp: 0,
      state: ObjectState.Dying,
      makeTimer: 0,
      heldAmount: 0,
    });

    expect(isProductiveFarm(freshGrowingFarm)).toBe(true);
    expect(isDepletedFarm(freshGrowingFarm)).toBe(false);

    expect(isProductiveFarm(timerZeroWithRemainingFood)).toBe(true);
    expect(isDepletedFarm(timerZeroWithRemainingFood)).toBe(false);

    expect(isProductiveFarm(emptyTimerZeroFarm)).toBe(false);
    expect(isDepletedFarm(emptyTimerZeroFarm)).toBe(true);

    expect(isProductiveFarm(dyingFarm)).toBe(false);
    expect(isDepletedFarm(dyingFarm)).toBe(true);
  });

  test('does not count depleted/empty farms toward targetFarms, never assigns work to empty farm, and avoids duplicate spam during COMMAND_DELAY_TURNS', () => {
    const planner = createEconomyPlanner();
    const profile = { ...getBotProfile('medium'), targetFarms: 2, targetVillagers: 3 };
    const arbiter = createArbiterState();
    const state = makePlannerState();

    // 1 productive farm (worked by v1) + 1 depleted empty farm (makeTimer=0, heldAmount=0) + idle v2, v3
    const obs0 = makeSyntheticObservation({
      turn: 0,
      resources: { food: 120, wood: 300, stone: 0, gold: 0 },
      ownUnits: [
        makeUnit({ id: 1, workTarget: 201, workState: WORK_WORKING, isWorkActive: true }),
        makeUnit({ id: 2, x: 11.5, y: 10.5 }),
        makeUnit({ id: 3, x: 12.5, y: 10.5 }),
      ],
      ownBuildings: [
        makeBuilding({ id: 100, type: TOWN_CENTER }),
        makeBuilding({ id: 101, type: MARKET, x: 15.5, y: 10.5 }),
        makeBuilding({ id: 201, type: FARM, x: 8.5, y: 10.5, makeTimer: 200, heldAmount: 10 }),
        makeBuilding({ id: 202, type: FARM, x: 8.5, y: 14.5, makeTimer: 0, heldAmount: 0 }),
      ],
    });

    const res0 = runProposeCommitCycle([planner], obs0, profile, arbiter, state, 1);
    const builds0 = res0.commands.filter((c) => c.type === 'build' && c.unitType === FARM);
    const workToEmpty = res0.commands.filter((c) => c.type === 'work' && c.target === 202);

    // Depleted farm 202 must NOT block reaching targetFarms=2 and must NOT receive a work command
    expect(builds0).toHaveLength(1);
    expect(workToEmpty).toHaveLength(0);

    // During COMMAND_DELAY_TURNS (turns 1 and 2), pending build covers the 2nd farm: zero duplicate Farm builds!
    for (let t = 1; t <= COMMAND_DELAY_TURNS; t++) {
      const resT = runProposeCommitCycle(
        [planner],
        { ...obs0, turn: t, worldTime: t * 90 },
        profile,
        arbiter,
        state,
        1,
      );
      expect(resT.commands.filter((c) => c.type === 'build' && c.unitType === FARM)).toHaveLength(0);
    }

    // Also verify no duplicate work spam for an unworked productive farm during COMMAND_DELAY_TURNS
    const arbiterWork = createArbiterState();
    const stateWork = makePlannerState();
    const obsUnworkedFarm = makeSyntheticObservation({
      turn: 0,
      resources: { food: 120, wood: 300, stone: 0, gold: 0 },
      ownUnits: [
        makeUnit({ id: 1, x: 9.5, y: 10.5 }),
        makeUnit({ id: 2, x: 11.5, y: 10.5 }),
      ],
      ownBuildings: [
        makeBuilding({ id: 100, type: TOWN_CENTER }),
        makeBuilding({ id: 101, type: MARKET, x: 15.5, y: 10.5 }),
        makeBuilding({ id: 201, type: FARM, x: 8.5, y: 10.5, makeTimer: 220, heldAmount: 0 }),
        makeBuilding({ id: 202, type: FARM, x: 8.5, y: 14.5, makeTimer: 220, heldAmount: 5 }),
      ],
    });
    const w0 = runProposeCommitCycle([planner], obsUnworkedFarm, profile, arbiterWork, stateWork, 1);
    const farmWorks0 = w0.commands.filter((c) => c.type === 'work' && (c.target === 201 || c.target === 202));
    expect(farmWorks0).toHaveLength(2);

    for (let t = 1; t <= COMMAND_DELAY_TURNS; t++) {
      const wt = runProposeCommitCycle(
        [planner],
        { ...obsUnworkedFarm, turn: t, worldTime: t * 90 },
        profile,
        arbiterWork,
        stateWork,
        1,
      );
      expect(wt.commands.filter((c) => c.type === 'work' && (c.target === 201 || c.target === 202))).toHaveLength(0);
    }
  });

  test('multi-tick @aoe/sim integration: replenishes Farms across >=2 consecutive depletion cycles and keeps economy stable', () => {
    const map = new TileMap(40, 40);
    const units: StartUnit[] = [
      { owner: 2, type: TOWN_CENTER, x: 10.5, y: 10.5 },
      { owner: 2, type: HOUSE, x: 6.5, y: 10.5 },
      { owner: 2, type: HOUSE, x: 6.5, y: 13.5 },
      { owner: 2, type: MARKET, x: 16.5, y: 10.5 },
      { owner: 2, type: VILLAGER, x: 9.5, y: 12.5 },
      { owner: 2, type: VILLAGER, x: 10.5, y: 12.5 },
      { owner: 2, type: VILLAGER, x: 11.5, y: 12.5 },
    ];
    const world = new World({ players: 3, map, units, victory: { type: VICTORY_SPECIAL } });
    // Set farm food to 35 per farm so >=2 full depletion + rebuild cycles complete cleanly in unit test time
    world.attributes[2]![ATTR_FARM_FOOD] = 35;
    world.attributes[2]![ATTR_FOOD] = 100;
    world.attributes[2]![ATTR_WOOD] = 800;

    const planner = createEconomyPlanner();
    const arbiter = createArbiterState();
    const state = makePlannerState();
    const profile = { ...getBotProfile('medium'), targetFarms: 2, targetVillagers: 3 };
    let memory = createEmptyBotMemory();

    const startFood = world.attributes[2]![ATTR_FOOD]!;
    let buildFarmCount = 0;

    for (let t = 0; t < 1800 && (world.depleted[2] ?? 0) < 3; t++) {
      if (t % 2 === 0) {
        const obsRes = createBotObservation(world, 2, memory);
        memory = obsRes.memory;
        const result = runProposeCommitCycle(
          [planner],
          obsRes.observation,
          profile,
          arbiter,
          state,
          42,
        );
        for (const c of result.commands) {
          if (c.type === 'build' && c.unitType === FARM) buildFarmCount++;
        }
        if (result.commands.length > 0) {
          world.addBatch(world.turn, 2, result.commands);
        }
      }
      world.runTurn();
    }

    // At least 2 consecutive Farm depletion cycles observed in real @aoe/sim
    expect(world.depleted[2]).toBeGreaterThanOrEqual(2);
    // Replenishment built >= 3 Farms across cycles (not capped permanently by dead/depleted farms)
    expect(buildFarmCount).toBeGreaterThanOrEqual(3);
    // Economy recovered food steadily
    expect(world.attributes[2]![ATTR_FOOD]!).toBeGreaterThan(startFood + 60);
    // At least one active/unbuilt Farm remains in production
    const remainingFarms = [...world.entities.ofPlayer(2)].filter(
      (e) => e.type === FARM && (e.state === ObjectState.Active || e.state === ObjectState.Unbuilt),
    );
    expect(remainingFarms.length).toBeGreaterThanOrEqual(1);
  });
});

describe('T03 E03 — Resource switching, unreachable island/drop-off & economy recovery priority', () => {
  test('switches away from depleted or unreachable island/walled mines and never repeats failed/unreachable work commands', () => {
    const map = makeSplitIslandMap(48);
    const units: StartUnit[] = [
      { owner: 2, type: TOWN_CENTER, x: 10.5, y: 10.5 },
      { owner: 2, type: VILLAGER, x: 14.5, y: 10.5 },
      // Island gold & tree (revealed, unreachable across water)
      { owner: 0, type: MINE_GOLD, x: 30.5, y: 10.5 },
      { owner: 0, type: TREES[0], x: 32.5, y: 10.5 },
      // Walled-off gold mine on mainland
      { owner: 0, type: MINE_GOLD, x: 16.5, y: 16.5 },
      // Reachable mainland tree
      { owner: 0, type: TREES[0], x: 12.5, y: 12.5 },
    ];
    for (let x = 15; x <= 18; x++) {
      units.push({ owner: 1, type: SMALL_WALL, x: x + 0.5, y: 15.5 });
      units.push({ owner: 1, type: SMALL_WALL, x: x + 0.5, y: 18.5 });
    }
    for (let y = 16; y <= 17; y++) {
      units.push({ owner: 1, type: SMALL_WALL, x: 15.5, y: y + 0.5 });
      units.push({ owner: 1, type: SMALL_WALL, x: 18.5, y: y + 0.5 });
    }

    const world = new World({ players: 3, map, units, victory: { type: VICTORY_SPECIAL } });
    world.visibility.exploreAll(2);
    const islandIds = new Set(
      [...world.entities.all()].filter((e) => e.x > 24).map((e) => e.id),
    );
    const walledGold = [...world.entities.all()].find(
      (e) => e.type === MINE_GOLD && e.x < 20,
    )!;
    const reachableTree = [...world.entities.all()].find(
      (e) => e.type === TREES[0] && e.x < 20,
    )!;

    const planner = createEconomyPlanner();
    const profile = getBotProfile('medium');
    const arbiter = createArbiterState();
    const state = makePlannerState();

    const { observation } = createBotObservation(world, 2);
    const res = runProposeCommitCycle([planner], observation, profile, arbiter, state, 7);

    const workCmds = res.commands.filter(
      (c): c is Extract<Command, { type: 'work' }> => c.type === 'work',
    );
    expect(workCmds).toHaveLength(1);
    expect(islandIds.has(workCmds[0]!.target)).toBe(false);
    expect(workCmds[0]!.target).not.toBe(walledGold.id);
    expect(workCmds[0]!.target).toBe(reachableTree.id);
  });

  test('avoids resources whose drop-off site is unreachable and switches to a source with reachable drop-off', () => {
    const map = makeSplitIslandMap(48);
    const units: StartUnit[] = [
      // TC & Storage Pit are on the east island (unreachable to west villager)
      { owner: 2, type: TOWN_CENTER, x: 32.5, y: 10.5 },
      { owner: 2, type: STORAGE_PIT, x: 35.5, y: 10.5 },
      // Granary IS on the west mainland with our villager
      { owner: 2, type: GRANARY, x: 10.5, y: 10.5 },
      { owner: 2, type: VILLAGER, x: 12.5, y: 10.5 },
      // Gold & Stone on west mainland (need TC or Storage Pit -> unreachable drop-off!)
      { owner: 0, type: MINE_GOLD, x: 14.5, y: 10.5 },
      { owner: 0, type: MINE_STONE, x: 14.5, y: 12.5 },
      // Forage on west mainland (can drop off at Granary!)
      { owner: 0, type: FORAGE, x: 11.5, y: 14.5 },
    ];
    const world = new World({ players: 3, map, units, victory: { type: VICTORY_SPECIAL } });
    world.visibility.exploreAll(2);

    const forage = [...world.entities.all()].find((e) => e.type === FORAGE)!;
    const gold = [...world.entities.all()].find((e) => e.type === MINE_GOLD)!;
    const stone = [...world.entities.all()].find((e) => e.type === MINE_STONE)!;

    const planner = createEconomyPlanner();
    const { observation } = createBotObservation(world, 2);
    const res = runProposeCommitCycle(
      [planner],
      observation,
      getBotProfile('medium'),
      createArbiterState(),
      makePlannerState(),
      11,
    );

    const workCmds = res.commands.filter(
      (c): c is Extract<Command, { type: 'work' }> => c.type === 'work',
    );
    expect(workCmds).toHaveLength(1);
    expect(workCmds[0]!.target).not.toBe(gold.id);
    expect(workCmds[0]!.target).not.toBe(stone.id);
    expect(workCmds[0]!.target).toBe(forage.id);
  });

  test('does not repeat failed work target after WORK_FAILED and prioritizes villager/economy recovery ahead of expensive military', () => {
    const planner = createEconomyPlanner();
    const profile = getBotProfile('medium');
    const arbiter = createArbiterState();
    const state = makePlannerState();

    // Simulate villager whose previous work on gold mine 500 failed
    const obsFailed = makeSyntheticObservation({
      turn: 5,
      resources: { food: 60, wood: 80, stone: 0, gold: 40 },
      ownUnits: [
        makeUnit({
          id: 1,
          workTarget: 500,
          workState: WORK_FAILED,
          isWorkActive: false,
        }),
      ],
      knownResources: [
        makeResource({ id: 500, type: MINE_GOLD, resourceGroup: 4, heldAmount: 400, x: 14.5, y: 10.5 }),
        makeResource({ id: 501, type: TREES[0], resourceGroup: 0, heldAmount: 75, x: 12.5, y: 12.5 }),
      ],
    });

    // Compete against an expensive military intent (60F, 40G) at priority 65
    const expensiveMilitaryPlanner: BotPlanner = {
      name: 'mock-military',
      propose: () => [
        {
          key: 'mil:train:expensive',
          priority: 65,
          reason: 'Expensive military unit',
          cost: { food: 60, gold: 40, headroom: 1 },
          buildingId: 102,
          command: { type: 'queue', building: 102, unit: 37, count: 1 },
        },
      ],
      commit: () => {},
    };

    const res1 = runProposeCommitCycle(
      [expensiveMilitaryPlanner, planner],
      obsFailed,
      profile,
      arbiter,
      state,
      1,
    );

    // Villager training (50F) + Farm (75W) must win budget ahead of expensive military (60F 40G)
    expect(res1.commands.some((c) => c.type === 'queue' && c.unit === VILLAGER)).toBe(true);
    expect(res1.outcomesByKey['mil:train:expensive']?.accepted).toBe(false);
    expect(res1.outcomesByKey['mil:train:expensive']?.reason).toBe('insufficient-budget');

    // Next tick (wood below Farm cost 75): failed target 500 must be backed off and villager switches to tree 501
    const obsNext = makeSyntheticObservation({
      turn: 10,
      resources: { food: 10, wood: 40, stone: 0, gold: 40 },
      ownUnits: [makeUnit({ id: 1, workTarget: null, workState: null, isWorkActive: false })],
      knownResources: obsFailed.knownResources,
    });
    const res2 = runProposeCommitCycle(
      [planner],
      obsNext,
      profile,
      createArbiterState(),
      state,
      1,
    );
    const workNext = res2.commands.filter(
      (c): c is Extract<Command, { type: 'work' }> => c.type === 'work',
    );
    expect(workNext.every((w) => w.target !== 500)).toBe(true);
    expect(workNext.some((w) => w.target === 501)).toBe(true);
  });
});

describe('T03 E04 — Safe Elephant hunting party, unreachable island guard, & unsafe hunt cancel/retarget', () => {
  test('never sends a single villager or weak low-HP villagers to hunt an Elephant', () => {
    const planner = createEconomyPlanner();
    const profile = getBotProfile('medium');

    // Case 1: only 1 healthy villager -> MUST NOT hunt Elephant
    const obsSingle = makeSyntheticObservation({
      ownUnits: [makeUnit({ id: 1, hp: 25, maxHp: 25 })],
      knownResources: [
        makeResource({
          id: 900,
          type: ELEPHANT,
          x: 13.5,
          y: 10.5,
          heldAmount: 300,
          isDangerous: true,
        }),
      ],
    });
    const rSingle = runProposeCommitCycle(
      [planner],
      obsSingle,
      profile,
      createArbiterState(),
      makePlannerState(),
      1,
    );
    expect(rSingle.commands.some((c) => c.type === 'work' && c.target === 900)).toBe(false);

    // Case 2: 3 villagers, but 2 are weak (hp=10/25) -> only 1 healthy -> MUST NOT hunt Elephant
    const obsWeak = makeSyntheticObservation({
      ownUnits: [
        makeUnit({ id: 1, hp: 25, maxHp: 25 }),
        makeUnit({ id: 2, hp: 10, maxHp: 25 }),
        makeUnit({ id: 3, hp: 8, maxHp: 25 }),
      ],
      knownResources: [
        makeResource({
          id: 900,
          type: ELEPHANT,
          x: 13.5,
          y: 10.5,
          heldAmount: 300,
          isDangerous: true,
        }),
      ],
    });
    const rWeak = runProposeCommitCycle(
      [planner],
      obsWeak,
      profile,
      createArbiterState(),
      makePlannerState(),
      1,
    );
    expect(rWeak.commands.some((c) => c.type === 'work' && c.target === 900)).toBe(false);

    // Case 3: Easy profile (allowElephantHunt=false) -> NEVER hunts Elephant even with 4 healthy villagers
    const obsHealthy = makeSyntheticObservation({
      ownUnits: [
        makeUnit({ id: 1, hp: 25, maxHp: 25 }),
        makeUnit({ id: 2, hp: 25, maxHp: 25 }),
        makeUnit({ id: 3, hp: 25, maxHp: 25 }),
        makeUnit({ id: 4, hp: 25, maxHp: 25 }),
      ],
      knownResources: [
        makeResource({
          id: 900,
          type: ELEPHANT,
          x: 13.5,
          y: 10.5,
          heldAmount: 300,
          isDangerous: true,
        }),
      ],
    });
    const rEasy = runProposeCommitCycle(
      [planner],
      obsHealthy,
      getBotProfile('easy'),
      createArbiterState(),
      makePlannerState(),
      1,
    );
    expect(rEasy.commands.some((c) => c.type === 'work' && c.target === 900)).toBe(false);
  });

  test('never hunts an Elephant on an unreachable island (canReach) and dispatches valid party when threshold met', () => {
    const map = makeSplitIslandMap(48);
    const units: StartUnit[] = [
      { owner: 2, type: TOWN_CENTER, x: 10.5, y: 10.5 },
      { owner: 2, type: VILLAGER, x: 12.5, y: 10.5 },
      { owner: 2, type: VILLAGER, x: 12.5, y: 11.5 },
      { owner: 2, type: VILLAGER, x: 13.5, y: 10.5 },
      { owner: 2, type: VILLAGER, x: 13.5, y: 11.5 },
      // Elephant on isolated east island
      { owner: 0, type: ELEPHANT, x: 30.5, y: 10.5 },
    ];
    const worldIsland = new World({ players: 3, map, units, victory: { type: VICTORY_SPECIAL } });
    worldIsland.visibility.exploreAll(2);
    const islandElephant = [...worldIsland.entities.all()].find((e) => e.type === ELEPHANT)!;

    const planner = createEconomyPlanner();
    const profile = getBotProfile('medium');
    const obsIsland = createBotObservation(worldIsland, 2).observation;
    const resIsland = runProposeCommitCycle(
      [planner],
      obsIsland,
      profile,
      createArbiterState(),
      makePlannerState(),
      1,
    );
    expect(
      resIsland.commands.some((c) => c.type === 'work' && c.target === islandElephant.id),
    ).toBe(false);

    // Now place reachable Elephant on mainland -> valid hunting party (>= 3 healthy villagers) dispatched
    const mapLand = new TileMap(40, 40);
    const worldLand = new World({
      players: 3,
      map: mapLand,
      units: [
        { owner: 2, type: TOWN_CENTER, x: 8.5, y: 10.5 },
        { owner: 2, type: VILLAGER, x: 11.5, y: 10.5 },
        { owner: 2, type: VILLAGER, x: 12.5, y: 10.5 },
        { owner: 2, type: VILLAGER, x: 11.5, y: 11.5 },
        { owner: 2, type: VILLAGER, x: 12.5, y: 11.5 },
        { owner: 0, type: ELEPHANT, x: 14.5, y: 11.5 },
      ],
      victory: { type: VICTORY_SPECIAL },
    });
    const landElephant = [...worldLand.entities.all()].find((e) => e.type === ELEPHANT)!;
    const obsLand = createBotObservation(worldLand, 2).observation;
    const resLand = runProposeCommitCycle(
      [planner],
      obsLand,
      profile,
      createArbiterState(),
      makePlannerState(),
      1,
    );
    const huntCmd = resLand.commands.find(
      (c): c is Extract<Command, { type: 'work' }> =>
        c.type === 'work' && c.target === landElephant.id,
    );
    expect(huntCmd).toBeDefined();
    expect(huntCmd!.units.length).toBeGreaterThanOrEqual(3);
  });

  test('cancels or retargets an active Elephant hunt when hunter HP drops unsafe or party drops to 1 lone hunter', () => {
    const planner = createEconomyPlanner();
    const profile = getBotProfile('medium');

    // Lone low-HP villager actively hunting an alive Elephant, with a safe berry bush nearby
    const obsUnsafe = makeSyntheticObservation({
      ownUnits: [
        makeUnit({
          id: 1,
          hp: 9,
          maxHp: 25,
          workTarget: 900,
          workState: WORK_KILLING,
          isWorkActive: true,
        }),
      ],
      knownResources: [
        makeResource({
          id: 900,
          type: ELEPHANT,
          x: 15.5,
          y: 10.5,
          heldAmount: 300,
          isDangerous: true,
        }),
        makeResource({
          id: 901,
          type: FORAGE,
          x: 9.5,
          y: 10.5,
          resourceGroup: 1,
          heldAmount: 150,
          isDangerous: false,
        }),
      ],
    });

    const res = runProposeCommitCycle(
      [planner],
      obsUnsafe,
      profile,
      createArbiterState(),
      makePlannerState(),
      1,
    );
    const pullOffCmd = res.commands.find(
      (c) => (c.type === 'work' || c.type === 'move') && c.units.includes(1),
    );
    expect(pullOffCmd).toBeDefined();
    if (pullOffCmd!.type === 'work') {
      expect(pullOffCmd!.target).toBe(901);
    }
  });
});

describe('T03 Gazelle & Naval Fishing Economy', () => {
  test('gathers Gazelle safely with a single villager and respects allowNaval for Dock/Fishing Boat', () => {
    const planner = createEconomyPlanner();
    const obsGazelle = makeSyntheticObservation({
      ownUnits: [makeUnit({ id: 1, hp: 25, maxHp: 25 })],
      knownResources: [
        makeResource({
          id: 800,
          type: GAZELLE,
          x: 13.5,
          y: 10.5,
          heldAmount: 150,
          isDangerous: false,
        }),
      ],
    });
    const resGazelle = runProposeCommitCycle(
      [planner],
      obsGazelle,
      getBotProfile('easy'),
      createArbiterState(),
      makePlannerState(),
      1,
    );
    expect(
      resGazelle.commands.some((c) => c.type === 'work' && c.target === 800),
    ).toBe(true);

    // Naval: Dock + Fishing Boat + Sea Fish
    const dockMaster = makeMaster(45, {
      costs: [{ type: ATTR_WOOD, amount: 100, flag: 1 }],
    });
    const boatMaster = makeMaster(13, {
      masterType: 70,
      group: 21,
      terrainRestriction: 3,
      costs: [
        { type: ATTR_WOOD, amount: 50, flag: 1 },
        { type: 4, amount: 1, flag: 0 },
      ],
    });
    const obsNaval = makeSyntheticObservation({
      resources: { food: 200, wood: 300, stone: 0, gold: 0 },
      ownUnits: [
        makeUnit({ id: 1 }),
        makeUnit({ id: 2 }),
        makeUnit({ id: 3 }),
        makeUnit({ id: 4 }),
        makeUnit({ id: 5 }),
        makeUnit({ id: 6 }),
        makeUnit({ id: 7, type: 13, x: 22.5, y: 10.5, isVillager: false, isNaval: true }),
      ],
      ownBuildings: [
        makeBuilding({ id: 100, type: TOWN_CENTER }),
        makeBuilding({ id: 105, type: 45, x: 19.5, y: 10.5 }),
      ],
      knownResources: [
        makeResource({ id: 600, type: 53, x: 24.5, y: 10.5, resourceGroup: 2, heldAmount: 250 }),
      ],
      enabledMasters: {
        ...makeSyntheticObservation().enabledMasters,
        [45]: dockMaster,
        [13]: boatMaster,
      },
    });

    const resEasy = runProposeCommitCycle(
      [planner],
      obsNaval,
      getBotProfile('easy'),
      createArbiterState(),
      makePlannerState(),
      1,
    );
    expect(resEasy.commands.some((c) => c.type === 'queue' && c.unit === 13)).toBe(false);
    expect(resEasy.commands.some((c) => c.type === 'work' && c.target === 600)).toBe(false);

    const resMed = runProposeCommitCycle(
      [planner],
      obsNaval,
      getBotProfile('medium'),
      createArbiterState(),
      makePlannerState(),
      1,
    );
    expect(resMed.commands.some((c) => c.type === 'queue' && c.unit === 13)).toBe(true);
    expect(resMed.commands.some((c) => c.type === 'work' && c.target === 600)).toBe(true);
  });
});

describe('T03 Purity & Two-Phase propose/commit contract', () => {
  test('propose is side-effect free, deterministic, and never calls Date or Math.random', () => {
    const dateSpy = vi.spyOn(Date, 'now').mockImplementation(() => {
      throw new Error('Date.now must not be called');
    });
    const perfSpy = vi.spyOn(performance, 'now').mockImplementation(() => {
      throw new Error('performance.now must not be called');
    });
    const randSpy = vi.spyOn(Math, 'random').mockImplementation(() => {
      throw new Error('Math.random must not be called');
    });

    try {
      const planner = createEconomyPlanner();
      const profile = getBotProfile('medium');
      const obs = makeSyntheticObservation({
        knownResources: [
          makeResource({ id: 501, type: TREES[0], resourceGroup: 0, heldAmount: 75 }),
        ],
      });
      const stateBefore = makePlannerState();
      const snapshot = JSON.stringify(stateBefore);
      const input = createPlannerInput(obs, profile, createArbiterState(), stateBefore, 77);

      const intentsA = planner.propose(input);
      const intentsB = planner.propose(input);

      expect(intentsA).toEqual(intentsB);
      // propose MUST NOT mutate BotPlannerState
      expect(JSON.stringify(stateBefore)).toBe(snapshot);

      // Rejected intents MUST NOT set unit/building cooldowns in commit
      const rejectedOutcomes = Object.fromEntries(
        intentsA.map((i) => [
          i.key,
          { key: i.key, accepted: false, reason: 'insufficient-budget' as const },
        ]),
      );
      planner.commit(rejectedOutcomes, input);
      expect(Object.keys(stateBefore.unitCooldownUntil)).toHaveLength(0);
      expect(Object.keys(stateBefore.buildingCooldownUntil)).toHaveLength(0);

      // Arbitrate with real arbiter: accepted intents update cooldowns only on accepted units/buildings
      const arbiter = createArbiterState();
      const arbResult = arbitrateIntents(intentsA, obs, arbiter);
      planner.commit(arbResult.outcomesByKey, input);
      expect(Object.keys(stateBefore.unitCooldownUntil).length).toBeGreaterThan(0);
    } finally {
      dateSpy.mockRestore();
      perfSpy.mockRestore();
      randSpy.mockRestore();
    }
  });
});
