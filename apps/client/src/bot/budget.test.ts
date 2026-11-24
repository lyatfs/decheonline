import { describe, expect, test, vi } from 'vitest';
import {
  AGE_BRONZE,
  BARRACKS,
  CLUBMAN,
  COMMAND_DELAY_TURNS,
  FORAGE,
  GRANARY,
  HOUSE,
  ObjectState,
  SLINGER,
  TECH_AVAILABLE,
  TECH_DISABLED,
  TECH_DONE,
  TECH_LOCKED,
  TECH_RESEARCHING,
  TOOL_AGE,
  TOWN_CENTER,
  VILLAGER,
  World,
  startingObjects,
  type Command,
} from '@aoe/sim';
import { MAX_COMMANDS_PER_BATCH } from '@aoe/protocol';
import { getBotProfile } from './difficulty';
import { createBotObservation } from './observation';
import {
  BOT_CONTRACT_VERSION,
  type BotIntent,
  type BotObservation,
  type BotPlanner,
  type BotPlannerState,
  type IntentOutcome,
  type ObservedMaster,
  type ObservedOwnBuilding,
  type ObservedOwnUnit,
  type PlannerInput,
} from './types';
import {
  arbitrateIntents,
  createArbiterState,
  createPlannerInput,
  getActivePending,
  getAvailableBudget,
  getAvailableResources,
  hasPendingKey,
  isBuildingPending,
  isTechPending,
  isUnitPending,
  reconcilePending,
  resetArbiterState,
  runProposeCommitCycle,
} from './budget';

