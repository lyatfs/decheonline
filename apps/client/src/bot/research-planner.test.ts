import { describe, expect, test, vi } from 'vitest';
import {
  ARCHERY_RANGE,
  ATTR_FOOD,
  ATTR_GOLD,
  ATTR_WOOD,
  BARRACKS,
  BOWMAN,
  BRONZE_AGE,
  CLUBMAN,
  COMMAND_DELAY_TURNS,
  doTech,
  GRANARY,
  HOUSE,
  IRON_AGE,
  MARKET,
  master,
  ObjectState,
  SCOUT,
  STABLE,
  STORAGE_PIT,
  TECH_AVAILABLE,
  TECH_DISABLED,
  TECH_DONE,
  TECH_LOCKED,
  TECH_RESEARCHING,
  TECHS,
  TileMap,
  TOOL_AGE,
  TOWN_CENTER,
  VICTORY_SPECIAL,
  VILLAGER,
  World,
  type StartUnit,
} from '@aoe/sim';
import { createArbiterState, runProposeCommitCycle } from './budget';
import { getBotProfile } from './difficulty';
import { createBotObservation, createEmptyBotMemory } from './observation';
import { createResearchPlanner, RESEARCH_PRIORITY_TECHS, ResearchPlanner } from './research-planner';
import {
  BOT_CONTRACT_VERSION,
  type BotObservation,
  type BotPlannerState,
  type ObservedMaster,
  type ObservedOwnBuilding,
  type PendingAction,
  type PlannerInput,
} from './types';

const ACADEMY = 0;
const DOCK = 45;
const SIEGE_WORKSHOP = 49;
const TEMPLE = 104;

const CIV_EGYPTIAN = 1;
const CIV_GREEK = 2;
const CIV_PERSIAN = 9;

// Unit IDs (independent of display names)
const SHORT_SWORDSMAN = 75;
const BROAD_SWORDSMAN_SRC = 76;
const LONG_SWORDSMAN_SRC = 77;
const LEGION_SRC = 282;
const AXEMAN_SRC = 74;

const IMPROVED_BOWMAN = 5;
const COMPOSITE_BOWMAN_SRC = 6;
const HORSE_ARCHER = 39;
const HEAVY_HORSE_ARCHER_SRC = 281;

const CAVALRY = 37;
const CATAPHRACT_SRC = 283;
const CHARIOT = 40;
const SCYTHE_CHARIOT_SRC = 339;
const WAR_ELEPHANT = 46;
const ARMORED_ELEPHANT_SRC = 345;

const HOPLITE = 93;
const PHALANX_SRC = 94;
const CENTURION_SRC = 291;

const STONE_THROWER = 35;
const CATAPULT_SRC = 36;
const HEAVY_CATAPULT_SRC = 280;
const BALLISTA = 11;

const SCOUT_SHIP = 19;
const WAR_GALLEY_SRC = 20;
const TRIREME_SRC = 21;

// Tech IDs
const TECH_AXEMAN = 63;
const TECH_SHORT_SWORD = 64;
const TECH_BROAD_SWORD = 65;
const TECH_LONG_SWORD = 66;
const TECH_LEGION = 77;

const TECH_IMPROVED_BOW = 56;
const TECH_COMPOSITE_BOW = 57;
const TECH_HEAVY_HORSE_ARCHER = 38;
const TECH_HORSE_ARCHER = 60;

const TECH_CAVALRY = 69;
const TECH_HEAVY_CAVALRY = 71;
const TECH_CATAPHRACT = 78;
const TECH_SCYTHE_CHARIOT = 126;
const TECH_ARMORED_ELEPHANT = 125;

const TECH_PHALANX = 73;
const TECH_CENTURION = 79;

const TECH_CATAPULT = 54;
const TECH_HEAVY_CATAPULT = 36;

const TECH_WAR_GALLEY = 5;
const TECH_TRIREME = 7;

const TECH_WOODWORKING = 107;
const TECH_DOMESTICATION = 81;
const TECH_TOOL_ARMOR_INF = 40;

function makeMaster(
  id: number,
  overrides: Partial<ObservedMaster> = {},
): ObservedMaster {
  return {
    id,
    name: `Master-${id}`,
    masterType: 70,
    group: 6,
    hitPoints: 40,
    los: 4,
    fogFlag: 0,
    speed: 1.2,
    radiusX: 0.3,
    radiusY: 0.3,
    clearanceX: 0.35,
    clearanceY: 0.35,
    terrainRestriction: 7,
    unitLevel: 4,
    trackAsResource: 0,
    resourceGroup: 0,
    enabled: false,
    costs: [
      { type: ATTR_FOOD, amount: 50, flag: 1 },
      { type: 4, amount: 1, flag: 0 },
    ],
    trainTime: 25,
    trainLocationId: BARRACKS,
    combat: {
      range: 0,
      minRange: 0,
      baseArmour: 0,
      attacks: [{ group: 4, amount: 5 }],
    },
    ...overrides,
  };
}

function makeBuilding(overrides: Partial<ObservedOwnBuilding> & { id: number }): ObservedOwnBuilding {
  return {
    type: BARRACKS,
    x: 12.5,
    y: 12.5,
    hp: 350,
    maxHp: 350,
    state: ObjectState.Active,
    isUnbuilt: false,
    buildPoints: 30,
    requiredBuildPoints: 30,
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
    memory: createEmptyBotMemory(),
  };
}

function makeObservation(overrides: Partial<BotObservation> = {}): BotObservation {
  const techStates = new Array<number>(TECHS.length).fill(TECH_LOCKED);
  return {
    contractVersion: BOT_CONTRACT_VERSION,
    player: 2,
    turn: 10,
    worldTime: 5000,
    age: 2,
    civ: CIV_GREEK,
    mapWidth: 64,
    mapHeight: 64,
    resources: { food: 1000, wood: 1000, stone: 500, gold: 1000 },
    population: { current: 6, limit: 20, headroom: 14 },
    ownUnits: [],
    ownBuildings: [makeBuilding({ id: 20, type: BARRACKS })],
    knownEnemies: [],
    knownResources: [],
    techStates,
    enabledMasters: {
      [BARRACKS]: makeMaster(BARRACKS, { masterType: 80, group: 3, unitLevel: 2, enabled: true, trainLocationId: 118, combat: null }),
      [CLUBMAN]: makeMaster(CLUBMAN, { enabled: true, hitPoints: 40, trainLocationId: BARRACKS }),
      [AXEMAN_SRC]: makeMaster(AXEMAN_SRC, { enabled: false, hitPoints: 50, trainLocationId: BARRACKS }),
      [SHORT_SWORDSMAN]: makeMaster(SHORT_SWORDSMAN, {
        enabled: false,
        hitPoints: 60,
        trainLocationId: BARRACKS,
        costs: [
          { type: ATTR_FOOD, amount: 35, flag: 1 },
          { type: ATTR_GOLD, amount: 15, flag: 1 },
          { type: 4, amount: 1, flag: 0 },
        ],
      }),
    },
    canReach: () => true,
    isTileExplored: () => true,
    isTileVisible: () => true,
    findNearestExploreTarget: () => null,
    canPlaceBuilding: () => true,
    findBuildPlacement: () => ({ x: 16, y: 16 }),
    findDockPlacement: () => null,
    ...overrides,
  };
}

