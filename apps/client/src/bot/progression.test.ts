import { describe, expect, test, vi } from 'vitest';
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
  COMMAND_DELAY_TURNS,
  GRANARY,
  HOUSE,
  IRON_AGE,
  MARKET,
  master,
  ObjectState,
  STABLE,
  startingObjects,
  STORAGE_PIT,
  TECH_AVAILABLE,
  TECH_DISABLED,
  TECH_DONE,
  TECH_LOCKED,
  TECH_RESEARCHING,
  TECHS,
  TERRAIN_WATER,
  TILE_BLACK,
  TileMap,
  TOOL_AGE,
  TOWN_CENTER,
  SMALL_WALL,
  VICTORY_SPECIAL,
  VILLAGER,
  World,
  type Command,
  type StartUnit,
} from '@aoe/sim';
import {
  arbitrateIntents,
  createArbiterState,
  createPlannerInput,
  reconcilePending,
  runProposeCommitCycle,
} from './budget';
import { getBotProfile } from './difficulty';
import { createBotObservation, createEmptyBotMemory } from './observation';
import { createProgressionPlanner, ProgressionPlanner } from './progression';
import {
  BOT_CONTRACT_VERSION,
  type BotObservation,
  type BotPlannerMemory,
  type BotPlannerState,
  type ObservedMaster,
  type ObservedOwnBuilding,
  type ObservedOwnUnit,
} from './types';

const ACADEMY = 0;
const DOCK = 45;
const SIEGE_WORKSHOP = 49;
const GOVERNMENT_CENTER = 82;
const TEMPLE = 104;
const ATTR_AGE = 6;
const CIV_EGYPTIAN = 1;
const CIV_GREEK = 2;
const CIV_PERSIAN = 9;
const CIV_MACEDONIAN = 16;

function makeMaster(
  id: number,
  options: {
    name?: string;
    enabled?: boolean;
    wood?: number;
    stone?: number;
    food?: number;
    gold?: number;
    clearanceX?: number;
    clearanceY?: number;
    trainLocationId?: number;
  } = {},
): ObservedMaster {
  const costs: { type: number; amount: number; flag: number }[] = [];
  if (options.food) costs.push({ type: ATTR_FOOD, amount: options.food, flag: 1 });
  if (options.wood) costs.push({ type: ATTR_WOOD, amount: options.wood, flag: 1 });
  if (options.stone) costs.push({ type: ATTR_STONE, amount: options.stone, flag: 1 });
  if (options.gold) costs.push({ type: ATTR_GOLD, amount: options.gold, flag: 1 });
  const cx = options.clearanceX ?? 1.5;
  const cy = options.clearanceY ?? 1.5;
  return {
    id,
    name: options.name ?? `Master-${id}`,
    masterType: 80,
    group: 3,
    hitPoints: 350,
    los: 5,
    fogFlag: 0,
    speed: 0,
    radiusX: cx,
    radiusY: cy,
    clearanceX: cx,
    clearanceY: cy,
    terrainRestriction: 4,
    unitLevel: 2,
    trackAsResource: 0,
    resourceGroup: 0,
    enabled: options.enabled ?? true,
    costs,
    trainTime: 40,
    trainLocationId: options.trainLocationId ?? 118,
    combat: null,
  };
}

function makeStandardMasters(overrides: Partial<Record<number, ObservedMaster>> = {}): Record<number, ObservedMaster> {
  return {
    [TOWN_CENTER]: makeMaster(TOWN_CENTER, { enabled: false, wood: 200, clearanceX: 2, clearanceY: 2 }),
    [HOUSE]: makeMaster(HOUSE, { wood: 30, clearanceX: 1, clearanceY: 1 }),
    [GRANARY]: makeMaster(GRANARY, { wood: 120 }),
    [STORAGE_PIT]: makeMaster(STORAGE_PIT, { wood: 120 }),
    [BARRACKS]: makeMaster(BARRACKS, { wood: 125 }),
    [DOCK]: makeMaster(DOCK, { wood: 100 }),
    [MARKET]: makeMaster(MARKET, { enabled: false, wood: 150 }),
    [ARCHERY_RANGE]: makeMaster(ARCHERY_RANGE, { enabled: false, wood: 150 }),
    [STABLE]: makeMaster(STABLE, { enabled: false, wood: 150 }),
    [GOVERNMENT_CENTER]: makeMaster(GOVERNMENT_CENTER, { enabled: false, wood: 175 }),
    [TEMPLE]: makeMaster(TEMPLE, { enabled: false, wood: 150 }),
    [SIEGE_WORKSHOP]: makeMaster(SIEGE_WORKSHOP, { enabled: false, wood: 200 }),
    [ACADEMY]: makeMaster(ACADEMY, { enabled: false, wood: 200 }),
    ...overrides,
  };
}