function makeMaster(id: number, clearanceX = 1, clearanceY = 1): ObservedMaster {
  return {
    id,
    name: `Master-${id}`,
    masterType: 80,
    group: 3,
    hitPoints: 200,
    los: 4,
    fogFlag: 1,
    speed: 0,
    radiusX: clearanceX,
    radiusY: clearanceY,
    clearanceX,
    clearanceY,
    terrainRestriction: 0,
    unitLevel: 0,
    trackAsResource: 0,
    resourceGroup: 0,
    enabled: true,
    costs: [],
    trainTime: 20,
    trainLocationId: 0,
    combat: null,
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

function makeObservation(overrides: Partial<BotObservation> = {}): BotObservation {
  const techStates = new Array<number>(130).fill(TECH_AVAILABLE);
  return {
    contractVersion: BOT_CONTRACT_VERSION,
    player: 2,
    turn: 0,
    worldTime: 0,
    age: 1,
    civ: 1,
    mapWidth: 64,
    mapHeight: 64,
    resources: { food: 200, wood: 200, stone: 150, gold: 0 },
    population: { current: 3, limit: 8, headroom: 5 },
    ownUnits: [makeUnit({ id: 1 }), makeUnit({ id: 2, x: 11.5 }), makeUnit({ id: 3, x: 12.5 })],
    ownBuildings: [makeBuilding({ id: 10 })],
    knownEnemies: [],
    knownResources: [],
    techStates,
    enabledMasters: {
      [HOUSE]: makeMaster(HOUSE, 1, 1),
      [BARRACKS]: makeMaster(BARRACKS, 1.5, 1.5),
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

describe('T02 B01 — Tick budget, priority ordering, deduplication & invalid intent handling', () => {
  test('two planners spending the same remaining 100 wood: highest priority wins, second gets insufficient-budget', () => {
    const obs = makeObservation({
      resources: { food: 200, wood: 100, stone: 0, gold: 0 },
    });
    const state = createArbiterState();

    const ecoIntent: BotIntent = {
      key: 'build:farm:1',
      priority: 70,
      reason: 'Need farm for food',
      cost: { wood: 75 },
      unitIds: [1],
      spot: { x: 15, y: 15, masterId: 50 },
      command: { type: 'build', units: [1], unitType: 50, x: 15, y: 15 },
    };

    const progIntent: BotIntent = {
      key: 'build:barracks:1',
      priority: 90,
      reason: 'Need barracks',
      cost: { wood: 100 },
      unitIds: [2],
      spot: { x: 20, y: 20, masterId: BARRACKS },
      command: { type: 'build', units: [2], unitType: BARRACKS, x: 20, y: 20 },
    };

    const result = arbitrateIntents([ecoIntent, progIntent], obs, state);

    expect(result.accepted).toHaveLength(1);
    expect(result.accepted[0]!.key).toBe('build:barracks:1');
    expect(result.commands).toEqual([progIntent.command]);

    expect(result.rejected).toHaveLength(1);
    expect(result.rejected[0]).toMatchObject({
      key: 'build:farm:1',
      accepted: false,
      reason: 'insufficient-budget',
    });

    expect(result.outcomesByKey['build:barracks:1']?.accepted).toBe(true);
    expect(result.outcomesByKey['build:farm:1']?.accepted).toBe(false);
    expect(result.outcomesByKey['build:farm:1']?.reason).toBe('insufficient-budget');

    // Remaining wood is 0, and unit 1 was NOT claimed by the rejected intent
    expect(getAvailableResources(obs, state)).toEqual({ food: 200, wood: 0, stone: 0, gold: 0 });
    expect(state.pending).toHaveLength(1);
    expect(state.pending[0]!.unitIds).toEqual([2]);
  });

  test('equal priority tie-breaks deterministically by lexicographical key then original order, ignoring wall clock', () => {
    const dateSpy = vi.spyOn(Date, 'now').mockImplementation(() => {
      throw new Error('Date.now forbidden');
    });
    const randSpy = vi.spyOn(Math, 'random').mockImplementation(() => {
      throw new Error('Math.random forbidden');
    });

    try {
      const obs = makeObservation({ resources: { food: 100, wood: 100, stone: 0, gold: 0 } });
      const state = createArbiterState();

      const intentB: BotIntent = {
        key: 'z-intent',
        priority: 50,
        reason: 'b',
        cost: { wood: 80 },
        unitIds: [1],
        command: { type: 'move', units: [1], x: 5, y: 5 },
      };
      const intentA: BotIntent = {
        key: 'a-intent',
        priority: 50,
        reason: 'a',
        cost: { wood: 80 },
        unitIds: [2],
        command: { type: 'move', units: [2], x: 6, y: 6 },
      };

      const res = arbitrateIntents([intentB, intentA], obs, state);
      expect(res.accepted.map((i) => i.key)).toEqual(['a-intent']);
      expect(res.rejected[0]).toMatchObject({ key: 'z-intent', reason: 'insufficient-budget' });
    } finally {
      dateSpy.mockRestore();
      randSpy.mockRestore();
    }
  });

  test('enforces population headroom budget and clamps available resources >= 0', () => {
    const obs = makeObservation({
      resources: { food: 500, wood: 500, stone: 0, gold: 0 },
      population: { current: 7, limit: 8, headroom: 1 },
      ownBuildings: [makeBuilding({ id: 10 }), makeBuilding({ id: 11, type: BARRACKS })],
    });
    const state = createArbiterState();

    const train1: BotIntent = {
      key: 'queue:tc:villager',
      priority: 80,
      reason: 'train villager',
      cost: { food: 50, headroom: 1 },
      buildingId: 10,
      command: { type: 'queue', building: 10, unit: VILLAGER, count: 1 },
    };
    const train2: BotIntent = {
      key: 'queue:barracks:clubman',
      priority: 70,
      reason: 'train clubman',
      cost: { food: 50, headroom: 1 },
      buildingId: 11,
      command: { type: 'queue', building: 11, unit: 73, count: 1 },
    };

    const res = arbitrateIntents([train2, train1], obs, state);
    expect(res.accepted.map((i) => i.key)).toEqual(['queue:tc:villager']);
    expect(res.rejected[0]).toMatchObject({ key: 'queue:barracks:clubman', reason: 'insufficient-budget' });
    expect(getAvailableBudget(obs, state).headroom).toBe(0);

    // If actual resources dropped below active pending claims, available resources clamp >= 0
    const depletedObs = makeObservation({ resources: { food: 10, wood: 0, stone: 0, gold: 0 } });
    expect(getAvailableResources(depletedObs, state)).toEqual({ food: 0, wood: 0, stone: 0, gold: 0 });
  });

  test('rejects invalid intents with invalid-intent and does not reserve anything', () => {
    const obs = makeObservation();
    const state = createArbiterState();

    const invalidCases: BotIntent[] = [
      {
        key: '   ',
        priority: 100,
        reason: 'empty key',
        cost: { wood: 10 },
        unitIds: [1],
        command: { type: 'move', units: [1], x: 5, y: 5 },
      },
      {
        key: 'neg-cost',
        priority: 90,
        reason: 'negative wood',
        cost: { wood: -5 },
        unitIds: [1],
        command: { type: 'move', units: [1], x: 5, y: 5 },
      },
      {
        key: 'nan-cost',
        priority: 80,
        reason: 'NaN food',
        cost: { food: Number.NaN },
        unitIds: [1],
        command: { type: 'move', units: [1], x: 5, y: 5 },
      },
      {
        key: 'nan-priority',
        priority: Number.NaN,
        reason: 'NaN priority',
        command: { type: 'noop' },
      },
    ];

    const res = arbitrateIntents(invalidCases, obs, state);
    expect(res.accepted).toHaveLength(0);
    expect(res.rejected).toHaveLength(4);
    for (const r of res.rejected) {
      expect(r.reason).toBe('invalid-intent');
    }
    expect(state.pending).toHaveLength(0);
  });
});

describe('T02 B02 — Pending across COMMAND_DELAY_TURNS=2, dedup (incl. R03), and no double-reserve on materialization', () => {
  test('prevents double foundations, double unit assignment, and releases once foundation materializes', () => {
    const state = createArbiterState();
    const obs0 = makeObservation({
      turn: 0,
      resources: { food: 200, wood: 200, stone: 0, gold: 0 },
    });

    const buildHouse: BotIntent = {
      key: 'build:house:16,16',
      priority: 85,
      reason: 'house',
      cost: { wood: 30 },
      unitIds: [1],
      spot: { x: 16, y: 16, masterId: HOUSE },
      command: { type: 'build', units: [1], unitType: HOUSE, x: 16, y: 16 },
    };

    const res0 = arbitrateIntents([buildHouse], obs0, state);
    expect(res0.accepted).toHaveLength(1);
    expect(state.pending[0]).toMatchObject({
      issuedTurn: 0,
      expectedApplyTurn: COMMAND_DELAY_TURNS,
      status: 'issued',
    });
    expect(getAvailableResources(obs0, state).wood).toBe(170);

    // Turn 1 (during CTI=2 transit): same key, overlapping spot, and same unit must all be rejected!
    const obs1 = makeObservation({ turn: 1, resources: { food: 200, wood: 200, stone: 0, gold: 0 } });
    reconcilePending(obs1, state);
    expect(state.pending).toHaveLength(1);

    const sameKeyIntent: BotIntent = { ...buildHouse, unitIds: [2], command: { type: 'build', units: [2], unitType: HOUSE, x: 16, y: 16 } };
    const overlappingSpotIntent: BotIntent = {
      key: 'build:house:16.5,16.5',
      priority: 80,
      reason: 'overlap spot',
      cost: { wood: 30 },
      unitIds: [2],
      spot: { x: 16.5, y: 16.5, masterId: HOUSE },
      command: { type: 'build', units: [2], unitType: HOUSE, x: 16.5, y: 16.5 },
    };
    const sameUnitWork: BotIntent = {
      key: 'work:1:forage',
      priority: 75,
      reason: 'gather',
      unitIds: [1],
      command: { type: 'work', units: [1], target: 99, x: 5, y: 5 },
    };

    const res1 = arbitrateIntents([sameKeyIntent, overlappingSpotIntent, sameUnitWork], obs1, state);
    expect(res1.accepted).toHaveLength(0);
    expect(res1.outcomesByKey['build:house:16,16']?.reason).toBe('duplicate-pending');
    expect(res1.outcomesByKey['build:house:16.5,16.5']?.reason).toBe('spot-claimed');
    expect(res1.outcomesByKey['work:1:forage']?.reason).toBe('unit-busy-or-claimed');

    // Turn 3 (after CTI=2 executes): World deducted 30 wood (now 170) and placed foundation at (16,16)
    const obs3 = makeObservation({
      turn: 3,
      resources: { food: 200, wood: 170, stone: 0, gold: 0 },
      ownBuildings: [
        makeBuilding({ id: 10 }),
        makeBuilding({ id: 50, type: HOUSE, x: 16, y: 16, state: ObjectState.Unbuilt, isUnbuilt: true, hp: 1 }),
      ],
    });
    const activeAfterMaterialize = reconcilePending(obs3, state);
    expect(activeAfterMaterialize).toHaveLength(0);
    // Must NOT double-reserve 30 wood! Available wood is 170, not 140.
    expect(getAvailableResources(obs3, state).wood).toBe(170);
  });

  test('R03: prevents duplicate research of same techId across 2 buildings and blocks busy buildings', () => {
    const state = createArbiterState();
    const obs0 = makeObservation({
      turn: 0,
      resources: { food: 500, wood: 500, stone: 0, gold: 0 },
      ownBuildings: [
        makeBuilding({ id: 20, type: BARRACKS }),
        makeBuilding({ id: 21, type: BARRACKS }),
        makeBuilding({ id: 22, type: BARRACKS, trainingUnit: 73, queueLength: 1, isBusy: true }),
      ],
    });

    const researchB1: BotIntent = {
      key: 'research:63:20',
      priority: 90,
      reason: 'Axeman at barracks 20',
      cost: { food: 100 },
      buildingId: 20,
      command: { type: 'research', building: 20, tech: 63 },
    };
    const researchB2SameTech: BotIntent = {
      key: 'research:63:21',
      priority: 85,
      reason: 'Axeman at barracks 21 (duplicate tech across 2 buildings)',
      cost: { food: 100 },
      buildingId: 21,
      command: { type: 'research', building: 21, tech: 63 },
    };
    const researchBusyB3: BotIntent = {
      key: 'research:64:22',
      priority: 80,
      reason: 'Tech at busy training barracks 22',
      cost: { food: 100 },
      buildingId: 22,
      command: { type: 'research', building: 22, tech: 64 },
    };
    const queueSameB1: BotIntent = {
      key: 'queue:20:73',
      priority: 75,
      reason: 'Queue at barracks 20 already researching',
      cost: { food: 50, headroom: 1 },
      buildingId: 20,
      command: { type: 'queue', building: 20, unit: 73, count: 1 },
    };

    const res0 = arbitrateIntents([researchB1, researchB2SameTech, researchBusyB3, queueSameB1], obs0, state);
    expect(res0.accepted.map((i) => i.key)).toEqual(['research:63:20']);
    expect(res0.outcomesByKey['research:63:21']?.reason).toBe('duplicate-pending');
    expect(res0.outcomesByKey['research:64:22']?.reason).toBe('building-busy-or-claimed');
    expect(res0.outcomesByKey['queue:20:73']?.reason).toBe('building-busy-or-claimed');
    expect(getAvailableResources(obs0, state).food).toBe(400);

    // Turn 1: still pending across CTI=2, so barracks 21 still cannot start tech 63
    const obs1 = makeObservation({ ...obs0, turn: 1 });
    reconcilePending(obs1, state);
    const res1 = arbitrateIntents([researchB2SameTech], obs1, state);
    expect(res1.accepted).toHaveLength(0);
    expect(res1.outcomesByKey['research:63:21']?.reason).toBe('duplicate-pending');

    // Turn 3: tech 63 enters TECH_RESEARCHING in observation and World spent 100 food (now 400)
    const nextTechs = [...obs0.techStates];
    nextTechs[63] = TECH_RESEARCHING;
    const obs3 = makeObservation({
      ...obs0,
      turn: 3,
      resources: { food: 400, wood: 500, stone: 0, gold: 0 },
      techStates: nextTechs,
      ownBuildings: [
        makeBuilding({ id: 20, type: BARRACKS, researchingTech: 63, isBusy: true }),
        makeBuilding({ id: 21, type: BARRACKS }),
        makeBuilding({ id: 22, type: BARRACKS, trainingUnit: 73, queueLength: 1, isBusy: true }),
      ],
    });
    reconcilePending(obs3, state);
    expect(state.pending).toHaveLength(0);
    // No double reservation of 100 food!
    expect(getAvailableResources(obs3, state).food).toBe(400);

    // Attempting tech 63 on barracks 21 while tech 63 is TECH_RESEARCHING / TECH_DONE must still reject as duplicate-pending
    const res3 = arbitrateIntents([researchB2SameTech], obs3, state);
    expect(res3.outcomesByKey['research:63:21']?.reason).toBe('duplicate-pending');

    nextTechs[63] = TECH_DONE;
    const obsDone = makeObservation({ ...obs3, turn: 10, techStates: nextTechs });
    expect(arbitrateIntents([researchB2SameTech], obsDone, state).outcomesByKey['research:63:21']?.reason).toBe(
      'duplicate-pending',
    );
  });

  test('materializes queue pending when expectedQueueCount is reached without double-reserving', () => {
    const state = createArbiterState();
    const obs0 = makeObservation({
      turn: 0,
      resources: { food: 150, wood: 0, stone: 0, gold: 0 },
      ownBuildings: [makeBuilding({ id: 10, trainingUnit: VILLAGER, queueLength: 1, queuedUnits: [{ unit: VILLAGER, count: 1 }] })],
    });

    const queue2nd: BotIntent = {
      key: 'queue:10:villager:2',
      priority: 80,
      reason: 'second villager',
      cost: { food: 50, headroom: 1 },
      buildingId: 10,
      command: { type: 'queue', building: 10, unit: VILLAGER, count: 1 },
    };

    const res0 = arbitrateIntents([queue2nd], obs0, state);
    expect(res0.accepted).toHaveLength(1);
    expect(state.pending[0]?.expectedQueueCount).toBe(2);
    expect(state.pending[0]?.trainUnitId).toBe(VILLAGER);

    // At turn 1, queueLength is still 1 (previous villager), so it must NOT prematurely release!
    const obs1 = makeObservation({ ...obs0, turn: 1 });
    expect(reconcilePending(obs1, state)).toHaveLength(1);
    expect(getAvailableResources(obs1, state).food).toBe(100);

    // At turn 3, queueLength becomes 2 and World spent 50 food (now 100)
    const obs3 = makeObservation({
      turn: 3,
      resources: { food: 100, wood: 0, stone: 0, gold: 0 },
      ownBuildings: [makeBuilding({ id: 10, trainingUnit: VILLAGER, queueLength: 2, queuedUnits: [{ unit: VILLAGER, count: 2 }] })],
    });
    expect(reconcilePending(obs3, state)).toHaveLength(0);
    expect(getAvailableResources(obs3, state).food).toBe(100);
  });

  test('does NOT prematurely materialize queue pending during COMMAND_DELAY_TURNS when switching unit types or unqueuing', () => {
    // 1) Switching unit types: Barracks 20 training Clubman (73) queues Short Swordsman (75)
    const stateSwitch = createArbiterState();
    const obs0 = makeObservation({
      turn: 0,
      resources: { food: 200, wood: 100, stone: 0, gold: 100 },
      population: { current: 4, limit: 8, headroom: 4 },
      ownBuildings: [
        makeBuilding({
          id: 20,
          type: BARRACKS,
          trainingUnit: CLUBMAN,
          queueLength: 1,
          queuedUnits: [{ unit: CLUBMAN, count: 1 }],
          isBusy: true,
        }),
      ],
    });

    const switchIntent: BotIntent = {
      key: 'queue:20:75',
      priority: 85,
      reason: 'switch barracks to Short Swordsman',
      cost: { food: 35, gold: 15, headroom: 1 },
      buildingId: 20,
      command: { type: 'queue', building: 20, unit: 75, count: 1 },
    };

    const res0 = arbitrateIntents([switchIntent], obs0, stateSwitch);
    expect(res0.accepted).toHaveLength(1);
    expect(getAvailableBudget(obs0, stateSwitch)).toMatchObject({ food: 165, gold: 85, headroom: 3 });

    // Turn 1 (during CTI=2): Barracks still shows Clubman 73 -> MUST NOT materialize or unlock building!
    const obs1 = makeObservation({ ...obs0, turn: 1 });
    expect(reconcilePending(obs1, stateSwitch)).toHaveLength(1);
    expect(stateSwitch.pending[0]?.status).toBe('issued');
    expect(isBuildingPending(stateSwitch, 20)).toBe(true);
    expect(getAvailableBudget(obs1, stateSwitch)).toMatchObject({ food: 165, gold: 85, headroom: 3 });

    // Conflicting queue/research on building 20 at turn 1 must be rejected
    const conflictRes = arbitrateIntents(
      [
        {
          key: 'queue:20:73:conflict',
          priority: 95,
          reason: 'conflicting queue',
          cost: { food: 50, headroom: 1 },
          buildingId: 20,
          command: { type: 'queue', building: 20, unit: CLUBMAN, count: 1 },
        },
      ],
      obs1,
      stateSwitch,
    );
    expect(conflictRes.accepted).toHaveLength(0);
    expect(conflictRes.outcomesByKey['queue:20:73:conflict']?.reason).toBe('building-busy-or-claimed');

    // Turn 3 (after CTI=2 executes): World cleared Clubman and started Short Swordsman 75
    const obs3 = makeObservation({
      turn: 3,
      resources: { food: 165, wood: 100, stone: 0, gold: 85 },
      population: { current: 5, limit: 8, headroom: 3 },
      ownBuildings: [
        makeBuilding({
          id: 20,
          type: BARRACKS,
          trainingUnit: 75,
          queueLength: 1,
          queuedUnits: [{ unit: 75, count: 1 }],
          isBusy: true,
        }),
      ],
    });
    expect(reconcilePending(obs3, stateSwitch)).toHaveLength(0);
    expect(stateSwitch.lastResolved[0]?.status).toBe('applied');
    expect(getAvailableBudget(obs3, stateSwitch)).toMatchObject({ food: 165, gold: 85, headroom: 3 });

    // 2) Non-adjacent pre-existing unit type in queue ([75, 73]) switching to 75
    const stateNonAdj = createArbiterState();
    const obsNonAdj0 = makeObservation({
      turn: 0,
      resources: { food: 200, wood: 0, stone: 0, gold: 100 },
      population: { current: 4, limit: 8, headroom: 4 },
      ownBuildings: [
        makeBuilding({
          id: 20,
          type: BARRACKS,
          trainingUnit: 75,
          queueLength: 2,
          queuedUnits: [
            { unit: 75, count: 1 },
            { unit: CLUBMAN, count: 1 },
          ],
          isBusy: true,
        }),
      ],
    });
    expect(arbitrateIntents([switchIntent], obsNonAdj0, stateNonAdj).accepted).toHaveLength(1);
    // At turn 1 and turn 2 (<= expectedApplyTurn), pre-existing 75 must NOT satisfy materialization
    expect(reconcilePending(makeObservation({ ...obsNonAdj0, turn: 1 }), stateNonAdj)).toHaveLength(1);
    expect(reconcilePending(makeObservation({ ...obsNonAdj0, turn: 2 }), stateNonAdj)).toHaveLength(1);
    // At turn 3 (> expectedApplyTurn), cleared & queued 75 materializes
    expect(
      reconcilePending(
        makeObservation({
          ...obsNonAdj0,
          turn: 3,
          ownBuildings: [
            makeBuilding({
              id: 20,
              type: BARRACKS,
              trainingUnit: 75,
              queueLength: 1,
              queuedUnits: [{ unit: 75, count: 1 }],
              isBusy: true,
            }),
          ],
        }),
        stateNonAdj,
      ),
    ).toHaveLength(0);
    expect(stateNonAdj.lastResolved[0]?.status).toBe('applied');

    // 3) Unqueue (count < 0) during CTI=2 must NOT materialize before expectedApplyTurn
    const stateUnqueue = createArbiterState();
    const obsUnq0 = makeObservation({
      turn: 0,
      ownBuildings: [
        makeBuilding({
          id: 21,
          type: BARRACKS,
          trainingUnit: CLUBMAN,
          queueLength: 2,
          queuedUnits: [{ unit: CLUBMAN, count: 2 }],
          isBusy: true,
        }),
      ],
    });
    const unqueueIntent: BotIntent = {
      key: 'unqueue:21:73',
      priority: 80,
      reason: 'unqueue one clubman',
      buildingId: 21,
      command: { type: 'queue', building: 21, unit: CLUBMAN, count: -1 },
    };
    expect(arbitrateIntents([unqueueIntent], obsUnq0, stateUnqueue).accepted).toHaveLength(1);
    expect(reconcilePending(makeObservation({ ...obsUnq0, turn: 1 }), stateUnqueue)).toHaveLength(1);
    expect(reconcilePending(makeObservation({ ...obsUnq0, turn: 2 }), stateUnqueue)).toHaveLength(1);

    const obsUnq3 = makeObservation({
      turn: 3,
      ownBuildings: [
        makeBuilding({
          id: 21,
          type: BARRACKS,
          trainingUnit: CLUBMAN,
          queueLength: 1,
          queuedUnits: [{ unit: CLUBMAN, count: 1 }],
          isBusy: true,
        }),
      ],
    });
    expect(reconcilePending(obsUnq3, stateUnqueue)).toHaveLength(0);
    expect(stateUnqStatus(stateUnqueue)).toBe('applied');
  });
});

function stateUnqStatus(state: ReturnType<typeof createArbiterState>) {
  return state.lastResolved[0]?.status;
}

describe('T02 B03 — Pending released once on actor death, building destroyed, target lost, or TTL expiry', () => {
  test('releases pending on actor death (only when ALL assigned unitIds are dead/missing)', () => {
    const state = createArbiterState();
    const obs0 = makeObservation({
      turn: 0,
      resources: { food: 200, wood: 200, stone: 0, gold: 0 },
      ownUnits: [makeUnit({ id: 1 }), makeUnit({ id: 2 })],
    });

    const buildIntent: BotIntent = {
      key: 'build:barracks:1',
      priority: 80,
      reason: 'build with 2 villagers',
      cost: { wood: 125 },
      unitIds: [1, 2],
      spot: { x: 18, y: 18, masterId: BARRACKS },
      command: { type: 'build', units: [1, 2], unitType: BARRACKS, x: 18, y: 18 },
    };

    arbitrateIntents([buildIntent], obs0, state);
    expect(getAvailableResources(obs0, state).wood).toBe(75);

    // One builder dies, one still alive -> pending stays active
    const obs1 = makeObservation({ turn: 1, ownUnits: [makeUnit({ id: 2 })] });
    expect(reconcilePending(obs1, state)).toHaveLength(1);
    expect(getAvailableResources(obs1, state).wood).toBe(75);

    // Remaining builder dies -> pending transitions to failed and releases once
    const obs2 = makeObservation({ turn: 2, ownUnits: [] });
    const pendingRef = state.pending[0]!;
    expect(reconcilePending(obs2, state)).toHaveLength(0);
    expect(pendingRef.status).toBe('failed');
    expect(getAvailableResources(obs2, state).wood).toBe(200);

    // Calling reconcilePending again must not double-release or mutate
    expect(reconcilePending(obs2, state)).toHaveLength(0);
    expect(getAvailableResources(obs2, state).wood).toBe(200);
  });

  test('releases pending when buildingId is destroyed/missing', () => {
    const state = createArbiterState();
    const obs0 = makeObservation({
      turn: 0,
      resources: { food: 300, wood: 0, stone: 0, gold: 0 },
      ownBuildings: [makeBuilding({ id: 20, type: BARRACKS })],
    });

    const research: BotIntent = {
      key: 'research:63:20',
      priority: 80,
      reason: 'axeman',
      cost: { food: 100 },
      buildingId: 20,
      command: { type: 'research', building: 20, tech: 63 },
    };
    arbitrateIntents([research], obs0, state);
    expect(getAvailableResources(obs0, state).food).toBe(200);

    // Building destroyed
    const obs1 = makeObservation({
      turn: 1,
      resources: { food: 300, wood: 0, stone: 0, gold: 0 },
      ownBuildings: [makeBuilding({ id: 20, type: BARRACKS, hp: 0, state: ObjectState.Dying })],
    });
    const pendingRef = state.pending[0]!;
    expect(reconcilePending(obs1, state)).toHaveLength(0);
    expect(pendingRef.status).toBe('failed');
    expect(getAvailableResources(obs1, state).food).toBe(300);
  });

  test('releases pending when attack/work/repair target is dead, depleted, or missing', () => {
    const state = createArbiterState();
    const obs0 = makeObservation({
      turn: 0,
      ownUnits: [makeUnit({ id: 1 }), makeUnit({ id: 2 }), makeUnit({ id: 3 })],
      ownBuildings: [makeBuilding({ id: 10 })],
      knownEnemies: [
        {
          id: 500,
          owner: 1,
          type: 73,
          x: 20,
          y: 20,
          hp: 40,
          maxHp: 40,
          state: ObjectState.Active,
          isBuilding: false,
          isStatic: false,
          isVillager: false,
          isMilitary: true,
          visibleNow: true,
          lastSeenTurn: 0,
          reachRange: 1.5,
        },
      ],
      knownResources: [
        {
          id: 600,
          type: FORAGE,
          x: 15,
          y: 10,
          state: ObjectState.Active,
          heldType: 0,
          heldAmount: 125,
          resourceGroup: 0,
          visibleNow: true,
          lastSeenTurn: 0,
          isDangerous: false,
        },
      ],
    });

    const attackIntent: BotIntent = {
      key: 'attack:1:500',
      priority: 80,
      reason: 'attack',
      unitIds: [1],
      command: { type: 'attack', units: [1], target: 500 },
    };
    const workIntent: BotIntent = {
      key: 'work:2:600',
      priority: 70,
      reason: 'forage',
      unitIds: [2],
      command: { type: 'work', units: [2], target: 600, x: 15, y: 10 },
    };
    const repairIntent: BotIntent = {
      key: 'repair:3:10',
      priority: 60,
      reason: 'repair TC',
      unitIds: [3],
      command: { type: 'repair', units: [3], target: 10 },
    };

    const res = arbitrateIntents([attackIntent, workIntent, repairIntent], obs0, state);
    expect(res.accepted).toHaveLength(3);
    expect(state.pending.map((p) => p.targetId)).toEqual([500, 600, 10]);

    // Enemy killed (missing), resource depleted (heldAmount 0), TC destroyed (missing)
    const obs1 = makeObservation({
      turn: 1,
      ownUnits: [makeUnit({ id: 1 }), makeUnit({ id: 2 }), makeUnit({ id: 3 })],
      ownBuildings: [],
      knownEnemies: [],
      knownResources: [
        {
          id: 600,
          type: FORAGE,
          x: 15,
          y: 10,
          state: ObjectState.Active,
          heldType: 0,
          heldAmount: 0,
          resourceGroup: 0,
          visibleNow: true,
          lastSeenTurn: 1,
          isDangerous: false,
        },
      ],
    });

    const refs = [...state.pending];
    expect(reconcilePending(obs1, state)).toHaveLength(0);
    for (const r of refs) expect(r.status).toBe('failed');
  });

  test('does not expire before expectedApplyTurn (even with small ttlTurns) and expires cleanly after expiresTurn', () => {
    const state = createArbiterState();
    const obs0 = makeObservation({ turn: 10, resources: { food: 200, wood: 200, stone: 0, gold: 0 } });

    const defaultTtlIntent: BotIntent = {
      key: 'build:house:default',
      priority: 80,
      reason: 'default ttl',
      cost: { wood: 30 },
      unitIds: [1],
      spot: { x: 16, y: 16, masterId: HOUSE },
      command: { type: 'build', units: [1], unitType: HOUSE, x: 16, y: 16 },
    };
    const tinyTtlIntent: BotIntent = {
      key: 'move:2:tiny',
      priority: 70,
      reason: 'tiny ttl clamped >= CTI+1',
      unitIds: [2],
      ttlTurns: 1,
      command: { type: 'move', units: [2], x: 20, y: 20 },
    };

    arbitrateIntents([defaultTtlIntent, tinyTtlIntent], obs0, state);
    const pDefault = state.pending.find((p) => p.key === 'build:house:default')!;
    const pTiny = state.pending.find((p) => p.key === 'move:2:tiny')!;

    expect(pDefault.expectedApplyTurn).toBe(10 + COMMAND_DELAY_TURNS);
    expect(pDefault.expiresTurn).toBeGreaterThanOrEqual(10 + COMMAND_DELAY_TURNS + 4);
    expect(pTiny.expiresTurn).toBeGreaterThan(pTiny.expectedApplyTurn);

    // At expectedApplyTurn (12), neither has expired (no early spam!)
    expect(reconcilePending(makeObservation({ turn: 12 }), state)).toHaveLength(2);
    // At turn 13 (tiny expiresTurn = 13 -> still valid until > expiresTurn), both active
    expect(reconcilePending(makeObservation({ turn: 13 }), state)).toHaveLength(2);
    // At turn 14 (> 13), tiny expires while default stays active
    expect(reconcilePending(makeObservation({ turn: 14 }), state)).toHaveLength(1);
    expect(pTiny.status).toBe('expired');
    expect(pDefault.status).toBe('issued');

    // Past default expiresTurn, default expires and releases wood
    const obsPast = makeObservation({ turn: pDefault.expiresTurn + 1, resources: { food: 200, wood: 200, stone: 0, gold: 0 } });
    expect(reconcilePending(obsPast, state)).toHaveLength(0);
    expect(pDefault.status).toBe('expired');
    expect(getAvailableResources(obsPast, state).wood).toBe(200);
  });

  test('releases pending research early when tech transitions to TECH_DISABLED, and rejects TECH_DISABLED / TECH_LOCKED in arbitrateIntents', () => {
    const state = createArbiterState();
    const techs = new Array<number>(130).fill(TECH_AVAILABLE);
    techs[64] = TECH_DISABLED;
    techs[65] = TECH_LOCKED;

    const obs0 = makeObservation({
      turn: 0,
      resources: { food: 300, wood: 0, stone: 0, gold: 0 },
      techStates: techs,
      ownBuildings: [makeBuilding({ id: 20, type: BARRACKS }), makeBuilding({ id: 21, type: BARRACKS })],
    });

    const disabledIntent: BotIntent = {
      key: 'research:64:20',
      priority: 95,
      reason: 'disabled tech',
      cost: { food: 100 },
      buildingId: 20,
      command: { type: 'research', building: 20, tech: 64 },
    };
    const lockedIntent: BotIntent = {
      key: 'research:65:21',
      priority: 90,
      reason: 'locked tech',
      cost: { food: 100 },
      buildingId: 21,
      command: { type: 'research', building: 21, tech: 65 },
    };
    const validIntent: BotIntent = {
      key: 'research:63:20',
      priority: 80,
      reason: 'available tech',
      cost: { food: 100 },
      buildingId: 20,
      command: { type: 'research', building: 20, tech: 63 },
    };

    const res0 = arbitrateIntents([disabledIntent, lockedIntent, validIntent], obs0, state);
    expect(res0.outcomesByKey['research:64:20']).toMatchObject({ accepted: false, reason: 'invalid-intent' });
    expect(res0.outcomesByKey['research:65:21']).toMatchObject({ accepted: false, reason: 'invalid-intent' });
    expect(res0.outcomesByKey['research:63:20']?.accepted).toBe(true);
    expect(getAvailableResources(obs0, state).food).toBe(200);
    expect(isBuildingPending(state, 20)).toBe(true);

    // At turn 1, tech 63 becomes TECH_DISABLED -> pending fails early and releases 100 food + building 20 once
    const nextTechs = [...techs];
    nextTechs[63] = TECH_DISABLED;
    const obs1 = makeObservation({ ...obs0, turn: 1, techStates: nextTechs });
    expect(reconcilePending(obs1, state)).toHaveLength(0);
    expect(state.lastResolved[0]?.status).toBe('failed');
    expect(isBuildingPending(state, 20)).toBe(false);
    expect(getAvailableResources(obs1, state).food).toBe(300);

    // Reconciling again does not double-release
    expect(reconcilePending(obs1, state)).toHaveLength(0);
    expect(getAvailableResources(obs1, state).food).toBe(300);
  });
});

describe('T02 B04 — MAX_COMMANDS_PER_BATCH=256 cap & high-priority preservation', () => {
  test('caps accepted commands at 256 while preserving highest-priority intents without starvation', () => {
    expect(MAX_COMMANDS_PER_BATCH).toBe(256);

    const obs = makeObservation({
      resources: { food: 50000, wood: 50000, stone: 50000, gold: 50000 },
    });
    const state = createArbiterState();

    const intents: BotIntent[] = [];
    // Propose 260 low-priority scouts/moves first, and 10 high-priority economy/defense intents last
    for (let i = 0; i < 260; i++) {
      intents.push({
        key: `scout:${i}`,
        priority: 10 + (i % 5),
        reason: 'low priority scout',
        unitIds: [1000 + i],
        command: { type: 'move', units: [1000 + i], x: 20, y: 20 },
      });
    }
    for (let i = 0; i < 10; i++) {
      intents.push({
        key: `critical:defense:${i}`,
        priority: 100 + i,
        reason: 'high priority defense',
        cost: { food: 50 },
        unitIds: [2000 + i],
        command: { type: 'attack', units: [2000 + i], target: 9000 + i },
      });
    }

    const res = arbitrateIntents(intents, obs, state);
    expect(res.accepted).toHaveLength(MAX_COMMANDS_PER_BATCH);
    expect(res.commands).toHaveLength(MAX_COMMANDS_PER_BATCH);
    expect(res.rejected).toHaveLength(14);

    // Every single high-priority defense intent MUST be in accepted
    for (let i = 0; i < 10; i++) {
      expect(res.outcomesByKey[`critical:defense:${i}`]?.accepted).toBe(true);
    }

    // Rejected low-priority intents get batch-limit-exceeded and do not claim units or food
    for (const r of res.rejected) {
      expect(r.accepted).toBe(false);
      expect(r.reason).toBe('batch-limit-exceeded');
    }
    expect(state.pending).toHaveLength(MAX_COMMANDS_PER_BATCH);
    expect(getAvailableResources(obs, state).food).toBe(50000 - 10 * 50);
  });
});

describe('T02 B05 — Two-phase propose/commit contract & real sim integration', () => {
  test('rejected build/attack intents do NOT mutate phase, cooldown, or pending, and retry cleanly on next tick', () => {
    const profile = getBotProfile('medium');
    const arbiterState = createArbiterState();
    const plannerState = makePlannerState();

    // Stateful two-phase mock planner: proposes a build and an attack
    let squadPhase: 'forming' | 'attacking' = 'forming';
    let buildCommittedCount = 0;
    let attackCommittedCount = 0;

    const testPlanner: BotPlanner = {
      name: 'test-two-phase-planner',
      propose(input: PlannerInput): BotIntent[] {
        const intents: BotIntent[] = [];
        const hasPendingBuild = input.pendingActions.some((p) => p.key === 'build:house:retry');
        if (buildCommittedCount === 0 && !hasPendingBuild) {
          intents.push({
            key: 'build:house:retry',
            priority: 60,
            reason: 'build house',
            cost: { wood: 30 },
            unitIds: [1],
            spot: { x: 16, y: 16, masterId: HOUSE },
            command: { type: 'build', units: [1], unitType: HOUSE, x: 16, y: 16 },
          });
        }
        if (squadPhase === 'forming' && (input.state.unitCooldownUntil[2] ?? 0) <= input.observation.turn) {
          intents.push({
            key: 'attack:squad1:500',
            priority: 50,
            reason: 'squad1 attack',
            unitIds: [2],
            command: { type: 'attack', units: [2], target: 500 },
          });
        }
        return intents;
      },
      commit(outcomes: Readonly<Record<string, IntentOutcome>>, input: PlannerInput): void {
        const buildOut = outcomes['build:house:retry'];
        if (buildOut?.accepted) {
          buildCommittedCount++;
          input.state.unitCooldownUntil[1] = input.observation.turn + 4;
        }
        const attackOut = outcomes['attack:squad1:500'];
        if (attackOut?.accepted) {
          attackCommittedCount++;
          squadPhase = 'attacking';
          input.state.unitCooldownUntil[2] = input.observation.turn + 4;
        }
      },
    };

    // High-priority competing planner that consumes all wood AND unit 2 on Tick 0!
    const hogPlanner: BotPlanner = {
      name: 'high-priority-hog',
      propose(input: PlannerInput): BotIntent[] {
        if (input.observation.turn !== 0) return [];
        return [
          {
            key: 'hog:wood-and-unit2',
            priority: 99,
            reason: 'emergency',
            cost: { wood: 25 },
            unitIds: [2],
            command: { type: 'move', units: [2], x: 5, y: 5 },
          },
        ];
      },
      commit(): void {},
    };

    // Tick 0: only 25 wood, unit 2 taken by hog -> both build (needs 30 wood) and attack (unit 2) are REJECTED!
    const obs0 = makeObservation({ turn: 0, resources: { food: 100, wood: 25, stone: 0, gold: 0 } });
    const res0 = runProposeCommitCycle([testPlanner, hogPlanner], obs0, profile, arbiterState, plannerState, 123);

    expect(res0.outcomesByKey['build:house:retry']).toMatchObject({ accepted: false, reason: 'insufficient-budget' });
    expect(res0.outcomesByKey['attack:squad1:500']).toMatchObject({ accepted: false, reason: 'unit-busy-or-claimed' });
    expect(squadPhase).toBe('forming');
    expect(buildCommittedCount).toBe(0);
    expect(attackCommittedCount).toBe(0);
    expect(plannerState.unitCooldownUntil[1]).toBeUndefined();
    expect(plannerState.unitCooldownUntil[2]).toBeUndefined();
    expect(arbiterState.pending.some((p) => p.key === 'build:house:retry' || p.key === 'attack:squad1:500')).toBe(false);

    // Tick 7 (past hog's default expiresTurn = 6): hog move expired, wood gathered to 50 -> testPlanner retries cleanly and BOTH commit ONCE!
    const obs7 = makeObservation({ turn: 7, resources: { food: 100, wood: 50, stone: 0, gold: 0 } });
    const res7 = runProposeCommitCycle([testPlanner, hogPlanner], obs7, profile, arbiterState, plannerState, 123);

    expect(res7.outcomesByKey['build:house:retry']?.accepted).toBe(true);
    expect(res7.outcomesByKey['attack:squad1:500']?.accepted).toBe(true);
    expect(buildCommittedCount).toBe(1);
    expect(attackCommittedCount).toBe(1);
    expect(squadPhase).toBe('attacking');
    expect(plannerState.unitCooldownUntil[1]).toBe(11);
    expect(plannerState.unitCooldownUntil[2]).toBe(11);

    // Tick 8: retrying during pending window does NOT double-commit
    const obs8 = makeObservation({ turn: 8, resources: { food: 100, wood: 50, stone: 0, gold: 0 } });
    const res8 = runProposeCommitCycle([testPlanner, hogPlanner], obs8, profile, arbiterState, plannerState, 123);
    expect(res8.accepted).toHaveLength(0);
    expect(buildCommittedCount).toBe(1);
    expect(attackCommittedCount).toBe(1);
  });

  test('integrates with real @aoe/sim World across COMMAND_DELAY_TURNS=2 without double-building or double-reserving', () => {
    const world = new World({ players: 3, units: startingObjects(3) });
    const state = createArbiterState();
    const profile = getBotProfile('medium');
    const plannerState = makePlannerState();

    const p2Villagers = [...world.entities.ofPlayer(2)].filter((e) => e.type === VILLAGER);
    const v1 = p2Villagers[0]!;
    const tc = [...world.entities.ofPlayer(2)].find((e) => e.type === TOWN_CENTER)!;

    const toMinimalObs = (): BotObservation => {
      const p2 = [...world.entities.ofPlayer(2)];
      return makeObservation({
        turn: world.turn,
        worldTime: world.worldTime,
        resources: {
          food: world.attributes[2]![0]!,
          wood: world.attributes[2]![1]!,
          stone: world.attributes[2]![2]!,
          gold: world.attributes[2]![3]!,
        },
        ownUnits: p2
          .filter((e) => e.type === VILLAGER)
          .map((e) => makeUnit({ id: e.id, x: e.x, y: e.y, hp: e.hp, state: e.state })),
        ownBuildings: p2
          .filter((e) => e.type !== VILLAGER)
          .map((e) =>
            makeBuilding({
              id: e.id,
              type: e.type,
              x: e.x,
              y: e.y,
              hp: e.hp,
              state: e.state,
              isUnbuilt: e.state === ObjectState.Unbuilt,
            }),
          ),
      });
    };

    const housePlanner: BotPlanner = {
      name: 'house-planner',
      propose(input) {
        if (input.observation.ownBuildings.some((b) => b.type === HOUSE)) return [];
        return [
          {
            key: 'build:house:1',
            priority: 90,
            reason: 'Build first house',
            cost: { wood: 30 },
            unitIds: [v1.id],
            spot: { x: tc.x - 4, y: tc.y, masterId: HOUSE },
            command: { type: 'build', units: [v1.id], unitType: HOUSE, x: tc.x - 4, y: tc.y },
          },
        ];
      },
      commit() {},
    };

    const commandsPerTurn: Command[][] = [];
    for (let t = 0; t <= COMMAND_DELAY_TURNS + 1; t++) {
      const obs = toMinimalObs();
      const res = runProposeCommitCycle([housePlanner], obs, profile, state, plannerState, 1);
      commandsPerTurn.push(res.commands);
      if (res.commands.length > 0) {
        world.addBatch(world.turn, 2, res.commands);
      }
      world.runTurn();
    }

    // Command issued once on turn 0, none on turns 1..3
    expect(commandsPerTurn[0]).toHaveLength(1);
    expect(commandsPerTurn[1]).toHaveLength(0);
    expect(commandsPerTurn[2]).toHaveLength(0);
    expect(commandsPerTurn[3]).toHaveLength(0);

    // Foundation exists in real World and pending reconciled to empty without double wood deduction
    const houses = [...world.entities.ofPlayer(2)].filter((e) => e.type === HOUSE);
    expect(houses).toHaveLength(1);
    const finalObs = toMinimalObs();
    reconcilePending(finalObs, state);
    expect(state.pending).toHaveLength(0);
    expect(getAvailableResources(finalObs, state).wood).toBe(170);
  });

  test('integrates with real @aoe/sim World across COMMAND_DELAY_TURNS=2 for research (TOOL_AGE) without double-reserving', () => {
    const world = new World({ players: 3, units: startingObjects(3), resourceLevel: 3 });
    world.createUnit({ owner: 2, type: GRANARY, x: 35.5, y: 35.5 });
    world.createUnit({ owner: 2, type: BARRACKS, x: 38.5, y: 35.5 });
    for (let i = 0; i < 40 && world.techs[2]![TOOL_AGE] !== TECH_AVAILABLE; i++) {
      world.runTurn();
    }
    expect(world.techs[2]![TOOL_AGE]).toBe(TECH_AVAILABLE);

    const state = createArbiterState();
    const profile = getBotProfile('medium');
    const plannerState = makePlannerState();
    const tc = [...world.entities.ofPlayer(2)].find((e) => e.type === TOWN_CENTER)!;

    const toolAgePlanner: BotPlanner = {
      name: 'tool-age-planner',
      propose(input) {
        if ((input.observation.techStates[TOOL_AGE] ?? 0) !== TECH_AVAILABLE) return [];
        return [
          {
            key: `research:${TOOL_AGE}:${tc.id}`,
            priority: 95,
            reason: 'Advance to Tool Age',
            cost: { food: 500 },
            buildingId: tc.id,
            command: { type: 'research', building: tc.id, tech: TOOL_AGE },
          },
        ];
      },
      commit() {},
    };

    const startFood = world.attributes[2]![0]!;
    const commandsPerTurn: Command[][] = [];
    for (let t = 0; t <= COMMAND_DELAY_TURNS + 1; t++) {
      const { observation } = createBotObservation(world, 2);
      const res = runProposeCommitCycle([toolAgePlanner], observation, profile, state, plannerState, 1);
      commandsPerTurn.push(res.commands);
      if (t < COMMAND_DELAY_TURNS) {
        expect(isTechPending(state, TOOL_AGE)).toBe(true);
        expect(getAvailableResources(observation, state).food).toBe(startFood - 500);
      }
      if (res.commands.length > 0) {
        world.addBatch(world.turn, 2, res.commands);
      }
      world.runTurn();
    }

    expect(commandsPerTurn[0]).toHaveLength(1);
    expect(commandsPerTurn[1]).toHaveLength(0);
    expect(commandsPerTurn[2]).toHaveLength(0);
    expect(commandsPerTurn[3]).toHaveLength(0);
    expect(tc.research?.tech).toBe(TOOL_AGE);
    expect(world.attributes[2]![0]).toBe(startFood - 500);

    const { observation: finalObs } = createBotObservation(world, 2);
    reconcilePending(finalObs, state);
    expect(state.pending).toHaveLength(0);
    expect(getAvailableResources(finalObs, state).food).toBe(startFood - 500);
  });

  test('integrates with real @aoe/sim World across COMMAND_DELAY_TURNS=2 when switching queued unit type without premature release', () => {
    const world = new World({
      players: 3,
      units: startingObjects(3),
      startingAge: AGE_BRONZE,
      deathMatch: true,
    });
    const barracks = world.createUnit({ owner: 2, type: BARRACKS, x: 36.5, y: 36.5 });
    world.createUnit({ owner: 2, type: HOUSE, x: 36.5, y: 33.5 });

    // Queue Clubman (73) and run until Barracks is actively training Clubman
    world.addBatch(world.turn, 2, [{ type: 'queue', building: barracks.id, unit: CLUBMAN, count: 1 }]);
    for (let i = 0; i <= COMMAND_DELAY_TURNS; i++) {
      world.runTurn();
    }
    expect(barracks.train?.unit).toBe(CLUBMAN);

    const state = createArbiterState();
    const profile = getBotProfile('medium');
    const plannerState = makePlannerState();

    const { observation: obs0 } = createBotObservation(world, 2);
    const slingerMaster = obs0.enabledMasters[SLINGER]!;
    expect(slingerMaster?.enabled).toBe(true);
    const foodCost = slingerMaster.costs.find((c) => c.type === 0)?.amount ?? 40;
    const stoneCost = slingerMaster.costs.find((c) => c.type === 2)?.amount ?? 10;

    let issuedTurn = -1;
    const switchPlanner: BotPlanner = {
      name: 'barracks-switch-planner',
      propose(input) {
        const b = input.observation.ownBuildings.find((ob) => ob.id === barracks.id);
        if (!b || b.trainingUnit === SLINGER || b.queuedUnits.some((q) => q.unit === SLINGER)) return [];
        return [
          {
            key: `queue:${barracks.id}:${SLINGER}`,
            priority: 90,
            reason: 'Switch Barracks from Clubman to Slinger',
            cost: { food: foodCost, stone: stoneCost, headroom: 1 },
            buildingId: barracks.id,
            command: { type: 'queue', building: barracks.id, unit: SLINGER, count: 1 },
          },
        ];
      },
      commit(outcomes) {
        if (outcomes[`queue:${barracks.id}:${SLINGER}`]?.accepted) {
          issuedTurn = world.turn;
        }
      },
    };

    const startFood = world.attributes[2]![0]!;
    const startStone = world.attributes[2]![2]!;
    const commandsPerTurn: Command[][] = [];

    for (let t = 0; t <= COMMAND_DELAY_TURNS + 1; t++) {
      const { observation } = createBotObservation(world, 2);
      const res = runProposeCommitCycle([switchPlanner], observation, profile, state, plannerState, 1);
      commandsPerTurn.push(res.commands);

      // During turns issuedTurn+1 and issuedTurn+2 (CTI=2 in flight), pending MUST NOT materialize early!
      if (t > 0 && t <= COMMAND_DELAY_TURNS) {
        expect(isBuildingPending(state, barracks.id)).toBe(true);
        expect(state.pending).toHaveLength(1);
        expect(getAvailableResources(observation, state).food).toBe(startFood - foodCost);
        expect(getAvailableResources(observation, state).stone).toBe(startStone - stoneCost);
      }

      if (res.commands.length > 0) {
        world.addBatch(world.turn, 2, res.commands);
      }
      world.runTurn();
    }

    expect(issuedTurn).toBeGreaterThanOrEqual(0);
    expect(commandsPerTurn[0]).toHaveLength(1);
    expect(commandsPerTurn[1]).toHaveLength(0);
    expect(commandsPerTurn[2]).toHaveLength(0);
    expect(commandsPerTurn[3]).toHaveLength(0);
    expect(barracks.train?.unit).toBe(SLINGER);

    const { observation: finalObs } = createBotObservation(world, 2);
    reconcilePending(finalObs, state);
    expect(state.pending).toHaveLength(0);
    expect(getAvailableResources(finalObs, state).food).toBe(finalObs.resources.food);
    expect(getAvailableResources(finalObs, state).stone).toBe(finalObs.resources.stone);
  });
});

describe('createPlannerInput & ArbiterState accessors', () => {
  test('constructs PlannerInput with cloned pendingActions snapshot', () => {
    const obs = makeObservation();
    const profile = getBotProfile('hard');
    const state = createArbiterState();
    const plannerState = makePlannerState();

    const input = createPlannerInput(obs, profile, state, plannerState, 999);
    expect(input.observation).toBe(obs);
    expect(input.profile).toBe(profile);
    expect(input.state).toBe(plannerState);
    expect(input.seed).toBe(999);
    expect(input.pendingActions).toEqual([]);
    expect(input.pendingActions).not.toBe(state.pending);
  });

  test('does not fail work on Dead fish/carcass with heldAmount > 0, and fails on PendingRemoval', () => {
    const state = createArbiterState();
    const obsDeadFish = makeObservation({
      turn: 0,
      knownResources: [
        {
          id: 700,
          type: 53, // Fish (ObjectState.Dead = 5 with 250 food)
          x: 20,
          y: 20,
          state: ObjectState.Dead,
          heldType: 0,
          heldAmount: 250,
          resourceGroup: 0,
          visibleNow: true,
          lastSeenTurn: 0,
          isDangerous: false,
        },
      ],
    });

    arbitrateIntents(
      [
        {
          key: 'work:1:fish',
          priority: 70,
          reason: 'fish',
          unitIds: [1],
          command: { type: 'work', units: [1], target: 700, x: 20, y: 20 },
        },
      ],
      obsDeadFish,
      state,
    );

    expect(reconcilePending({ ...obsDeadFish, turn: 1 }, state)).toHaveLength(1);
    expect(isUnitPending(state, 1)).toBe(true);
    expect(hasPendingKey(state, 'work:1:fish')).toBe(true);

    const obsPendingRemoval = makeObservation({
      turn: 2,
      knownResources: [
        {
          id: 700,
          type: 53,
          x: 20,
          y: 20,
          state: ObjectState.PendingRemoval,
          heldType: 0,
          heldAmount: 250,
          resourceGroup: 0,
          visibleNow: true,
          lastSeenTurn: 2,
          isDangerous: false,
        },
      ],
    });
    expect(reconcilePending(obsPendingRemoval, state)).toHaveLength(0);
    expect(state.lastResolved[0]?.status).toBe('failed');
  });

  test('tracks pending accessors, rejects unbuilt building queue/research, and resets cleanly', () => {
    const state = createArbiterState();
    const obs = makeObservation({
      ownBuildings: [
        makeBuilding({ id: 10 }),
        makeBuilding({ id: 30, type: BARRACKS, isUnbuilt: true, state: ObjectState.Unbuilt }),
      ],
    });

    const res = arbitrateIntents(
      [
        {
          key: 'research:101:10',
          priority: 90,
          reason: 'Tool Age',
          cost: { food: 500 },
          buildingId: 10,
          command: { type: 'research', building: 10, tech: 101 },
        },
        {
          key: 'queue:30:73',
          priority: 80,
          reason: 'Unbuilt barracks cannot train',
          cost: { food: 50 },
          buildingId: 30,
          command: { type: 'queue', building: 30, unit: 73, count: 1 },
        },
      ],
      obs,
      state,
    );

    // 500 food > 200 food in obs, so research rejected insufficient-budget; queue rejected building-busy-or-claimed
    expect(res.outcomesByKey['research:101:10']?.reason).toBe('insufficient-budget');
    expect(res.outcomesByKey['queue:30:73']?.reason).toBe('building-busy-or-claimed');

    const obsRich = makeObservation({ resources: { food: 600, wood: 200, stone: 150, gold: 0 } });
    arbitrateIntents(
      [
        {
          key: 'research:101:10',
          priority: 90,
          reason: 'Tool Age',
          cost: { food: 500 },
          buildingId: 10,
          command: { type: 'research', building: 10, tech: 101 },
        },
      ],
      obsRich,
      state,
    );

    expect(getActivePending(state)).toHaveLength(1);
    expect(isTechPending(state, 101)).toBe(true);
    expect(isBuildingPending(state, 10)).toBe(true);

    resetArbiterState(state);
    expect(getActivePending(state)).toHaveLength(0);
    expect(isTechPending(state, 101)).toBe(false);
    expect(isBuildingPending(state, 10)).toBe(false);
  });
});