function makeInput(
  obs: BotObservation,
  difficulty: 'easy' | 'medium' | 'hard' = 'hard',
  state: BotPlannerState = makePlannerState(),
  pendingActions: readonly PendingAction[] = [],
  seed = 12345,
): PlannerInput {
  return {
    observation: obs,
    profile: getBotProfile(difficulty),
    state,
    seed,
    pendingActions,
  };
}

describe('T05 R01 — Validation against TECHS, civ tree, building location, busy buildings & non-starvation', () => {
  test('never proposes disabled, locked, researching, or done techs, nor techs for wrong building location', () => {
    const planner = createResearchPlanner();
    const techStates = new Array<number>(TECHS.length).fill(TECH_LOCKED);
    techStates[TECH_AXEMAN] = TECH_DISABLED; // disabled by civ/scenario
    techStates[TECH_SHORT_SWORD] = TECH_LOCKED; // prerequisites unmet
    techStates[TECH_IMPROVED_BOW] = TECH_DONE; // already done
    techStates[TECH_WOODWORKING] = TECH_RESEARCHING; // already researching
    techStates[TECH_DOMESTICATION] = TECH_AVAILABLE; // valid Market tech, but player has NO Market!
    techStates[TECH_TOOL_ARMOR_INF] = TECH_AVAILABLE; // valid Storage Pit tech, but player has NO Storage Pit!

    const obs = makeObservation({
      techStates,
      ownBuildings: [
        makeBuilding({ id: 20, type: BARRACKS }),
        makeBuilding({ id: 21, type: ARCHERY_RANGE }),
      ],
    });

    const intents = planner.propose(makeInput(obs, 'hard'));
    const researchIntents = intents.filter((i) => i.command.type === 'research');
    expect(researchIntents).toHaveLength(0);
  });

  test('never issues research on busy (training/queuing/researching), unbuilt, or cooldown buildings, and respects building location', () => {
    const planner = createResearchPlanner();
    const techStates = new Array<number>(TECHS.length).fill(TECH_LOCKED);
    techStates[TECH_AXEMAN] = TECH_AVAILABLE; // loc=BARRACKS
    techStates[TECH_IMPROVED_BOW] = TECH_AVAILABLE; // loc=ARCHERY_RANGE
    techStates[TECH_WOODWORKING] = TECH_AVAILABLE; // loc=MARKET
    techStates[TECH_TOOL_ARMOR_INF] = TECH_AVAILABLE; // loc=STORAGE_PIT

    const state = makePlannerState();
    state.buildingCooldownUntil[24] = 15; // turn is 10 -> on cooldown

    const obs = makeObservation({
      turn: 10,
      techStates,
      ownBuildings: [
        // Barracks 20: currently training
        makeBuilding({ id: 20, type: BARRACKS, trainingUnit: CLUBMAN, queueLength: 1, queuedUnits: [{ unit: CLUBMAN, count: 1 }], isBusy: true }),
        // Barracks 21: has queued units
        makeBuilding({ id: 21, type: BARRACKS, queueLength: 2, queuedUnits: [{ unit: CLUBMAN, count: 2 }], isBusy: true }),
        // Range 22: already researching
        makeBuilding({ id: 22, type: ARCHERY_RANGE, researchingTech: TECH_IMPROVED_BOW, isBusy: true }),
        // Market 23: unbuilt foundation
        makeBuilding({ id: 23, type: MARKET, state: ObjectState.Unbuilt, isUnbuilt: true, hp: 1 }),
        // Storage Pit 24: on cooldown
        makeBuilding({ id: 24, type: STORAGE_PIT }),
      ],
    });

    const intents = planner.propose(makeInput(obs, 'hard', state));
    expect(intents.filter((i) => i.command.type === 'research')).toHaveLength(0);
    // Also must NOT queue units onto Range 22 (researching) or Market 23 (unbuilt) or Storage Pit 24 (cooldown)
    for (const i of intents) {
      if (i.command.type === 'queue') {
        expect(i.command.building).not.toBe(22);
        expect(i.command.building).not.toBe(23);
        expect(i.command.building).not.toBe(24);
      }
    }
  });

  test('never starves training when TC is actively researching Age-Up or when upgrades are unaffordable', () => {
    const planner = createResearchPlanner();
    const techStates = new Array<number>(TECHS.length).fill(TECH_LOCKED);
    techStates[TOOL_AGE] = TECH_DONE;
    techStates[BRONZE_AGE] = TECH_RESEARCHING; // TC already researching Bronze Age!
    techStates[TECH_AXEMAN] = TECH_LOCKED; // No affordable research at Barracks

    const obs = makeObservation({
      age: 2,
      techStates,
      resources: { food: 250, wood: 100, stone: 0, gold: 0 },
      ownBuildings: [
        makeBuilding({ id: 10, type: TOWN_CENTER, researchingTech: BRONZE_AGE, isBusy: true }),
        makeBuilding({ id: 20, type: BARRACKS }),
      ],
    });

    const intents = planner.propose(makeInput(obs, 'medium'));
    expect(intents.some((i) => i.command.type === 'queue' && i.command.building === 20)).toBe(true);
  });

  test('never uses a single busy Barracks to starve all research forever, and lets research run once idle', () => {
    const planner = createResearchPlanner();
    const techStates = new Array<number>(TECHS.length).fill(TECH_LOCKED);
    techStates[TECH_AXEMAN] = TECH_AVAILABLE; // 100F

    // When Barracks already has 1 unit queued and upgrade 63 is affordable, do NOT stack another queue on top
    const obsBusy = makeObservation({
      resources: { food: 300, wood: 100, stone: 0, gold: 0 },
      techStates,
      ownBuildings: [
        makeBuilding({ id: 20, type: BARRACKS, trainingUnit: CLUBMAN, queueLength: 1, queuedUnits: [{ unit: CLUBMAN, count: 1 }], isBusy: true }),
      ],
    });
    const busyIntents = planner.propose(makeInput(obsBusy, 'medium'));
    expect(busyIntents.filter((i) => i.command.type === 'research')).toHaveLength(0);
    expect(busyIntents.filter((i) => i.command.type === 'queue' && i.command.building === 20)).toHaveLength(0);

    // Once Barracks becomes idle, it immediately researches Tech 63 (Axeman)
    const obsIdle = makeObservation({
      resources: { food: 300, wood: 100, stone: 0, gold: 0 },
      techStates,
      ownBuildings: [makeBuilding({ id: 20, type: BARRACKS })],
    });
    const idleIntents = planner.propose(makeInput(obsIdle, 'medium'));
    expect(idleIntents.some((i) => i.command.type === 'research' && i.command.building === 20 && i.command.tech === TECH_AXEMAN)).toBe(true);
  });
});