function makeUnit(overrides: Partial<ObservedOwnUnit> & { id: number }): ObservedOwnUnit {
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

function makeBuilding(overrides: Partial<ObservedOwnBuilding> & { id: number }): ObservedOwnBuilding {
  return {
    type: TOWN_CENTER,
    x: 12.5,
    y: 12.5,
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

function makePlannerState(): BotPlannerState {
  return {
    lastThinkTime: -1,
    squads: [],
    nextSquadSeq: 1,
    depletedResourceIds: [],
    failedTargets: {},
    unitCooldownUntil: {},
    buildingCooldownUntil: {},
    memory: { enemiesById: {}, resourcesById: {} },
  };
}

function makeObservation(overrides: Partial<BotObservation> = {}): BotObservation {
  const techStates = new Array<number>(TECHS.length).fill(TECH_LOCKED);
  return {
    contractVersion: BOT_CONTRACT_VERSION,
    player: 2,
    turn: 0,
    worldTime: 0,
    age: 1,
    civ: CIV_GREEK,
    mapWidth: 64,
    mapHeight: 64,
    resources: { food: 200, wood: 200, stone: 150, gold: 0 },
    population: { current: 3, limit: 50, headroom: 5 },
    ownUnits: [
      makeUnit({ id: 1, x: 9.5, y: 10.5 }),
      makeUnit({ id: 2, x: 10.5, y: 10.5 }),
      makeUnit({ id: 3, x: 11.5, y: 10.5 }),
    ],
    ownBuildings: [makeBuilding({ id: 10 })],
    knownEnemies: [],
    knownResources: [],
    techStates,
    enabledMasters: makeStandardMasters(),
    canReach: () => true,
    isTileExplored: () => true,
    isTileVisible: () => true,
    findNearestExploreTarget: () => null,
    canPlaceBuilding: () => true,
    findBuildPlacement: (_masterId, nearX, nearY) => ({ x: nearX + 4, y: nearY + 4 }),
    findDockPlacement: () => null,
    ...overrides,
  };
}

describe('T04 G01 — Tech-availability-driven age-ups, Market in Tool Age, and civ tech trees', () => {
  test('builds Stone Age prerequisite buildings and only advances Tool Age when TECH_AVAILABLE and affordable on idle TC', () => {
    const planner = createProgressionPlanner();
    const state = makePlannerState();

    // Even with 600F, if TOOL_AGE is TECH_LOCKED (prereqs not done), MUST NOT propose TOOL_AGE research
    const lockedObs = makeObservation({
      resources: { food: 600, wood: 400, stone: 150, gold: 0 },
      ownBuildings: [makeBuilding({ id: 10, type: TOWN_CENTER })],
      techStates: (() => {
        const t = new Array<number>(TECHS.length).fill(TECH_LOCKED);
        t[TOOL_AGE] = TECH_LOCKED;
        return t;
      })(),
    });
    const lockedIntents = planner.propose(createPlannerInput(lockedObs, getBotProfile('medium'), createArbiterState(), state, 1));
    expect(lockedIntents.some((i) => i.command.type === 'research' && i.command.tech === TOOL_AGE)).toBe(false);
    expect(lockedIntents.some((i) => i.command.type === 'build' && (i.command.unitType === GRANARY || i.command.unitType === STORAGE_PIT || i.command.unitType === BARRACKS))).toBe(true);

    // When TOOL_AGE is TECH_AVAILABLE (1) and food >= 500, proposes TOOL_AGE with real cost { food: 500 }
    const availObs = makeObservation({
      resources: { food: 550, wood: 200, stone: 150, gold: 0 },
      ownBuildings: [
        makeBuilding({ id: 10, type: TOWN_CENTER }),
        makeBuilding({ id: 11, type: GRANARY }),
        makeBuilding({ id: 12, type: STORAGE_PIT }),
      ],
      techStates: (() => {
        const t = new Array<number>(TECHS.length).fill(TECH_LOCKED);
        t[TOOL_AGE] = TECH_AVAILABLE;
        return t;
      })(),
    });
    const availIntents = planner.propose(createPlannerInput(availObs, getBotProfile('medium'), createArbiterState(), state, 1));
    const toolIntent = availIntents.find((i) => i.command.type === 'research' && i.command.tech === TOOL_AGE);
    expect(toolIntent).toBeDefined();
    expect(toolIntent!.cost?.food).toBe(500);
    expect(toolIntent!.buildingId).toBe(10);

    // Must NOT propose TOOL_AGE if TC is busy training or researching
    const busyTcObs = makeObservation({
      resources: { food: 550, wood: 200, stone: 150, gold: 0 },
      ownBuildings: [
        makeBuilding({ id: 10, type: TOWN_CENTER, trainingUnit: VILLAGER, queueLength: 1, isBusy: true }),
        makeBuilding({ id: 11, type: GRANARY }),
        makeBuilding({ id: 12, type: STORAGE_PIT }),
      ],
      techStates: availObs.techStates,
    });
    const busyIntents = planner.propose(createPlannerInput(busyTcObs, getBotProfile('medium'), createArbiterState(), state, 1));
    expect(busyIntents.some((i) => i.command.type === 'research')).toBe(false);

    // Must NOT loop research when TOOL_AGE is TECH_DISABLED (-1) or TECH_RESEARCHING (2)
    for (const badState of [TECH_DISABLED, TECH_RESEARCHING]) {
      const badObs = makeObservation({
        resources: { food: 1000, wood: 200, stone: 150, gold: 0 },
        ownBuildings: availObs.ownBuildings,
        techStates: (() => {
          const t = new Array<number>(TECHS.length).fill(TECH_LOCKED);
          t[TOOL_AGE] = badState;
          return t;
        })(),
      });
      const badIntents = planner.propose(createPlannerInput(badObs, getBotProfile('medium'), createArbiterState(), state, 1));
      expect(badIntents.some((i) => i.command.type === 'research' && i.command.tech === TOOL_AGE)).toBe(false);
    }
  });

  test('builds Market in Tool Age and advances Bronze Age only when TECH_AVAILABLE and affordable', () => {
    const planner = createProgressionPlanner();
    const state = makePlannerState();

    const toolObs = makeObservation({
      age: 2,
      resources: { food: 850, wood: 300, stone: 150, gold: 0 },
      ownBuildings: [
        makeBuilding({ id: 10, type: TOWN_CENTER }),
        makeBuilding({ id: 11, type: GRANARY }),
        makeBuilding({ id: 12, type: BARRACKS }),
      ],
      enabledMasters: makeStandardMasters({
        [MARKET]: makeMaster(MARKET, { enabled: true, wood: 150 }),
        [ARCHERY_RANGE]: makeMaster(ARCHERY_RANGE, { enabled: true, wood: 150 }),
        [STABLE]: makeMaster(STABLE, { enabled: true, wood: 150 }),
      }),
      techStates: (() => {
        const t = new Array<number>(TECHS.length).fill(TECH_LOCKED);
        t[TOOL_AGE] = TECH_DONE;
        t[BRONZE_AGE] = TECH_LOCKED;
        return t;
      })(),
    });

    const intents = planner.propose(createPlannerInput(toolObs, getBotProfile('medium'), createArbiterState(), state, 1));
    expect(intents.some((i) => i.command.type === 'build' && i.command.unitType === MARKET)).toBe(true);
    expect(intents.some((i) => i.command.type === 'research' && i.command.tech === BRONZE_AGE)).toBe(false);

    // Once Market + Range are built and BRONZE_AGE is TECH_AVAILABLE
    const bronzeReadyObs = makeObservation({
      age: 2,
      resources: { food: 850, wood: 300, stone: 150, gold: 0 },
      ownBuildings: [
        makeBuilding({ id: 10, type: TOWN_CENTER }),
        makeBuilding({ id: 11, type: GRANARY }),
        makeBuilding({ id: 12, type: BARRACKS }),
        makeBuilding({ id: 13, type: MARKET }),
        makeBuilding({ id: 14, type: ARCHERY_RANGE }),
      ],
      enabledMasters: toolObs.enabledMasters,
      techStates: (() => {
        const t = new Array<number>(TECHS.length).fill(TECH_LOCKED);
        t[TOOL_AGE] = TECH_DONE;
        t[BRONZE_AGE] = TECH_AVAILABLE;
        return t;
      })(),
    });
    const bronzeIntents = planner.propose(createPlannerInput(bronzeReadyObs, getBotProfile('medium'), createArbiterState(), state, 1));
    const bronzeResearch = bronzeIntents.find((i) => i.command.type === 'research' && i.command.tech === BRONZE_AGE);
    expect(bronzeResearch).toBeDefined();
    expect(bronzeResearch!.cost?.food).toBe(800);
  });

  test('respects real civ tech trees (Persian cannot build Academy, Macedonian cannot build Temple) and never loops invalid builds/research', () => {
    // Check real World observations for Persian (9) and Macedonian (16) started in Bronze Age
    for (const civ of [CIV_PERSIAN, CIV_MACEDONIAN]) {
      const world = new World({
        players: 3,
        civs: [0, CIV_EGYPTIAN, civ],
        startingAge: 4, // AGE_BRONZE
        units: [
          { owner: 2, type: TOWN_CENTER, x: 10.5, y: 10.5 },
          { owner: 2, type: HOUSE, x: 6.5, y: 10.5 },
          { owner: 2, type: HOUSE, x: 6.5, y: 13.5 },
          { owner: 2, type: GRANARY, x: 14.5, y: 8.5 },
          { owner: 2, type: STORAGE_PIT, x: 14.5, y: 11.5 },
          { owner: 2, type: BARRACKS, x: 14.5, y: 14.5 },
          { owner: 2, type: MARKET, x: 10.5, y: 15.5 },
          { owner: 2, type: ARCHERY_RANGE, x: 14.5, y: 18.5 },
          { owner: 2, type: STABLE, x: 10.5, y: 19.5 },
          { owner: 2, type: VILLAGER, x: 8.5, y: 10.5 },
          { owner: 2, type: VILLAGER, x: 8.5, y: 11.5 },
          { owner: 2, type: VILLAGER, x: 8.5, y: 12.5 },
          { owner: 2, type: VILLAGER, x: 9.5, y: 12.5 },
        ],
        victory: { type: VICTORY_SPECIAL },
      });
      world.attributes[2]![ATTR_WOOD] = 1500;
      world.attributes[2]![ATTR_FOOD] = 1500;
      world.attributes[2]![ATTR_GOLD] = 1500;
      world.attributes[2]![ATTR_HEADROOM] = 10;
      world.runTurn();

      const { observation: obs } = createBotObservation(world, 2);
      const planner = createProgressionPlanner();
      const state = makePlannerState();
      const arbiter = createArbiterState();

      // Run several propose/commit steps without actually building to verify no forbidden building is ever proposed
      const proposedBuildingTypes = new Set<number>();
      for (let step = 0; step < 5; step++) {
        const res = runProposeCommitCycle([planner], obs, getBotProfile('hard'), arbiter, state, 42);
        for (const intent of res.accepted) {
          if (intent.command.type === 'build') {
            proposedBuildingTypes.add(intent.command.unitType);
            // Every proposed building must actually be enabled in observation
            expect(obs.enabledMasters[intent.command.unitType]?.enabled).toBe(true);
          }
          if (intent.command.type === 'research') {
            expect(obs.techStates[intent.command.tech]).toBe(TECH_AVAILABLE);
          }
        }
      }

      if (civ === CIV_PERSIAN) {
        expect(obs.enabledMasters[ACADEMY]?.enabled).toBe(false);
        expect(proposedBuildingTypes.has(ACADEMY)).toBe(false);
      }
      if (civ === CIV_MACEDONIAN) {
        expect(obs.enabledMasters[TEMPLE]?.enabled).toBe(false);
        expect(proposedBuildingTypes.has(TEMPLE)).toBe(false);
      }
    }

    // Iron Age requires 1000F + 800G: with 1000F and 700G, MUST NOT propose IRON_AGE
    const lowGoldObs = makeObservation({
      age: 3,
      resources: { food: 1200, wood: 500, stone: 150, gold: 700 },
      ownBuildings: [
        makeBuilding({ id: 10, type: TOWN_CENTER }),
        makeBuilding({ id: 11, type: GOVERNMENT_CENTER }),
        makeBuilding({ id: 12, type: TEMPLE }),
      ],
      enabledMasters: makeStandardMasters({
        [GOVERNMENT_CENTER]: makeMaster(GOVERNMENT_CENTER, { enabled: true, wood: 175 }),
        [TEMPLE]: makeMaster(TEMPLE, { enabled: true, wood: 150 }),
      }),
      techStates: (() => {
        const t = new Array<number>(TECHS.length).fill(TECH_LOCKED);
        t[TOOL_AGE] = TECH_DONE;
        t[BRONZE_AGE] = TECH_DONE;
        t[IRON_AGE] = TECH_AVAILABLE;
        return t;
      })(),
    });
    const planner = createProgressionPlanner();
    const intents = planner.propose(
      createPlannerInput(lowGoldObs, getBotProfile('medium'), createArbiterState(), makePlannerState(), 1),
    );
    expect(intents.some((i) => i.command.type === 'research' && i.command.tech === IRON_AGE)).toBe(false);
  });
});

describe('T04 G02 — Tight base placement, proactive housing, pending/unbuilt vs active, builder death & destruction', () => {
  test('proposes proactive House when headroom is low, respects population limit, and finds alternative reachable placement in tight base', () => {
    const w = 64;
    const h = 64;
    const map = new TileMap(w, h);
    const cx = 30;
    const cy = 30;
    const units: StartUnit[] = [
      { owner: 2, type: TOWN_CENTER, x: cx + 0.5, y: cy + 0.5 },
      { owner: 2, type: VILLAGER, x: cx - 2.5, y: cy + 0.5 },
    ];
    // Surrounded by water out to distance 16 except a 1-tile walking bridge east to open grass
    for (let x = cx - 16; x <= cx + 16; x++) {
      for (let y = cy - 16; y <= cy + 16; y++) {
        if (Math.abs(x - cx) <= 2 && Math.abs(y - cy) <= 2) continue;
        if (x === cx - 3 && y === cy) continue;
        if (y === cy && x > cx + 2) continue;
        map.setTile(x, y, TERRAIN_WATER);
      }
    }
    const world = new World({ players: 3, map, units, victory: { type: VICTORY_SPECIAL } });
    world.attributes[2]![ATTR_WOOD] = 300;
    world.attributes[2]![ATTR_HEADROOM] = 1;
    world.visibility.exploreRect(2, cx - 26, cy - 26, cx + 26, cy + 26);

    const { observation: obs } = createBotObservation(world, 2);
    const planner = createProgressionPlanner();
    const arbiter = createArbiterState();
    const state = makePlannerState();

    const res1 = runProposeCommitCycle([planner], obs, getBotProfile('medium'), arbiter, state, 10);
    const house1 = res1.accepted.find((i) => i.command.type === 'build' && i.command.unitType === HOUSE);
    expect(house1).toBeDefined();
    if (house1?.command.type === 'build') {
      expect(checkPlacement(world.gameContext(), master(world, 2, HOUSE), house1.command.x, house1.command.y, true, true, 2)).toBe(0);
      expect(obs.canReach(house1.command.units[0]!, house1.command.x, house1.command.y, 2.5, true)).toBe(true);
    }

    // Even if another villager is added and House is still pending, second build (e.g. Granary) must NOT overlap pending House spot!
    const v2 = world.createObject(2, VILLAGER, cx - 2.5, cy + 1.5, 0);
    world.runTurn();
    const { observation: obs2 } = createBotObservation(world, 2);
    const res2 = runProposeCommitCycle([planner], obs2, getBotProfile('medium'), arbiter, state, 10);
    for (const intent of res2.accepted) {
      if (intent.command.type === 'build' && house1?.command.type === 'build') {
        expect(
          Math.abs(intent.command.x - house1.command.x) >= 2 || Math.abs(intent.command.y - house1.command.y) >= 2,
        ).toBe(true);
      }
    }
    expect(v2.id).toBeGreaterThan(0);

    // At population limit, must NOT propose additional Houses
    const atCapObs = makeObservation({
      population: { current: 50, limit: 50, headroom: 0 },
      resources: { food: 500, wood: 500, stone: 150, gold: 0 },
    });
    const capIntents = planner.propose(createPlannerInput(atCapObs, getBotProfile('medium'), createArbiterState(), makePlannerState(), 1));
    expect(capIntents.some((i) => i.command.type === 'build' && i.command.unitType === HOUSE)).toBe(false);
  });

  test('never counts pending or unbuilt foundations as completed age-up prerequisites, and recovers when builder dies or foundation is destroyed', () => {
    const planner = createProgressionPlanner();
    const arbiter = createArbiterState();
    const state = makePlannerState();

    // 1. Unbuilt Granary + unbuilt Storage Pit: TOOL_AGE is locked; no duplicate foundations; orphan unbuilt gets work command!
    const unbuiltObs = makeObservation({
      turn: 5,
      resources: { food: 600, wood: 400, stone: 150, gold: 0 },
      ownUnits: [
        makeUnit({ id: 1, x: 9.5, y: 10.5 }), // idle living villager (original builder died!)
        makeUnit({ id: 2, x: 10.5, y: 10.5, isWorkActive: true, workTarget: 12 }), // working on Storage Pit
        makeUnit({ id: 3, x: 11.5, y: 10.5 }),
      ],
      ownBuildings: [
        makeBuilding({ id: 10, type: TOWN_CENTER }),
        makeBuilding({ id: 11, type: GRANARY, isUnbuilt: true, state: ObjectState.Unbuilt, buildPoints: 10, requiredBuildPoints: 30 }),
        makeBuilding({ id: 12, type: STORAGE_PIT, isUnbuilt: true, state: ObjectState.Unbuilt, buildPoints: 15, requiredBuildPoints: 30 }),
      ],
      techStates: (() => {
        const t = new Array<number>(TECHS.length).fill(TECH_LOCKED);
        t[TOOL_AGE] = TECH_LOCKED;
        return t;
      })(),
    });

    const resUnbuilt = runProposeCommitCycle([planner], unbuiltObs, getBotProfile('medium'), arbiter, state, 7);
    // Must NOT propose TOOL_AGE or duplicate Granary/Storage Pit
    expect(resUnbuilt.accepted.some((i) => i.command.type === 'research' && i.command.tech === TOOL_AGE)).toBe(false);
    expect(resUnbuilt.accepted.some((i) => i.command.type === 'build' && (i.command.unitType === GRANARY || i.command.unitType === STORAGE_PIT))).toBe(false);
    // MUST assign an available living villager to resume orphaned unbuilt Granary (id: 11)
    const resumeGranary = resUnbuilt.accepted.find((i) => i.command.type === 'work' && i.command.target === 11);
    expect(resumeGranary).toBeDefined();

    // 2. If foundation 11 (Granary) is destroyed before completion, planner rebuilds Granary on next tick
    reconcilePending(
      makeObservation({ turn: 15, ownBuildings: [makeBuilding({ id: 10 }), makeBuilding({ id: 12 })] }),
      arbiter,
    );
    const destroyedObs = makeObservation({
      turn: 15,
      resources: { food: 600, wood: 400, stone: 150, gold: 0 },
      ownUnits: [makeUnit({ id: 1 }), makeUnit({ id: 3 })],
      ownBuildings: [
        makeBuilding({ id: 10, type: TOWN_CENTER }),
        makeBuilding({ id: 12, type: STORAGE_PIT }),
      ],
    });
    const resDestroyed = runProposeCommitCycle([planner], destroyedObs, getBotProfile('medium'), arbiter, state, 7);
    expect(resDestroyed.accepted.some((i) => i.command.type === 'build' && i.command.unitType === GRANARY)).toBe(true);

    // 3. If builder dies while `build` is pending in CTI=2, reconcilePending fails it and planner retries with surviving builder
    const buildIntent = resDestroyed.accepted.find((i) => i.command.type === 'build' && i.command.unitType === GRANARY)!;
    const deadBuilderId = buildIntent.unitIds![0]!;
    const survivingUnits = destroyedObs.ownUnits.filter((u) => u.id !== deadBuilderId);
    const afterDeathObs = makeObservation({
      turn: 16,
      resources: { food: 600, wood: 400, stone: 150, gold: 0 },
      ownUnits: survivingUnits,
      ownBuildings: destroyedObs.ownBuildings,
    });
    const resAfterDeath = runProposeCommitCycle([planner], afterDeathObs, getBotProfile('medium'), arbiter, state, 7);
    const retryGranary = resAfterDeath.accepted.find((i) => i.command.type === 'build' && i.command.unitType === GRANARY);
    expect(retryGranary).toBeDefined();
    expect(retryGranary!.unitIds![0]).not.toBe(deadBuilderId);
  });
});

describe('T04 G03 — Strategic buildings past 2 Bronze buildings without forcing useless/disabled buildings', () => {
  test('continues building missing strategic military/support buildings even when Iron Age is already available or done', () => {
    // Player is in Bronze Age with Gov Center + Temple built (Iron Age TECH_AVAILABLE),
    // and Range + Stable built, so Siege Workshop + Academy are enabled and missing!
    const obs = makeObservation({
      age: 3,
      civ: CIV_GREEK,
      resources: { food: 1200, wood: 800, stone: 200, gold: 900 },
      population: { current: 10, limit: 50, headroom: 10 },
      ownUnits: Array.from({ length: 8 }, (_, idx) => makeUnit({ id: idx + 1, x: 8.5 + idx, y: 10.5 })),
      ownBuildings: [
        makeBuilding({ id: 10, type: TOWN_CENTER }),
        makeBuilding({ id: 11, type: GRANARY }),
        makeBuilding({ id: 12, type: STORAGE_PIT }),
        makeBuilding({ id: 13, type: BARRACKS }),
        makeBuilding({ id: 14, type: MARKET }),
        makeBuilding({ id: 15, type: ARCHERY_RANGE }),
        makeBuilding({ id: 16, type: STABLE }),
        makeBuilding({ id: 17, type: GOVERNMENT_CENTER }),
        makeBuilding({ id: 18, type: TEMPLE }),
      ],
      enabledMasters: makeStandardMasters({
        [MARKET]: makeMaster(MARKET, { enabled: true, wood: 150 }),
        [ARCHERY_RANGE]: makeMaster(ARCHERY_RANGE, { enabled: true, wood: 150 }),
        [STABLE]: makeMaster(STABLE, { enabled: true, wood: 150 }),
        [GOVERNMENT_CENTER]: makeMaster(GOVERNMENT_CENTER, { enabled: true, wood: 175 }),
        [TEMPLE]: makeMaster(TEMPLE, { enabled: true, wood: 150 }),
        [SIEGE_WORKSHOP]: makeMaster(SIEGE_WORKSHOP, { enabled: true, wood: 200 }),
        [ACADEMY]: makeMaster(ACADEMY, { enabled: true, wood: 200 }),
      }),
      techStates: (() => {
        const t = new Array<number>(TECHS.length).fill(TECH_AVAILABLE);
        t[TOOL_AGE] = TECH_DONE;
        t[BRONZE_AGE] = TECH_DONE;
        t[IRON_AGE] = TECH_AVAILABLE;
        return t;
      })(),
    });

    const planner = createProgressionPlanner({ strategy: 'balanced' });
    const arbiter = createArbiterState();
    const state = makePlannerState();

    const res = runProposeCommitCycle([planner], obs, getBotProfile('medium'), arbiter, state, 99);
    // Proposes IRON_AGE research AND still proposes missing strategic Siege Workshop or Academy
    expect(res.accepted.some((i) => i.command.type === 'research' && i.command.tech === IRON_AGE)).toBe(true);
    expect(
      res.accepted.some(
        (i) => i.command.type === 'build' && (i.command.unitType === SIEGE_WORKSHOP || i.command.unitType === ACADEMY),
      ),
    ).toBe(true);
  });

  test('does not force unrelated or civ-disabled buildings when strategy is focused and Iron Age is already unlocked', () => {
    // Cavalry strategy in Iron Age with Gov Center + Siege Workshop already built, Stable x2 built:
    // Should NOT force Temple or Academy if outside strategy and Iron Age already done!
    const obs = makeObservation({
      age: 4,
      civ: CIV_GREEK,
      resources: { food: 1200, wood: 800, stone: 200, gold: 900 },
      population: { current: 12, limit: 50, headroom: 10 },
      ownUnits: Array.from({ length: 8 }, (_, idx) => makeUnit({ id: idx + 1, x: 8.5 + idx, y: 10.5 })),
      ownBuildings: [
        makeBuilding({ id: 10, type: TOWN_CENTER }),
        makeBuilding({ id: 11, type: GRANARY }),
        makeBuilding({ id: 12, type: STORAGE_PIT }),
        makeBuilding({ id: 13, type: BARRACKS }),
        makeBuilding({ id: 14, type: MARKET }),
        makeBuilding({ id: 15, type: ARCHERY_RANGE }),
        makeBuilding({ id: 16, type: STABLE }),
        makeBuilding({ id: 17, type: STABLE, x: 18.5 }),
        makeBuilding({ id: 18, type: GOVERNMENT_CENTER }),
        makeBuilding({ id: 19, type: SIEGE_WORKSHOP }),
      ],
      enabledMasters: makeStandardMasters({
        [MARKET]: makeMaster(MARKET, { enabled: true, wood: 150 }),
        [ARCHERY_RANGE]: makeMaster(ARCHERY_RANGE, { enabled: true, wood: 150 }),
        [STABLE]: makeMaster(STABLE, { enabled: true, wood: 150 }),
        [GOVERNMENT_CENTER]: makeMaster(GOVERNMENT_CENTER, { enabled: true, wood: 175 }),
        [TEMPLE]: makeMaster(TEMPLE, { enabled: true, wood: 150 }),
        [SIEGE_WORKSHOP]: makeMaster(SIEGE_WORKSHOP, { enabled: true, wood: 200 }),
        [ACADEMY]: makeMaster(ACADEMY, { enabled: true, wood: 200 }),
      }),
      techStates: (() => {
        const t = new Array<number>(TECHS.length).fill(TECH_AVAILABLE);
        t[TOOL_AGE] = TECH_DONE;
        t[BRONZE_AGE] = TECH_DONE;
        t[IRON_AGE] = TECH_DONE;
        return t;
      })(),
    });

    const cavPlanner = createProgressionPlanner({ strategy: 'cavalry' });
    const intents = cavPlanner.propose(
      createPlannerInput(obs, getBotProfile('medium'), createArbiterState(), makePlannerState(), 1),
    );
    expect(intents.some((i) => i.command.type === 'build' && i.command.unitType === TEMPLE)).toBe(false);
    expect(intents.some((i) => i.command.type === 'build' && i.command.unitType === ACADEMY)).toBe(false);
  });
});

describe('T04 Contract, Determinism & Multi-Tick @aoe/sim Integration', () => {
  test('propose is pure, never calls Date/Math.random, and rejected intents do not mutate cooldowns', () => {
    const dateSpy = vi.spyOn(Date, 'now').mockImplementation(() => {
      throw new Error('Date.now forbidden');
    });
    const randSpy = vi.spyOn(Math, 'random').mockImplementation(() => {
      throw new Error('Math.random forbidden');
    });

    try {
      const obs = makeObservation({
        resources: { food: 600, wood: 300, stone: 150, gold: 0 },
        ownBuildings: [
          makeBuilding({ id: 10, type: TOWN_CENTER }),
          makeBuilding({ id: 11, type: GRANARY }),
          makeBuilding({ id: 12, type: STORAGE_PIT }),
        ],
        techStates: (() => {
          const t = new Array<number>(TECHS.length).fill(TECH_LOCKED);
          t[TOOL_AGE] = TECH_AVAILABLE;
          return t;
        })(),
      });

      const plannerA = new ProgressionPlanner();
      const plannerB = new ProgressionPlanner();
      const stateA = makePlannerState();
      const stateB = makePlannerState();

      const snapshotBefore = JSON.stringify(stateA);
      const intentsA = plannerA.propose(createPlannerInput(obs, getBotProfile('medium'), createArbiterState(), stateA, 123));
      const intentsB = plannerB.propose(createPlannerInput(obs, getBotProfile('medium'), createArbiterState(), stateB, 123));

      // Zero state mutation during propose()
      expect(JSON.stringify(stateA)).toBe(snapshotBefore);
      // Deterministic output
      expect(intentsA).toEqual(intentsB);

      // Rejected outcomes must NOT record cooldowns
      const rejectedOutcomes = Object.fromEntries(
        intentsA.map((i) => [i.key, { key: i.key, accepted: false, reason: 'insufficient-budget' as const }]),
      );
      plannerA.commit(rejectedOutcomes, createPlannerInput(obs, getBotProfile('medium'), createArbiterState(), stateA, 123));
      expect(stateA.unitCooldownUntil).toEqual({});
      expect(stateA.buildingCooldownUntil).toEqual({});
    } finally {
      dateSpy.mockRestore();
      randSpy.mockRestore();
    }
  });

  test('multi-tick integration via real World + world.addBatch + COMMAND_DELAY_TURNS=2 + createBotObservation + arbitrateIntents reaches Iron Age and full building chain', () => {
    const world = new World({
      players: 3,
      civs: [0, CIV_EGYPTIAN, CIV_GREEK],
      units: startingObjects(3),
      victory: { type: VICTORY_SPECIAL },
    });
    world.attributes[2]![ATTR_FOOD] = 4000;
    world.attributes[2]![ATTR_WOOD] = 3500;
    world.attributes[2]![ATTR_GOLD] = 2000;
    world.attributes[2]![ATTR_STONE] = 600;
    world.cheats.quickBuild = true;

    // Add a couple more villagers so building chain executes swiftly, keeping headroom tight so Houses are built
    world.createObject(2, VILLAGER, 33.5, 30.5, 0);
    world.createObject(2, VILLAGER, 34.5, 30.5, 0);
    world.attributes[2]![ATTR_HEADROOM] = 1;

    const planner = createProgressionPlanner({ strategy: 'balanced' });
    const arbiter = createArbiterState();
    const plannerState = makePlannerState();
    const profile = getBotProfile('medium');
    let memory: BotPlannerMemory = createEmptyBotMemory();
    const allCommands: Command[] = [];

    for (let t = 0; t < 500; t++) {
      const obsOut = createBotObservation(world, 2, memory);
      memory = obsOut.memory;
      const obs = obsOut.observation;

      if (t % 2 === 0) {
        const res = runProposeCommitCycle([planner], obs, profile, arbiter, plannerState, 777);
        if (res.commands.length > 0) {
          allCommands.push(...res.commands);
          world.addBatch(world.turn, 2, res.commands);
        }
      } else {
        reconcilePending(obs, arbiter);
      }

      // Check that during COMMAND_DELAY_TURNS=2, we never double-build Granary or Market
      const buildGranaryCount = allCommands.filter((c) => c.type === 'build' && c.unitType === GRANARY).length;
      const buildMarketCount = allCommands.filter((c) => c.type === 'build' && c.unitType === MARKET).length;
      expect(buildGranaryCount).toBeLessThanOrEqual(1);
      expect(buildMarketCount).toBeLessThanOrEqual(1);

      world.runTurn();
      if (
        world.techs[2]![IRON_AGE] === TECH_DONE &&
        [...world.entities.ofPlayer(2)].some((e) => e.state === ObjectState.Active && e.type === ACADEMY) &&
        [...world.entities.ofPlayer(2)].some((e) => e.state === ObjectState.Active && e.type === SIEGE_WORKSHOP)
      ) {
        break;
      }
    }

    const activeOf = (type: number) =>
      [...world.entities.ofPlayer(2)].filter((e) => e.state === ObjectState.Active && e.type === type).length;

    expect(activeOf(HOUSE)).toBeGreaterThanOrEqual(1);
    expect(activeOf(GRANARY)).toBeGreaterThanOrEqual(1);
    expect(activeOf(STORAGE_PIT)).toBeGreaterThanOrEqual(1);
    expect(activeOf(BARRACKS)).toBeGreaterThanOrEqual(1);
    expect(activeOf(MARKET)).toBeGreaterThanOrEqual(1);
    expect(activeOf(ARCHERY_RANGE)).toBeGreaterThanOrEqual(1);
    expect(activeOf(STABLE)).toBeGreaterThanOrEqual(1);
    expect(activeOf(GOVERNMENT_CENTER)).toBeGreaterThanOrEqual(1);
    expect(activeOf(SIEGE_WORKSHOP)).toBeGreaterThanOrEqual(1);
    expect(activeOf(ACADEMY)).toBeGreaterThanOrEqual(1);
    expect(world.techs[2]![TOOL_AGE]).toBe(TECH_DONE);
    expect(world.techs[2]![BRONZE_AGE]).toBe(TECH_DONE);
    expect(world.techs[2]![IRON_AGE]).toBe(TECH_DONE);
    expect(world.attributes[2]![ATTR_AGE]).toBe(4);
    expect(COMMAND_DELAY_TURNS).toBe(2);
  });

  test('real World recovery: surviving villager finishes orphaned foundation when builder dies, rebuilds destroyed foundation, and skips walled-in builder', () => {
    const map = new TileMap(48, 48);
    const units: StartUnit[] = [
      { owner: 2, type: TOWN_CENTER, x: 10.5, y: 10.5 },
      { owner: 2, type: HOUSE, x: 6.5, y: 10.5 },
      { owner: 2, type: HOUSE, x: 6.5, y: 13.5 },
      // Walled-in villager #1 right next to TC
      { owner: 2, type: VILLAGER, x: 13.5, y: 10.5 },
      // Free villager #2 outside walls
      { owner: 2, type: VILLAGER, x: 18.5, y: 10.5 },
      // Free villager #3 outside walls
      { owner: 2, type: VILLAGER, x: 19.5, y: 10.5 },
    ];
    // Enclose villager #1 at (13.5, 10.5) with Small Walls
    for (let x = 12; x <= 14; x++) {
      units.push({ owner: 2, type: SMALL_WALL, x: x + 0.5, y: 9.5 });
      units.push({ owner: 2, type: SMALL_WALL, x: x + 0.5, y: 11.5 });
    }
    units.push({ owner: 2, type: SMALL_WALL, x: 12.5, y: 10.5 });
    units.push({ owner: 2, type: SMALL_WALL, x: 14.5, y: 10.5 });

    const world = new World({ players: 3, map, units, victory: { type: VICTORY_SPECIAL } });
    world.attributes[2]![ATTR_WOOD] = 600;
    world.attributes[2]![ATTR_HEADROOM] = 6;
    expect(world.tileVisibility(2, 18, 10)).not.toBe(TILE_BLACK);

    const planner = createProgressionPlanner();
    const arbiter = createArbiterState();
    const plannerState = makePlannerState();
    const profile = getBotProfile('medium');
    let memory: BotPlannerMemory = createEmptyBotMemory();

    // Tick 0: must pick a free villager (NOT the walled-in villager!) to build Granary
    const trappedVillager = [...world.entities.ofPlayer(2)].find((e) => e.type === VILLAGER && Math.trunc(e.x) === 13)!;
    const step0 = createBotObservation(world, 2, memory);
    memory = step0.memory;
    const proposed0 = planner.propose(createPlannerInput(step0.observation, profile, arbiter, plannerState, 11));
    const res0 = arbitrateIntents(proposed0, step0.observation, arbiter);
    planner.commit(res0.outcomesByKey, createPlannerInput(step0.observation, profile, arbiter, plannerState, 11));
    const buildGranary = res0.accepted.find((i) => i.command.type === 'build' && i.command.unitType === GRANARY);
    expect(buildGranary).toBeDefined();
    expect(buildGranary!.unitIds).not.toContain(trappedVillager.id);
    world.addBatch(world.turn, 2, res0.commands);

    // Advance past COMMAND_DELAY_TURNS so foundation appears on map
    for (let i = 0; i <= COMMAND_DELAY_TURNS + 1; i++) {
      world.runTurn();
      const o = createBotObservation(world, 2, memory);
      memory = o.memory;
      reconcilePending(o.observation, arbiter);
    }

    const granaryFoundation = [...world.entities.ofPlayer(2)].find(
      (e) => e.type === GRANARY && e.state === ObjectState.Unbuilt,
    );
    expect(granaryFoundation).toBeDefined();

    // Kill the original builder while foundation is still unbuilt
    const firstBuilderId = buildGranary!.unitIds![0]!;
    const firstBuilder = world.entities.get(firstBuilderId)!;
    firstBuilder.hp = 0;
    firstBuilder.state = ObjectState.Dead;
    world.runTurn();

    // Planner must assign the surviving free villager to resume the orphaned Granary foundation
    const stepAfterDeath = createBotObservation(world, 2, memory);
    memory = stepAfterDeath.memory;
    const resResume = runProposeCommitCycle([planner], stepAfterDeath.observation, profile, arbiter, plannerState, 11);
    const resumeCmd = resResume.accepted.find((i) => i.command.type === 'work' && i.command.target === granaryFoundation!.id);
    expect(resumeCmd).toBeDefined();
    expect(resumeCmd!.unitIds).not.toContain(trappedVillager.id);
    expect(resumeCmd!.unitIds).not.toContain(firstBuilderId);

    // Destroy the foundation instead -> planner must rebuild Granary!
    granaryFoundation!.hp = 0;
    granaryFoundation!.state = ObjectState.Dead;
    world.runTurn();

    const stepAfterDestroy = createBotObservation(world, 2, memory);
    const resRebuild = runProposeCommitCycle([planner], stepAfterDestroy.observation, profile, arbiter, plannerState, 11);
    expect(resRebuild.accepted.some((i) => i.command.type === 'build' && i.command.unitType === GRANARY)).toBe(true);
  });
});