describe('T05 R02 — Multi-age unit upgrades, copyObj semantics, civ trees & name-independent lineage', () => {
  test('never relies on Vietnamese or English display names to link upgrade trees or train units', () => {
    const planner = createResearchPlanner();
    const techStates = new Array<number>(TECHS.length).fill(TECH_LOCKED);
    techStates[TECH_AXEMAN] = TECH_DONE;
    techStates[TECH_SHORT_SWORD] = TECH_DONE;
    techStates[TECH_BROAD_SWORD] = TECH_DONE;
    techStates[TECH_LONG_SWORD] = TECH_DONE;
    techStates[TECH_LEGION] = TECH_DONE;

    // Scramble all display names to misleading Vietnamese labels
    const obs = makeObservation({
      age: 4,
      techStates,
      ownBuildings: [makeBuilding({ id: 20, type: BARRACKS })],
      enabledMasters: {
        [CLUBMAN]: makeMaster(CLUBMAN, { name: 'Lính Cùi Bắp', enabled: true, hitPoints: 50, trainLocationId: BARRACKS }),
        [SHORT_SWORDSMAN]: makeMaster(SHORT_SWORDSMAN, {
          name: 'Chiến Binh Huyền Thoại Tiếng Việt',
          enabled: true,
          hitPoints: 160,
          trainLocationId: BARRACKS,
          costs: [
            { type: ATTR_FOOD, amount: 35, flag: 1 },
            { type: ATTR_GOLD, amount: 15, flag: 1 },
            { type: 4, amount: 1, flag: 0 },
          ],
          combat: { range: 0, minRange: 0, baseArmour: 1, attacks: [{ group: 4, amount: 13 }] },
        }),
        [BROAD_SWORDSMAN_SRC]: makeMaster(BROAD_SWORDSMAN_SRC, { name: 'Kiếm Rộng', enabled: false, hitPoints: 70, trainLocationId: BARRACKS }),
        [LONG_SWORDSMAN_SRC]: makeMaster(LONG_SWORDSMAN_SRC, { name: 'Kiếm Dài', enabled: false, hitPoints: 80, trainLocationId: BARRACKS }),
        [LEGION_SRC]: makeMaster(LEGION_SRC, { name: 'Quân Đoàn', enabled: false, hitPoints: 160, trainLocationId: BARRACKS }),
      },
    });

    const intents = planner.propose(makeInput(obs, 'hard'));
    const queue = intents.find((i) => i.command.type === 'queue');
    expect(queue).toBeDefined();
    if (queue?.command.type === 'queue') {
      expect(queue.command.unit).toBe(SHORT_SWORDSMAN); // Destination ID 75, NOT 282 or 73!
    }
  });

  test('Clubman -> Axeman line: upgrades tech 63, keeps destination ID 73, and never queues un-upgraded source 74', () => {
    const world = new World({
      players: 3,
      civs: [0, CIV_GREEK, CIV_EGYPTIAN],
      map: new TileMap(40, 40),
      units: [
        { owner: 2, type: TOWN_CENTER, x: 10.5, y: 10.5 },
        { owner: 2, type: HOUSE, x: 6.5, y: 10.5 },
        { owner: 2, type: GRANARY, x: 6.5, y: 14.5 },
        { owner: 2, type: STORAGE_PIT, x: 10.5, y: 14.5 },
        { owner: 2, type: BARRACKS, x: 14.5, y: 10.5 },
        { owner: 2, type: VILLAGER, x: 8.5, y: 10.5 },
      ],
      victory: { type: VICTORY_SPECIAL },
    });
    // Advance to Tool Age via real doTech
    doTech(world.gameContext(), 2, 10); // Granary built
    doTech(world.gameContext(), 2, 39); // Storage Pit built
    doTech(world.gameContext(), 2, 62); // Barracks built -> enables Clubman (73)
    doTech(world.gameContext(), 2, TOOL_AGE);
    world.attributes[2]![ATTR_FOOD] = 500;
    world.attributes[2]![ATTR_WOOD] = 0; // Keep wood 0 so only Clubman/Axeman (50F) is affordable

    const planner = new ResearchPlanner();
    const { observation: obsBefore } = createBotObservation(world, 2);
    expect(obsBefore.techStates[TECH_AXEMAN]).toBe(TECH_AVAILABLE);
    expect(obsBefore.enabledMasters[CLUBMAN]?.hitPoints).toBe(40);
    expect(obsBefore.enabledMasters[AXEMAN_SRC]?.enabled).toBe(false);

    const intentsBefore = planner.propose(makeInput(obsBefore, 'easy'));
    expect(intentsBefore.some((i) => i.command.type === 'research' && i.command.tech === TECH_AXEMAN)).toBe(true);

    // Complete Axeman (63): copyObj copies 74 -> 73, keeping ID 73 enabled and 74 disabled
    expect(doTech(world.gameContext(), 2, TECH_AXEMAN)).toBe(true);
    const { observation: obsAfter } = createBotObservation(world, 2);
    expect(obsAfter.techStates[TECH_AXEMAN]).toBe(TECH_DONE);
    expect(obsAfter.enabledMasters[CLUBMAN]?.enabled).toBe(true);
    expect(obsAfter.enabledMasters[CLUBMAN]?.hitPoints).toBe(50);
    expect(obsAfter.enabledMasters[AXEMAN_SRC]?.enabled).toBe(false);

    const intentsAfter = planner.propose(makeInput(obsAfter, 'easy'));
    const trainCmd = intentsAfter.find((i) => i.command.type === 'queue');
    expect(trainCmd).toBeDefined();
    if (trainCmd?.command.type === 'queue') {
      expect(trainCmd.command.unit).toBe(CLUBMAN);
      expect(trainCmd.command.unit).not.toBe(AXEMAN_SRC);
    }
  });

  test('Short Sword -> Broad Sword -> Long Sword -> Legion: researches chain in order, trains ID 75 (not 76/77/282 or weak 73)', () => {
    const world = new World({
      players: 3,
      civs: [0, CIV_GREEK, CIV_PERSIAN], // Persian has full Swordsman -> Legion tree
      map: new TileMap(40, 40),
      units: [
        { owner: 2, type: TOWN_CENTER, x: 10.5, y: 10.5 },
        { owner: 2, type: HOUSE, x: 6.5, y: 10.5 },
        { owner: 2, type: HOUSE, x: 6.5, y: 13.5 },
        { owner: 2, type: BARRACKS, x: 14.5, y: 10.5 },
        { owner: 2, type: TEMPLE, x: 14.5, y: 15.5 }, // Needed for Legion (tech 20 Fanaticism prereq)
        { owner: 2, type: VILLAGER, x: 8.5, y: 10.5 },
      ],
      victory: { type: VICTORY_SPECIAL },
    });
    doTech(world.gameContext(), 2, 62); // Barracks built
    doTech(world.gameContext(), 2, TOOL_AGE);
    doTech(world.gameContext(), 2, TECH_AXEMAN);
    doTech(world.gameContext(), 2, 26); // Market built
    doTech(world.gameContext(), 2, 55); // Range built
    doTech(world.gameContext(), 2, BRONZE_AGE);
    doTech(world.gameContext(), 2, 17); // Temple built
    doTech(world.gameContext(), 2, 33); // Gov center built
    doTech(world.gameContext(), 2, IRON_AGE);
    doTech(world.gameContext(), 2, 20); // Fanaticism (prereq for Legion 77)

    world.attributes[2]![ATTR_FOOD] = 4000;
    world.attributes[2]![ATTR_GOLD] = 2000;
    world.attributes[2]![ATTR_WOOD] = 500;

    const planner = createResearchPlanner();
    const chain = [TECH_SHORT_SWORD, TECH_BROAD_SWORD, TECH_LONG_SWORD, TECH_LEGION];
    const expectedHp = [60, 70, 80, 160];

    for (let step = 0; step < chain.length; step++) {
      const { observation: obs } = createBotObservation(world, 2);
      const intents = planner.propose(makeInput(obs, 'hard'));
      const res = intents.find((i) => i.command.type === 'research');
      expect(res?.command).toEqual({ type: 'research', building: expect.any(Number), tech: chain[step] });
      expect(doTech(world.gameContext(), 2, chain[step]!)).toBe(true);

      const { observation: obsUpdated } = createBotObservation(world, 2);
      expect(obsUpdated.enabledMasters[SHORT_SWORDSMAN]?.enabled).toBe(true);
      expect(obsUpdated.enabledMasters[SHORT_SWORDSMAN]?.hitPoints).toBe(expectedHp[step]);
      expect(obsUpdated.enabledMasters[BROAD_SWORDSMAN_SRC]?.enabled).toBe(false);
      expect(obsUpdated.enabledMasters[LONG_SWORDSMAN_SRC]?.enabled).toBe(false);
      expect(obsUpdated.enabledMasters[LEGION_SRC]?.enabled).toBe(false);
    }

    // After Legion completes, Barracks trains ID 75 (NOT 282, NOT obsolete 73)
    const { observation: obsFinal } = createBotObservation(world, 2);
    const finalIntents = planner.propose(makeInput(obsFinal, 'hard'));
    const train = finalIntents.find((i) => i.command.type === 'queue');
    expect(train).toBeDefined();
    if (train?.command.type === 'queue') {
      expect(train.command.unit).toBe(SHORT_SWORDSMAN);
    }
  });

  test('Bowman -> Improved Bowman -> Composite Bowman: trains ID 5 after upgrade, never obsolete Bowman (4) or source ID 6', () => {
    const world = new World({
      players: 3,
      civs: [0, CIV_GREEK, CIV_EGYPTIAN], // Egyptian has Improved + Composite Bowman
      map: new TileMap(40, 40),
      units: [
        { owner: 2, type: TOWN_CENTER, x: 10.5, y: 10.5 },
        { owner: 2, type: HOUSE, x: 6.5, y: 10.5 },
        { owner: 2, type: ARCHERY_RANGE, x: 14.5, y: 10.5 },
      ],
      victory: { type: VICTORY_SPECIAL },
    });
    doTech(world.gameContext(), 2, 10);
    doTech(world.gameContext(), 2, 62);
    doTech(world.gameContext(), 2, TOOL_AGE);
    doTech(world.gameContext(), 2, 55); // Archery Range built -> enables Bowman (4)
    doTech(world.gameContext(), 2, 26);
    doTech(world.gameContext(), 2, 67);
    doTech(world.gameContext(), 2, BRONZE_AGE);

    world.attributes[2]![ATTR_FOOD] = 1500;
    world.attributes[2]![ATTR_WOOD] = 1500;
    world.attributes[2]![ATTR_GOLD] = 1500;

    const planner = createResearchPlanner();

    // Before Improved Bowman (56): trains Bowman (4) when Range is busy or researches 56 when idle
    const { observation: obs0 } = createBotObservation(world, 2);
    expect(obs0.enabledMasters[BOWMAN]?.enabled).toBe(true);
    expect(obs0.enabledMasters[IMPROVED_BOWMAN]?.enabled).toBe(false);
    const intents0 = planner.propose(makeInput(obs0, 'hard'));
    expect(intents0.some((i) => i.command.type === 'research' && i.command.tech === TECH_IMPROVED_BOW)).toBe(true);

    // Complete Improved Bowman (56): enables ID 5 while ID 4 ALSO remains enabled!
    doTech(world.gameContext(), 2, TECH_IMPROVED_BOW);
    const { observation: obs1 } = createBotObservation(world, 2);
    expect(obs1.enabledMasters[BOWMAN]?.enabled).toBe(true);
    expect(obs1.enabledMasters[IMPROVED_BOWMAN]?.enabled).toBe(true);
    expect(obs1.enabledMasters[IMPROVED_BOWMAN]?.hitPoints).toBe(40);
    const intents1 = planner.propose(makeInput(obs1, 'hard'));
    expect(intents1.some((i) => i.command.type === 'research' && i.command.tech === TECH_COMPOSITE_BOW)).toBe(true);

    // Complete Composite Bowman (57): copyObj(5 <- 6), so ID 5 has 45 HP, ID 6 remains disabled, ID 4 remains enabled
    doTech(world.gameContext(), 2, TECH_COMPOSITE_BOW);
    const { observation: obs2 } = createBotObservation(world, 2);
    expect(obs2.enabledMasters[IMPROVED_BOWMAN]?.enabled).toBe(true);
    expect(obs2.enabledMasters[IMPROVED_BOWMAN]?.hitPoints).toBe(45);
    expect(obs2.enabledMasters[COMPOSITE_BOWMAN_SRC]?.enabled).toBe(false);

    const intents2 = planner.propose(makeInput(obs2, 'hard'));
    const rangeQueue = intents2.find((i) => i.command.type === 'queue');
    expect(rangeQueue).toBeDefined();
    if (rangeQueue?.command.type === 'queue') {
      expect(rangeQueue.command.unit).toBe(IMPROVED_BOWMAN); // ID 5 (Composite Bowman), NEVER 4 or 6!
    }
  });

  test('Greek lacks Improved/Composite Bowman (56 disabled) so trains Bowman (4); Persian trains Heavy Horse Archer (39), Cavalry/Cataphract (37), Armored Elephant (46); Greek trains Centurion (93) & Heavy Catapult (35) & Trireme (19)', () => {
    const planner = createResearchPlanner();

    // 1. Greek Archery Range: 56/57/59/60/61 are TECH_DISABLED -> never researches them, trains Bowman (4)
    const greekWorld = new World({
      players: 3,
      civs: [0, CIV_EGYPTIAN, CIV_GREEK],
      map: new TileMap(40, 40),
      units: [
        { owner: 2, type: TOWN_CENTER, x: 10.5, y: 10.5 },
        { owner: 2, type: HOUSE, x: 6.5, y: 10.5 },
        { owner: 2, type: ARCHERY_RANGE, x: 14.5, y: 10.5 },
        { owner: 2, type: ACADEMY, x: 14.5, y: 15.5 },
        { owner: 2, type: SIEGE_WORKSHOP, x: 18.5, y: 10.5 },
        { owner: 2, type: DOCK, x: 22.5, y: 10.5 },
      ],
      victory: { type: VICTORY_SPECIAL },
    });
    doTech(greekWorld.gameContext(), 2, 10);
    doTech(greekWorld.gameContext(), 2, 62);
    doTech(greekWorld.gameContext(), 2, TOOL_AGE);
    doTech(greekWorld.gameContext(), 2, 55);
    doTech(greekWorld.gameContext(), 2, 26);
    doTech(greekWorld.gameContext(), 2, 67);
    doTech(greekWorld.gameContext(), 2, BRONZE_AGE);
    doTech(greekWorld.gameContext(), 2, 72); // Academy built
    doTech(greekWorld.gameContext(), 2, 53); // Siege Workshop built
    doTech(greekWorld.gameContext(), 2, 0); // Dock built
    doTech(greekWorld.gameContext(), 2, 17);
    doTech(greekWorld.gameContext(), 2, 33);
    doTech(greekWorld.gameContext(), 2, IRON_AGE);
    doTech(greekWorld.gameContext(), 2, TECH_PHALANX);
    doTech(greekWorld.gameContext(), 2, TECH_CENTURION);
    doTech(greekWorld.gameContext(), 2, TECH_CATAPULT);
    doTech(greekWorld.gameContext(), 2, TECH_HEAVY_CATAPULT);
    doTech(greekWorld.gameContext(), 2, TECH_WAR_GALLEY);
    doTech(greekWorld.gameContext(), 2, TECH_TRIREME);

    greekWorld.attributes[2]![ATTR_FOOD] = 2000;
    greekWorld.attributes[2]![ATTR_WOOD] = 2000;
    greekWorld.attributes[2]![ATTR_GOLD] = 2000;

    const { observation: gObs } = createBotObservation(greekWorld, 2);
    expect(gObs.techStates[TECH_IMPROVED_BOW]).toBe(TECH_DISABLED);
    expect(gObs.enabledMasters[HOPLITE]?.hitPoints).toBe(160);
    expect(gObs.enabledMasters[PHALANX_SRC]?.enabled).toBe(false);
    expect(gObs.enabledMasters[CENTURION_SRC]?.enabled).toBe(false);
    expect(gObs.enabledMasters[STONE_THROWER]?.hitPoints).toBe(150);
    expect(gObs.enabledMasters[CATAPULT_SRC]?.enabled).toBe(false);
    expect(gObs.enabledMasters[HEAVY_CATAPULT_SRC]?.enabled).toBe(false);
    expect(gObs.enabledMasters[SCOUT_SHIP]?.hitPoints).toBe(200);
    expect(gObs.enabledMasters[WAR_GALLEY_SRC]?.enabled).toBe(false);
    expect(gObs.enabledMasters[TRIREME_SRC]?.enabled).toBe(false);

    const gIntents = planner.propose(makeInput(gObs, 'hard'));
    const gResTechs = gIntents.filter((i) => i.command.type === 'research').map((i) => (i.command.type === 'research' ? i.command.tech : -1));
    expect(gResTechs).not.toContain(TECH_IMPROVED_BOW);
    expect(gResTechs).not.toContain(TECH_COMPOSITE_BOW);

    const gQueues = gIntents.filter((i) => i.command.type === 'queue').map((i) => (i.command.type === 'queue' ? i.command.unit : -1));
    expect(gQueues).toContain(BOWMAN);
    expect(gQueues).toContain(HOPLITE); // Centurion via ID 93
    expect(gQueues.some((u) => u === STONE_THROWER || u === BALLISTA)).toBe(true);
    expect(gQueues).not.toContain(CENTURION_SRC);
    expect(gQueues).not.toContain(HEAVY_CATAPULT_SRC);
    expect(gQueues).not.toContain(TRIREME_SRC);

    // 2. Persian Stable & Range: Cavalry -> Heavy Cav -> Cataphract (ID 37), Horse Archer -> Heavy Horse Archer (ID 39)
    const persianWorld = new World({
      players: 3,
      civs: [0, CIV_EGYPTIAN, CIV_PERSIAN],
      map: new TileMap(40, 40),
      units: [
        { owner: 2, type: TOWN_CENTER, x: 10.5, y: 10.5 },
        { owner: 2, type: HOUSE, x: 6.5, y: 10.5 },
        { owner: 2, type: STABLE, x: 14.5, y: 10.5 },
        { owner: 2, type: ARCHERY_RANGE, x: 14.5, y: 15.5 },
      ],
      victory: { type: VICTORY_SPECIAL },
    });
    doTech(persianWorld.gameContext(), 2, 10);
    doTech(persianWorld.gameContext(), 2, 62);
    doTech(persianWorld.gameContext(), 2, TOOL_AGE);
    doTech(persianWorld.gameContext(), 2, 55);
    doTech(persianWorld.gameContext(), 2, 67);
    doTech(persianWorld.gameContext(), 2, 26);
    doTech(persianWorld.gameContext(), 2, BRONZE_AGE);
    doTech(persianWorld.gameContext(), 2, 17);
    doTech(persianWorld.gameContext(), 2, 33);
    doTech(persianWorld.gameContext(), 2, 53);
    doTech(persianWorld.gameContext(), 2, 72);
    doTech(persianWorld.gameContext(), 2, IRON_AGE);
    doTech(persianWorld.gameContext(), 2, TECH_CAVALRY);
    doTech(persianWorld.gameContext(), 2, TECH_HEAVY_CAVALRY);
    doTech(persianWorld.gameContext(), 2, 52);
    doTech(persianWorld.gameContext(), 2, TECH_CATAPHRACT);
    doTech(persianWorld.gameContext(), 2, TECH_HORSE_ARCHER);
    doTech(persianWorld.gameContext(), 2, 49);
    doTech(persianWorld.gameContext(), 2, TECH_HEAVY_HORSE_ARCHER);
    doTech(persianWorld.gameContext(), 2, TECH_IMPROVED_BOW);
    doTech(persianWorld.gameContext(), 2, TECH_COMPOSITE_BOW);

    persianWorld.attributes[2]![ATTR_FOOD] = 2000;
    persianWorld.attributes[2]![ATTR_WOOD] = 2000;
    persianWorld.attributes[2]![ATTR_GOLD] = 2000;

    const { observation: pObs } = createBotObservation(persianWorld, 2);
    expect(pObs.enabledMasters[CAVALRY]?.hitPoints).toBe(180); // Cataphract copied into ID 37
    expect(pObs.enabledMasters[CATAPHRACT_SRC]?.enabled).toBe(false);
    expect(pObs.enabledMasters[HORSE_ARCHER]?.hitPoints).toBe(90); // Heavy Horse Archer copied into ID 39
    expect(pObs.enabledMasters[HEAVY_HORSE_ARCHER_SRC]?.enabled).toBe(false);

    const pIntents = planner.propose(makeInput(pObs, 'hard'));
    const pQueues = pIntents.filter((i) => i.command.type === 'queue').map((i) => (i.command.type === 'queue' ? i.command.unit : -1));
    expect(pQueues).toContain(CAVALRY);
    expect(pQueues).toContain(HORSE_ARCHER);
    expect(pQueues).not.toContain(SCOUT);
    expect(pQueues).not.toContain(CATAPHRACT_SRC);
    expect(pQueues).not.toContain(HEAVY_HORSE_ARCHER_SRC);
  });

  test('Egyptian Chariot/Scythe Chariot (ID 40) & War/Armored Elephant (ID 46) stay on destination IDs without cross-linking', () => {
    const planner = createResearchPlanner();
    const techStates = new Array<number>(TECHS.length).fill(TECH_LOCKED);
    techStates[TECH_SCYTHE_CHARIOT] = TECH_DONE;
    techStates[TECH_ARMORED_ELEPHANT] = TECH_DONE;

    const obs = makeObservation({
      age: 4,
      civ: CIV_EGYPTIAN,
      techStates,
      ownBuildings: [makeBuilding({ id: 30, type: STABLE })],
      enabledMasters: {
        [SCOUT]: makeMaster(SCOUT, { enabled: true, hitPoints: 60, trainLocationId: STABLE, costs: [{ type: ATTR_FOOD, amount: 100, flag: 1 }, { type: 4, amount: 1, flag: 0 }] }),
        [CHARIOT]: makeMaster(CHARIOT, {
          enabled: true,
          hitPoints: 120,
          trainLocationId: STABLE,
          costs: [{ type: ATTR_FOOD, amount: 40, flag: 1 }, { type: ATTR_WOOD, amount: 60, flag: 1 }, { type: 4, amount: 1, flag: 0 }],
          combat: { range: 0, minRange: 0, baseArmour: 0, attacks: [{ group: 4, amount: 9 }] },
        }),
        [SCYTHE_CHARIOT_SRC]: makeMaster(SCYTHE_CHARIOT_SRC, { enabled: false, hitPoints: 120, trainLocationId: STABLE }),
        [WAR_ELEPHANT]: makeMaster(WAR_ELEPHANT, {
          enabled: true,
          hitPoints: 600,
          trainLocationId: STABLE,
          costs: [{ type: ATTR_FOOD, amount: 170, flag: 1 }, { type: ATTR_GOLD, amount: 40, flag: 1 }, { type: 4, amount: 1, flag: 0 }],
          combat: { range: 0, minRange: 0, baseArmour: 0, attacks: [{ group: 4, amount: 18 }] },
        }),
        [ARMORED_ELEPHANT_SRC]: makeMaster(ARMORED_ELEPHANT_SRC, { enabled: false, hitPoints: 600, trainLocationId: STABLE }),
      },
    });

    const intents = planner.propose(makeInput(obs, 'hard'));
    const q = intents.find((i) => i.command.type === 'queue');
    expect(q).toBeDefined();
    if (q?.command.type === 'queue') {
      expect([CHARIOT, WAR_ELEPHANT]).toContain(q.command.unit);
      expect(q.command.unit).not.toBe(SCOUT);
      expect(q.command.unit).not.toBe(SCYTHE_CHARIOT_SRC);
      expect(q.command.unit).not.toBe(ARMORED_ELEPHANT_SRC);
    }
  });

  test('respects difficulty profile maxResearchDepth (easy=1, medium=2, hard=4) and maxMilitaryTrainPerTick (1/2/4)', () => {
    const planner = createResearchPlanner();
    const techStates = new Array<number>(TECHS.length).fill(TECH_LOCKED);
    techStates[TECH_LONG_SWORD] = TECH_AVAILABLE; // Depth 3 Barracks upgrade
    techStates[TECH_LEGION] = TECH_AVAILABLE; // Depth 4 Barracks upgrade
    techStates[TECH_AXEMAN] = TECH_AVAILABLE; // Depth 1 Barracks upgrade

    const obs = makeObservation({
      age: 4,
      techStates,
      resources: { food: 4000, wood: 2000, stone: 500, gold: 2000 },
      ownBuildings: [
        makeBuilding({ id: 20, type: BARRACKS }),
        makeBuilding({ id: 21, type: BARRACKS }),
        makeBuilding({ id: 22, type: BARRACKS }),
        makeBuilding({ id: 23, type: BARRACKS }),
        makeBuilding({ id: 24, type: BARRACKS }),
      ],
      enabledMasters: {
        [CLUBMAN]: makeMaster(CLUBMAN, { enabled: true, hitPoints: 40, trainLocationId: BARRACKS }),
        [SHORT_SWORDSMAN]: makeMaster(SHORT_SWORDSMAN, {
          enabled: true,
          hitPoints: 70,
          trainLocationId: BARRACKS,
          costs: [
            { type: ATTR_FOOD, amount: 35, flag: 1 },
            { type: ATTR_GOLD, amount: 15, flag: 1 },
            { type: 4, amount: 1, flag: 0 },
          ],
        }),
      },
    });

    // Easy (depth 1): cannot research Long Sword / Legion, can research Axeman (1) and queues max 1 military
    const easyIntents = planner.propose(makeInput(obs, 'easy'));
    const easyTechs = easyIntents.filter((i) => i.command.type === 'research').map((i) => (i.command.type === 'research' ? i.command.tech : -1));
    expect(easyTechs).toContain(TECH_AXEMAN);
    expect(easyTechs).not.toContain(TECH_LONG_SWORD);
    expect(easyTechs).not.toContain(TECH_LEGION);
    expect(easyIntents.filter((i) => i.command.type === 'queue').length).toBeLessThanOrEqual(1);

    // Medium (depth 2): max 2 military trains
    const medIntents = planner.propose(makeInput(obs, 'medium'));
    expect(medIntents.filter((i) => i.command.type === 'queue').length).toBeLessThanOrEqual(2);

    // Hard (depth 4): CAN research Long Sword / Legion and train up to 4 military
    const hardIntents = planner.propose(makeInput(obs, 'hard'));
    const hardTechs = hardIntents.filter((i) => i.command.type === 'research').map((i) => (i.command.type === 'research' ? i.command.tech : -1));
    expect(hardTechs.some((t) => t === TECH_LONG_SWORD || t === TECH_LEGION)).toBe(true);
    expect(hardIntents.filter((i) => i.command.type === 'queue').length).toBeLessThanOrEqual(4);

    // Artisanship (32, Bronze prereq) is depth 2 and ahead of Craftsmanship (110, Iron prereq, depth 3)
    const marketList = RESEARCH_PRIORITY_TECHS[MARKET]!;
    expect(marketList.indexOf(32)).toBeGreaterThanOrEqual(0);
    expect(marketList.indexOf(32)).toBeLessThan(marketList.indexOf(110));

    const marketTechs = new Array<number>(TECHS.length).fill(TECH_LOCKED);
    marketTechs[32] = TECH_AVAILABLE;
    marketTechs[110] = TECH_AVAILABLE;
    const marketObs = makeObservation({
      age: 4,
      techStates: marketTechs,
      resources: { food: 2000, wood: 2000, stone: 500, gold: 500 },
      ownBuildings: [makeBuilding({ id: 30, type: MARKET })],
    });
    const medMarketTechs = planner
      .propose(makeInput(marketObs, 'medium'))
      .filter((i) => i.command.type === 'research')
      .map((i) => (i.command.type === 'research' ? i.command.tech : -1));
    expect(medMarketTechs).toEqual([32]);
    const hardMarketTechs = planner
      .propose(makeInput(marketObs, 'hard'))
      .filter((i) => i.command.type === 'research')
      .map((i) => (i.command.type === 'research' ? i.command.tech : -1));
    expect(hardMarketTechs).toEqual([32]);
  });
});

describe('T05 R03 — Multi-building tech deduplication, Age-Up/Economy budget priority & Propose/Commit purity', () => {
  test('never issues duplicate research for the same tech across two buildings or during COMMAND_DELAY_TURNS pending', () => {
    const planner = createResearchPlanner();
    const techStates = new Array<number>(TECHS.length).fill(TECH_LOCKED);
    techStates[TECH_AXEMAN] = TECH_AVAILABLE; // Only 1 available Barracks tech!

    const obs = makeObservation({
      techStates,
      resources: { food: 500, wood: 100, stone: 0, gold: 0 },
      ownBuildings: [
        makeBuilding({ id: 20, type: BARRACKS }),
        makeBuilding({ id: 21, type: BARRACKS }),
      ],
    });

    const intents = planner.propose(makeInput(obs, 'medium'));
    const axemanResearch = intents.filter((i) => i.command.type === 'research' && i.command.tech === TECH_AXEMAN);
    expect(axemanResearch).toHaveLength(1);

    // During CTI=2 pending transit, neither Barracks may propose TECH_AXEMAN again
    const chosenBldg = axemanResearch[0]!.command.type === 'research' ? axemanResearch[0]!.command.building : 20;
    const pending: PendingAction[] = [
      {
        key: `research:${TECH_AXEMAN}:${chosenBldg}`,
        commandType: 'research',
        issuedTurn: 10,
        expectedApplyTurn: 12,
        expiresTurn: 16,
        cost: { food: 100 },
        unitIds: [],
        buildingId: chosenBldg,
        techId: TECH_AXEMAN,
        status: 'issued',
      },
    ];
    const obsNext = makeObservation({ ...obs, turn: 11 });
    const intentsNext = planner.propose(makeInput(obsNext, 'medium', makePlannerState(), pending));
    expect(intentsNext.filter((i) => i.command.type === 'research' && i.command.tech === TECH_AXEMAN)).toHaveLength(0);
    // And the pending building must not receive a queue command while research is pending!
    expect(intentsNext.filter((i) => i.command.type === 'queue' && i.command.building === chosenBldg)).toHaveLength(0);

    // When two Markets are idle and two distinct techs (107 Woodworking, 81 Domestication) are available,
    // each Market gets a distinct tech with zero duplicate techId
    const marketTechs = new Array<number>(TECHS.length).fill(TECH_LOCKED);
    marketTechs[TECH_WOODWORKING] = TECH_AVAILABLE;
    marketTechs[TECH_DOMESTICATION] = TECH_AVAILABLE;
    const obsMarkets = makeObservation({
      techStates: marketTechs,
      resources: { food: 1000, wood: 1000, stone: 0, gold: 0 },
      ownBuildings: [
        makeBuilding({ id: 30, type: MARKET }),
        makeBuilding({ id: 31, type: MARKET }),
      ],
    });
    const marketIntents = planner.propose(makeInput(obsMarkets, 'medium'));
    const marketTechIds = marketIntents
      .filter((i) => i.command.type === 'research')
      .map((i) => (i.command.type === 'research' ? i.command.tech : -1));
    expect(new Set(marketTechIds)).toEqual(new Set([TECH_WOODWORKING, TECH_DOMESTICATION]));
    expect(marketTechIds).toHaveLength(2);
  });

  test('respects Age-Up and Economy budget priority deterministically without starving surplus spending', () => {
    const planner = createResearchPlanner();
    const techStates = new Array<number>(TECHS.length).fill(TECH_LOCKED);
    techStates[TOOL_AGE] = TECH_AVAILABLE; // 500F at TC
    techStates[TECH_AXEMAN] = TECH_AVAILABLE; // 100F at Barracks

    // 1. With 500F and TOOL_AGE available at TC: must hold 500F for Tool Age!
    const obsHold = makeObservation({
      age: 1,
      techStates,
      resources: { food: 500, wood: 100, stone: 0, gold: 0 },
      ownUnits: Array.from({ length: 6 }, (_, i) => ({
        id: i + 1,
        type: VILLAGER,
        x: 10,
        y: 10,
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
      })),
      ownBuildings: [
        makeBuilding({ id: 10, type: TOWN_CENTER }),
        makeBuilding({ id: 20, type: BARRACKS }),
      ],
    });
    const holdIntents = planner.propose(makeInput(obsHold, 'medium'));
    expect(holdIntents.filter((i) => i.cost?.food && i.cost.food > 0)).toHaveLength(0);

    // 2. With 650F (150F surplus over 500F Tool Age + 50F villager reserve): Axeman (100F) CAN run!
    const obsSurplus = makeObservation({
      ...obsHold,
      resources: { food: 650, wood: 100, stone: 0, gold: 0 },
    });
    const surplusIntents = planner.propose(makeInput(obsSurplus, 'medium'));
    expect(surplusIntents.some((i) => i.command.type === 'research' && i.command.tech === TECH_AXEMAN)).toBe(true);

    // 3. With 3 villagers, 50F, TC idle, and TOOL_AGE locked: must reserve 50F for Villager rather than spending last 50F on Clubman
    const lockedTechs = new Array<number>(TECHS.length).fill(TECH_LOCKED);
    const obsEco = makeObservation({
      age: 1,
      techStates: lockedTechs,
      resources: { food: 50, wood: 0, stone: 0, gold: 0 },
      ownUnits: obsHold.ownUnits.slice(0, 3),
      ownBuildings: [
        makeBuilding({ id: 10, type: TOWN_CENTER }),
        makeBuilding({ id: 20, type: BARRACKS }),
      ],
    });
    const ecoIntents = planner.propose(makeInput(obsEco, 'medium'));
    expect(ecoIntents.filter((i) => i.command.type === 'queue')).toHaveLength(0);

    // 4. Iron Age reservation (1000F + 800G) holds when IRON_AGE is available, and releases once IRON_AGE is researching
    const ironTechs = new Array<number>(TECHS.length).fill(TECH_LOCKED);
    ironTechs[IRON_AGE] = TECH_AVAILABLE;
    ironTechs[73] = TECH_AVAILABLE; // Phalanx: 300F, 100G at Academy
    const obsIronHold = makeObservation({
      age: 3,
      techStates: ironTechs,
      resources: { food: 1000, wood: 200, stone: 0, gold: 800 },
      ownUnits: Array.from({ length: 8 }, (_, i) => ({
        ...obsHold.ownUnits[0]!,
        id: i + 1,
      })),
      ownBuildings: [
        makeBuilding({ id: 10, type: TOWN_CENTER }),
        makeBuilding({ id: 40, type: ACADEMY }),
      ],
    });
    const ironHoldIntents = planner.propose(makeInput(obsIronHold, 'hard'));
    expect(ironHoldIntents.filter((i) => i.command.type === 'research')).toHaveLength(0);

    const ironResearchingTechs = [...ironTechs];
    ironResearchingTechs[IRON_AGE] = TECH_RESEARCHING;
    const obsIronStarted = makeObservation({
      ...obsIronHold,
      resources: { food: 400, wood: 200, stone: 0, gold: 200 },
      techStates: ironResearchingTechs,
      ownBuildings: [
        makeBuilding({ id: 10, type: TOWN_CENTER, researchingTech: IRON_AGE, isBusy: true }),
        makeBuilding({ id: 40, type: ACADEMY }),
      ],
    });
    const ironAfterIntents = planner.propose(makeInput(obsIronStarted, 'hard'));
    expect(ironAfterIntents.some((i) => i.command.type === 'research' && i.command.tech === 73)).toBe(true);

    // 5. Arbiter priority contention: higher-priority Age-Up/Economy intent wins shared food,
    // rejected Research intent does not commit cooldown, and retries cleanly on next tick
    const arbiterState = createArbiterState();
    const pState = makePlannerState();
    const contendTechs = new Array<number>(TECHS.length).fill(TECH_LOCKED);
    contendTechs[TECH_AXEMAN] = TECH_AVAILABLE; // 100F
    const obsContend = makeObservation({
      age: 1,
      techStates: contendTechs,
      resources: { food: 150, wood: 100, stone: 0, gold: 0 },
      ownBuildings: [
        makeBuilding({ id: 10, type: TOWN_CENTER }),
        makeBuilding({ id: 20, type: BARRACKS }),
      ],
    });
    const ecoVillagerPlanner = {
      name: 'mock-eco',
      propose: () => [
        {
          key: 'queue:eco:10:83',
          priority: 90,
          reason: 'Train villager first',
          cost: { food: 100, headroom: 1 },
          buildingId: 10,
          command: { type: 'queue' as const, building: 10, unit: VILLAGER, count: 1 },
        },
      ],
      commit: () => {},
    };
    const resContend = runProposeCommitCycle([ecoVillagerPlanner, planner], obsContend, getBotProfile('medium'), arbiterState, pState, 1);
    expect(resContend.accepted.map((i) => i.key)).toEqual(['queue:eco:10:83']);
    expect(resContend.outcomesByKey[`research:${TECH_AXEMAN}:20`]?.accepted).toBe(false);
    expect(resContend.outcomesByKey[`research:${TECH_AXEMAN}:20`]?.reason).toBe('insufficient-budget');
    expect(pState.buildingCooldownUntil[20]).toBeUndefined();
  });

  test('propose is pure (no Date.now/Math.random, no state mutation) and commit only sets cooldowns for accepted outcomes', () => {
    const dateSpy = vi.spyOn(Date, 'now').mockImplementation(() => {
      throw new Error('Date.now forbidden');
    });
    const randSpy = vi.spyOn(Math, 'random').mockImplementation(() => {
      throw new Error('Math.random forbidden');
    });

    try {
      const planner = createResearchPlanner();
      const techStates = new Array<number>(TECHS.length).fill(TECH_LOCKED);
      techStates[TECH_AXEMAN] = TECH_AVAILABLE;
      const obs = makeObservation({
        techStates,
        ownBuildings: [
          makeBuilding({ id: 20, type: BARRACKS }),
          makeBuilding({ id: 21, type: BARRACKS }),
        ],
      });

      const state = makePlannerState();
      const stateSnapshot = structuredClone(state);
      const input = makeInput(obs, 'medium', state);

      const intentsA = planner.propose(input);
      const intentsB = planner.propose(input);
      expect(intentsA).toEqual(intentsB);
      expect(state).toEqual(stateSnapshot); // propose MUST NOT mutate planner state!

      const resIntent = intentsA.find((i) => i.command.type === 'research')!;
      expect(resIntent).toBeDefined();

      // Rejected outcome must NOT commit cooldown
      planner.commit(
        {
          [resIntent.key]: { key: resIntent.key, accepted: false, reason: 'insufficient-budget' },
        },
        input,
      );
      expect(state.buildingCooldownUntil).toEqual({});

      // Accepted outcome commits cooldown on that building only
      planner.commit(
        {
          [resIntent.key]: { key: resIntent.key, accepted: true, command: resIntent.command },
        },
        input,
      );
      const bId = resIntent.command.type === 'research' ? resIntent.command.building : -1;
      expect(state.buildingCooldownUntil[bId]).toBeGreaterThan(obs.turn);
    } finally {
      dateSpy.mockRestore();
      randSpy.mockRestore();
    }
  });
});

describe('T05 Integration — Multi-tick @aoe/sim World + CTI=2 + Arbiter + Post-Upgrade Training', () => {
  test('researches Improved Bowman -> Composite Bowman via World.addBatch and trains upgraded ID 5 unit on map', () => {
    const map = new TileMap(40, 40);
    const units: StartUnit[] = [
      { owner: 2, type: TOWN_CENTER, x: 10.5, y: 10.5 },
      { owner: 2, type: HOUSE, x: 6.5, y: 10.5 },
      { owner: 2, type: HOUSE, x: 6.5, y: 13.5 },
      { owner: 2, type: ARCHERY_RANGE, x: 14.5, y: 10.5 },
      { owner: 1, type: TOWN_CENTER, x: 30.5, y: 30.5 },
    ];
    const world = new World({
      players: 3,
      civs: [0, CIV_GREEK, CIV_EGYPTIAN],
      map,
      units,
      victory: { type: VICTORY_SPECIAL },
    });
    doTech(world.gameContext(), 2, 10);
    doTech(world.gameContext(), 2, 62);
    doTech(world.gameContext(), 2, TOOL_AGE);
    doTech(world.gameContext(), 2, 55);
    doTech(world.gameContext(), 2, 26);
    doTech(world.gameContext(), 2, 67);
    doTech(world.gameContext(), 2, BRONZE_AGE);

    world.attributes[2]![ATTR_FOOD] = 2000;
    world.attributes[2]![ATTR_WOOD] = 2000;
    world.attributes[2]![ATTR_GOLD] = 2000;
    world.cheats.quickBuild = true;

    const planner = createResearchPlanner();
    const arbiterState = createArbiterState();
    const plannerState = makePlannerState();
    const profile = getBotProfile('hard');
    let memory = createEmptyBotMemory();

    const issuedCommands = [];
    for (let turn = 0; turn < 80; turn++) {
      const obsResult = createBotObservation(world, 2, memory);
      memory = obsResult.memory;

      if (turn % 2 === 0) {
        const res = runProposeCommitCycle([planner], obsResult.observation, profile, arbiterState, plannerState, 777);
        if (turn === 0) {
          expect(arbiterState.pending[0]?.expectedApplyTurn).toBe(COMMAND_DELAY_TURNS);
        }
        if (res.commands.length > 0) {
          issuedCommands.push(...res.commands);
          world.addBatch(world.turn, 2, res.commands);
        }
      }
      world.runTurn();
    }

    // Both Improved Bowman (56) and Composite Bowman (57) completed
    expect(world.techs[2]![TECH_IMPROVED_BOW]).toBe(TECH_DONE);
    expect(world.techs[2]![TECH_COMPOSITE_BOW]).toBe(TECH_DONE);

    // Master 5 now has Composite Bowman stats (45 HP), while source 6 remains disabled
    expect(master(world, 2, IMPROVED_BOWMAN).hitPoints).toBe(45);
    expect(master(world, 2, COMPOSITE_BOWMAN_SRC).enabled).toBe(false);

    // Real Composite Bowman units (type 5, hp 45) were trained and spawned on the map after upgrade
    const upgradedArchers = [...world.entities.ofPlayer(2)].filter(
      (e) => e.type === IMPROVED_BOWMAN && e.state === ObjectState.Active && e.hp === 45,
    );
    expect(upgradedArchers.length).toBeGreaterThanOrEqual(1);

    // Never issued invalid/duplicate research for the same tech
    const res56Count = issuedCommands.filter((c) => c.type === 'research' && c.tech === TECH_IMPROVED_BOW).length;
    const res57Count = issuedCommands.filter((c) => c.type === 'research' && c.tech === TECH_COMPOSITE_BOW).length;
    expect(res56Count).toBe(1);
    expect(res57Count).toBe(1);
  });
});
