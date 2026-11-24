import { describe, expect, test, vi } from 'vitest';
import {
  BARRACKS,
  BOWMAN,
  CLUBMAN,
  COMMAND_DELAY_TURNS,
  HOUSE,
  ObjectState,
  SCOUT,
  SMALL_WALL,
  TERRAIN_GRASS,
  TERRAIN_WATER,
  TILE_BLACK,
  TileMap,
  TOWN_CENTER,
  VICTORY_SPECIAL,
  VILLAGER,
  World,
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
import { createSquadPlanner, SquadPlanner } from './squads';
import {
  BOT_CONTRACT_VERSION,
  type BotObservation,
  type BotPlannerState,
  type ObservedEnemy,
  type ObservedMaster,
  type ObservedOwnBuilding,
  type ObservedOwnUnit,
  type SquadState,
} from './types';

const WAR_BOAT = 19;
const FISHING_BOAT = 13;

function makeMaster(id: number, overrides: Partial<ObservedMaster> = {}): ObservedMaster {
  return {
    id,
    name: `Master-${id}`,
    masterType: 70,
    group: 6,
    hitPoints: 40,
    los: 5,
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
    enabled: true,
    costs: [],
    trainTime: 25,
    trainLocationId: BARRACKS,
    combat: {
      range: 0.5,
      minRange: 0,
      baseArmour: 0,
      attacks: [{ group: 4, amount: 3 }],
    },
    ...overrides,
  };
}

function makeMilitaryUnit(overrides: Partial<ObservedOwnUnit> & { id: number }): ObservedOwnUnit {
  return {
    type: CLUBMAN,
    x: 10.5,
    y: 10.5,
    hp: 40,
    maxHp: 40,
    state: ObjectState.Active,
    heldType: -1,
    heldAmount: 0,
    isVillager: false,
    isMilitary: true,
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

function makeVillagerUnit(overrides: Partial<ObservedOwnUnit> & { id: number }): ObservedOwnUnit {
  return {
    type: VILLAGER,
    x: 9.5,
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

function makeWarshipUnit(overrides: Partial<ObservedOwnUnit> & { id: number }): ObservedOwnUnit {
  return {
    type: WAR_BOAT,
    x: 22.5,
    y: 10.5,
    hp: 120,
    maxHp: 120,
    state: ObjectState.Active,
    heldType: -1,
    heldAmount: 0,
    isVillager: false,
    isMilitary: true,
    isNaval: true,
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

function makeEnemy(overrides: Partial<ObservedEnemy> & { id: number }): ObservedEnemy {
  return {
    owner: 1,
    type: CLUBMAN,
    x: 40.5,
    y: 40.5,
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
    ...overrides,
  };
}

function makeObservation(overrides: Partial<BotObservation> = {}): BotObservation {
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
    population: { current: 5, limit: 12, headroom: 7 },
    ownUnits: [],
    ownBuildings: [makeBuilding({ id: 100 })],
    knownEnemies: [],
    knownResources: [],
    techStates: new Array<number>(130).fill(1),
    enabledMasters: {
      [CLUBMAN]: makeMaster(CLUBMAN),
      [BOWMAN]: makeMaster(BOWMAN, {
        combat: { range: 5, minRange: 0, baseArmour: 0, attacks: [{ group: 3, amount: 3 }] },
      }),
      [SCOUT]: makeMaster(SCOUT, { hitPoints: 60, speed: 2.0 }),
      [WAR_BOAT]: makeMaster(WAR_BOAT, {
        group: 22,
        hitPoints: 120,
        terrainRestriction: 3,
        combat: { range: 5, minRange: 0, baseArmour: 0, attacks: [{ group: 3, amount: 5 }] },
      }),
      [FISHING_BOAT]: makeMaster(FISHING_BOAT, {
        group: 21,
        unitLevel: 9,
        terrainRestriction: 3,
        combat: null,
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

function makePlannerState(overrides: Partial<BotPlannerState> = {}): BotPlannerState {
  return {
    lastThinkTime: -1,
    squads: [],
    nextSquadSeq: 1,
    depletedResourceIds: [],
    failedTargets: {},
    unitCooldownUntil: {},
    buildingCooldownUntil: {},
    memory: createEmptyBotMemory(),
    ...overrides,
  };
}

describe('T06 M01 — Bounded command churn, stuck handling, and two-phase propose/commit (B05)', () => {
  test('does not re-issue identical attack commands across multiple think ticks while target stays valid', () => {
    const planner = createSquadPlanner();
    const profile = getBotProfile('medium'); // minAttackSquadSize = 4
    const arbiterState = createArbiterState();
    const state = makePlannerState();

    const units = [
      makeMilitaryUnit({ id: 1, x: 11, y: 11 }),
      makeMilitaryUnit({ id: 2, x: 12, y: 11 }),
      makeMilitaryUnit({ id: 3, x: 11, y: 12 }),
      makeMilitaryUnit({ id: 4, x: 12, y: 12 }),
    ];
    const enemy = makeEnemy({ id: 901, type: TOWN_CENTER, x: 40.5, y: 40.5, hp: 600, maxHp: 600, isBuilding: true, isStatic: true, isMilitary: false, reachRange: 3 });

    const attackCommandsIssued: number[] = [];

    // Tick 0: squad rallies or attacks; advance turns through CTI=2 and beyond
    for (let turn = 0; turn <= 16; turn += 2) {
      const engaged = turn >= 4; // After CTI=2 applies, units are actively engaged/moving toward enemy
      const tickUnits = units.map((u) => ({
        ...u,
        isActivelyEngaged: engaged,
        attackTarget: engaged ? enemy.id : null,
      }));
      const obs = makeObservation({
        turn,
        worldTime: turn * 1000,
        ownUnits: tickUnits,
        knownEnemies: [enemy],
      });
      const res = runProposeCommitCycle([planner], obs, profile, arbiterState, state, 42);
      const attacks = res.commands.filter((c) => c.type === 'attack');
      attackCommandsIssued.push(attacks.length);
    }

    const totalAttacks = attackCommandsIssued.reduce((a, b) => a + b, 0);
    expect(totalAttacks).toBe(1);
    expect(state.squads.length).toBeGreaterThanOrEqual(1);
    expect(state.squads.some((s) => s.phase === 'attacking' && s.targetId === enemy.id)).toBe(true);
  });

  test('re-targets cleanly when current target dies, and backs off/reissues on stuck timeout', () => {
    const planner = new SquadPlanner();
    const profile = getBotProfile('medium');
    const arbiterState = createArbiterState();
    const state = makePlannerState();

    const units = [
      makeMilitaryUnit({ id: 1, x: 11, y: 11 }),
      makeMilitaryUnit({ id: 2, x: 12, y: 11 }),
      makeMilitaryUnit({ id: 3, x: 11, y: 12 }),
      makeMilitaryUnit({ id: 4, x: 12, y: 12 }),
    ];
    const enemyA = makeEnemy({ id: 901, x: 30.5, y: 30.5 });
    const enemyB = makeEnemy({ id: 902, x: 35.5, y: 35.5 });

    // Turn 0: acquire enemyA
    const obs0 = makeObservation({
      turn: 0,
      worldTime: 0,
      ownUnits: units,
      knownEnemies: [enemyA, enemyB],
    });
    const res0 = runProposeCommitCycle([planner], obs0, profile, arbiterState, state, 1);
    expect(res0.commands.some((c) => c.type === 'attack' && c.target === enemyA.id)).toBe(true);
    const attackingSquad = state.squads.find((s) => s.targetId === enemyA.id)!;
    const initialOrderTurn = attackingSquad.lastOrderTurn;

    // Turn 4..14: units are idle (stuck, not moving and not engaged) while dynamic path to enemyA is blocked
    let blockedTicks = 0;
    for (let turn = 4; turn <= 16; turn += 2) {
      const obsStuck = makeObservation({
        turn,
        worldTime: turn * 1000,
        ownUnits: units, // neither moving nor engaged
        knownEnemies: [enemyA, enemyB],
        canReach: (_actorId, tx, ty, _range, checkDynamic) => {
          if (checkDynamic && Math.abs(tx - enemyA.x) < 1 && Math.abs(ty - enemyA.y) < 1) {
            return false; // enemyA dynamically walled off
          }
          return true;
        },
      });
      const res = runProposeCommitCycle([planner], obsStuck, profile, arbiterState, state, 1);
      if (res.commands.some((c) => c.type === 'attack' && c.target === enemyB.id)) {
        blockedTicks++;
      }
    }
    expect(blockedTicks).toBeGreaterThanOrEqual(1);
    expect(state.failedTargets[enemyA.id]?.retryAfterTurn).toBeGreaterThan(10);

    // Verify new target enemyB was adopted and lastOrderTurn advanced
    const updatedSquad = state.squads.find((s) => s.targetId === enemyB.id);
    expect(updatedSquad).toBeDefined();
    expect(updatedSquad!.lastOrderTurn).toBeGreaterThan(initialOrderTurn);

    // Now enemyB dies -> squad drops enemyB and does not hold stale targetId
    const obsAfterDeath = makeObservation({
      turn: 20,
      worldTime: 20_000,
      ownUnits: units,
      knownEnemies: [],
    });
    runProposeCommitCycle([planner], obsAfterDeath, profile, arbiterState, state, 1);
    expect(state.squads.some((s) => s.targetId === enemyB.id)).toBe(false);
  });

  test('B05: propose does not mutate state, and rejected attack/move commits NO phase/cooldown change', () => {
    const planner = createSquadPlanner();
    const profile = getBotProfile('medium');
    const state = makePlannerState({
      squads: [
        {
          id: 1,
          role: 'assault',
          phase: 'rallying',
          memberIds: [1, 2, 3, 4],
          targetId: null,
          targetPos: { x: 11.5, y: 11.5 },
          lastOrderTurn: 0,
          lastOrderTime: 0,
          stuckSinceTurn: null,
        },
      ],
      nextSquadSeq: 2,
    });

    const units = [
      makeMilitaryUnit({ id: 1, x: 11, y: 11 }),
      makeMilitaryUnit({ id: 2, x: 12, y: 11 }),
      makeMilitaryUnit({ id: 3, x: 11, y: 12 }),
      makeMilitaryUnit({ id: 4, x: 12, y: 12 }),
    ];
    const enemy = makeEnemy({ id: 950, x: 40.5, y: 40.5 });

    const obs = makeObservation({
      turn: 6,
      worldTime: 6000,
      ownUnits: units,
      knownEnemies: [enemy],
    });

    const arbiterZero = createArbiterState();
    const input = createPlannerInput(obs, profile, arbiterZero, state, 7);
    const snapshotBefore = JSON.stringify(state);

    const proposed = planner.propose(input);
    expect(proposed.some((i) => i.command.type === 'attack')).toBe(true);
    // propose MUST NOT mutate command-dependent state
    expect(JSON.stringify(state)).toBe(snapshotBefore);

    // Arbitrate with maxCommands = 0 -> batch-limit-exceeded rejection
    const rejectedRes = arbitrateIntents(proposed, obs, arbiterZero, 0);
    expect(rejectedRes.accepted).toHaveLength(0);
    expect(rejectedRes.rejected.length).toBeGreaterThan(0);

    planner.commit(rejectedRes.outcomesByKey, createPlannerInput(obs, profile, arbiterZero, state, 7));

    // Squad must stay rallying, NOT attacking, with unchanged lastOrderTurn & no cooldowns!
    expect(state.squads[0]!.phase).toBe('rallying');
    expect(state.squads[0]!.targetId).toBeNull();
    expect(state.squads[0]!.lastOrderTurn).toBe(0);
    expect(Object.keys(state.unitCooldownUntil)).toHaveLength(0);

    // Next tick: retry accepted -> commits attacking exactly once
    const obsRetry = makeObservation({
      turn: 8,
      worldTime: 8000,
      ownUnits: units,
      knownEnemies: [enemy],
    });
    const acceptedRes = runProposeCommitCycle([planner], obsRetry, profile, arbiterZero, state, 7);
    expect(acceptedRes.accepted.some((i) => i.command.type === 'attack' && i.command.target === enemy.id)).toBe(true);
    expect(state.squads[0]!.phase).toBe('attacking');
    expect(state.squads[0]!.targetId).toBe(enemy.id);
    expect(state.squads[0]!.lastOrderTurn).toBe(8);
    expect(state.unitCooldownUntil[1]).toBeGreaterThan(8);
  });

  test('D01: deterministic decisions across identical inputs without Date or Math.random', () => {
    const dateSpy = vi.spyOn(Date, 'now').mockImplementation(() => {
      throw new Error('Date.now forbidden');
    });
    const randSpy = vi.spyOn(Math, 'random').mockImplementation(() => {
      throw new Error('Math.random forbidden');
    });

    try {
      const runOnce = () => {
        const planner = createSquadPlanner();
        const profile = getBotProfile('hard');
        const arbiter = createArbiterState();
        const state = makePlannerState();
        const obs = makeObservation({
          turn: 4,
          worldTime: 4000,
          ownUnits: [
            makeMilitaryUnit({ id: 1, x: 11, y: 11 }),
            makeMilitaryUnit({ id: 2, x: 12, y: 11 }),
            makeMilitaryUnit({ id: 3, x: 11, y: 12 }),
          ],
          knownEnemies: [makeEnemy({ id: 500, x: 30, y: 30 })],
        });
        const res = runProposeCommitCycle([planner], obs, profile, arbiter, state, 12345);
        return { commands: res.commands, state };
      };

      expect(runOnce()).toEqual(runOnce());
    } finally {
      dateSpy.mockRestore();
      randSpy.mockRestore();
    }
  });
});

describe('T06 M02 — Unique membership, dead/converted pruning, and reinforcements', () => {
  test('enforces strictly unique membership and prunes dead, converted, and garrisoned units', () => {
    const planner = createSquadPlanner();
    const profile = getBotProfile('hard');
    const arbiter = createArbiterState();

    // Pre-seeded dirty state where unit 2 appears in two squads and unit 3 is dead/missing
    const state = makePlannerState({
      squads: [
        {
          id: 1,
          role: 'assault',
          phase: 'attacking',
          memberIds: [1, 2, 3, 99], // 99 missing (converted/killed), 3 dead
          targetId: 700,
          targetPos: { x: 40, y: 40 },
          lastOrderTurn: 2,
          lastOrderTime: 2000,
          stuckSinceTurn: null,
        },
        {
          id: 2,
          role: 'raider',
          phase: 'forming',
          memberIds: [2, 4, 5], // 2 duplicated, 5 inside transport
          targetId: null,
          targetPos: null,
          lastOrderTurn: 2,
          lastOrderTime: 2000,
          stuckSinceTurn: null,
        },
      ],
      nextSquadSeq: 3,
    });

    const obs = makeObservation({
      turn: 6,
      worldTime: 6000,
      ownUnits: [
        makeMilitaryUnit({ id: 1, isActivelyEngaged: true, attackTarget: 700 }),
        makeMilitaryUnit({ id: 2, isActivelyEngaged: true, attackTarget: 700 }),
        makeMilitaryUnit({ id: 3, hp: 0, state: ObjectState.Dead }),
        makeMilitaryUnit({ id: 4, x: 13, y: 13 }),
        makeMilitaryUnit({ id: 5, inside: 888 }),
        makeVillagerUnit({ id: 6 }),
      ],
      knownEnemies: [makeEnemy({ id: 700, x: 40, y: 40 })],
    });

    runProposeCommitCycle([planner], obs, profile, arbiter, state, 99);

    const seen = new Set<number>();
    for (const s of state.squads) {
      for (const uid of s.memberIds) {
        expect(seen.has(uid)).toBe(false);
        seen.add(uid);
      }
    }
    expect(seen.has(3)).toBe(false);
    expect(seen.has(99)).toBe(false);
    expect(seen.has(5)).toBe(false);
    expect(seen.has(6)).toBe(false);
    expect(seen.has(1)).toBe(true);
    expect(seen.has(2)).toBe(true);
    expect(seen.has(4)).toBe(true);
  });

  test('newly trained reinforcements do NOT pull an already-attacking squad back to rally', () => {
    const planner = createSquadPlanner();
    const profile = getBotProfile('medium'); // minAttackSquadSize = 4
    const arbiter = createArbiterState();
    const state = makePlannerState({
      squads: [
        {
          id: 1,
          role: 'assault',
          phase: 'attacking',
          memberIds: [1, 2, 3, 4],
          targetId: 700,
          targetPos: { x: 45, y: 45 },
          lastOrderTurn: 4,
          lastOrderTime: 4000,
          stuckSinceTurn: null,
        },
      ],
      nextSquadSeq: 2,
    });

    const enemy = makeEnemy({ id: 700, type: TOWN_CENTER, x: 45, y: 45, isBuilding: true, isStatic: true, isMilitary: false, reachRange: 3 });

    // Units 1..4 are at the enemy base actively attacking; new units 5 and 6 just spawned at home (12, 12)
    const obs = makeObservation({
      turn: 8,
      worldTime: 8000,
      ownUnits: [
        makeMilitaryUnit({ id: 1, x: 42, y: 44, isActivelyEngaged: true, attackTarget: 700 }),
        makeMilitaryUnit({ id: 2, x: 43, y: 44, isActivelyEngaged: true, attackTarget: 700 }),
        makeMilitaryUnit({ id: 3, x: 42, y: 45, isActivelyEngaged: true, attackTarget: 700 }),
        makeMilitaryUnit({ id: 4, x: 43, y: 45, isActivelyEngaged: true, attackTarget: 700 }),
        makeMilitaryUnit({ id: 5, x: 12, y: 12 }),
        makeMilitaryUnit({ id: 6, x: 13, y: 12 }),
      ],
      knownEnemies: [enemy],
    });

    const res = runProposeCommitCycle([planner], obs, profile, arbiter, state, 10);

    const originalSquad = state.squads.find((s) => s.id === 1)!;
    expect(originalSquad.phase).toBe('attacking');
    expect(originalSquad.targetId).toBe(700);

    // None of units 1..4 were ordered to move back to home rally!
    for (const cmd of res.commands) {
      if (cmd.type === 'move') {
        for (const uid of [1, 2, 3, 4]) {
          expect(cmd.units).not.toContain(uid);
        }
      }
      if (cmd.type === 'attack') {
        for (const uid of [1, 2, 3, 4]) {
          expect(cmd.units).not.toContain(uid);
        }
      }
    }
  });
});

describe('T06 M03 — Defense preemption, retreat, and recover without ping-pong or fog leak', () => {
  test('base/villager defense preempts attack by priority while keeping valid engaged defenders undisturbed', () => {
    const planner = createSquadPlanner();
    const profile = getBotProfile('medium');
    const arbiter = createArbiterState();
    const state = makePlannerState({
      squads: [
        {
          id: 1,
          role: 'assault',
          phase: 'rallying',
          memberIds: [1, 2, 3, 4],
          targetId: null,
          targetPos: { x: 12, y: 12 },
          lastOrderTurn: 2,
          lastOrderTime: 2000,
          stuckSinceTurn: null,
        },
      ],
      nextSquadSeq: 2,
    });

    const raiderAtVillager = makeEnemy({ id: 801, x: 14, y: 11, visibleNow: true });
    const farEnemyTC = makeEnemy({
      id: 802,
      type: TOWN_CENTER,
      x: 52,
      y: 52,
      isBuilding: true,
      isStatic: true,
      isMilitary: false,
      reachRange: 3,
      visibleNow: false,
    });

    const obs0 = makeObservation({
      turn: 6,
      worldTime: 6000,
      ownBuildings: [makeBuilding({ id: 100, x: 10.5, y: 10.5 })],
      ownUnits: [
        makeVillagerUnit({ id: 10, x: 12.5, y: 11.0 }),
        makeMilitaryUnit({ id: 1, x: 11, y: 11 }),
        makeMilitaryUnit({ id: 2, x: 12, y: 11 }),
        makeMilitaryUnit({ id: 3, x: 11, y: 12 }),
        makeMilitaryUnit({ id: 4, x: 12, y: 12 }),
      ],
      knownEnemies: [raiderAtVillager, farEnemyTC],
    });

    const input0 = createPlannerInput(obs0, profile, arbiter, state, 5);
    const intents0 = planner.propose(input0);
    const defIntent = intents0.find((i) => i.command.type === 'attack' && i.command.target === raiderAtVillager.id);
    expect(defIntent).toBeDefined();
    expect(defIntent!.priority).toBeGreaterThanOrEqual(90);

    const res0 = runProposeCommitCycle([planner], obs0, profile, arbiter, state, 5);
    expect(res0.commands.some((c) => c.type === 'attack' && c.target === raiderAtVillager.id)).toBe(true);
    expect(state.squads.some((s) => s.role === 'defense' && s.targetId === raiderAtVillager.id)).toBe(true);

    // Subsequent tick: units 1..4 are actively engaged on raiderAtVillager, another enemy 803 walks into edge of base ->
    // engaged defenders MUST NOT be interrupted every tick!
    const raider2 = makeEnemy({ id: 803, x: 20, y: 11, visibleNow: true });
    const obs1 = makeObservation({
      turn: 10,
      worldTime: 10_000,
      ownBuildings: [makeBuilding({ id: 100, x: 10.5, y: 10.5 })],
      ownUnits: [
        makeVillagerUnit({ id: 10, x: 12.5, y: 11.0 }),
        makeMilitaryUnit({ id: 1, x: 13.5, y: 11, isActivelyEngaged: true, attackTarget: raiderAtVillager.id }),
        makeMilitaryUnit({ id: 2, x: 13.5, y: 11.5, isActivelyEngaged: true, attackTarget: raiderAtVillager.id }),
        makeMilitaryUnit({ id: 3, x: 14, y: 10.5, isActivelyEngaged: true, attackTarget: raiderAtVillager.id }),
        makeMilitaryUnit({ id: 4, x: 14, y: 11.5, isActivelyEngaged: true, attackTarget: raiderAtVillager.id }),
      ],
      knownEnemies: [raiderAtVillager, raider2, farEnemyTC],
    });

    const res1 = runProposeCommitCycle([planner], obs1, profile, arbiter, state, 5);
    const interruptCmds = res1.commands.filter((c) => c.type === 'attack' && c.target === raider2.id);
    expect(interruptCmds).toHaveLength(0);
  });

  test('retreats wounded attacking squad to safe home anchor -> recovers -> no ping-pong across 30 ticks', () => {
    const planner = createSquadPlanner();
    const profile = getBotProfile('medium'); // retreatHpRatio = 0.2
    const arbiter = createArbiterState();
    const state = makePlannerState({
      squads: [
        {
          id: 1,
          role: 'assault',
          phase: 'attacking',
          memberIds: [1, 2, 3, 4],
          targetId: 900,
          targetPos: { x: 45, y: 45 },
          lastOrderTurn: 2,
          lastOrderTime: 2000,
          stuckSinceTurn: null,
        },
      ],
      nextSquadSeq: 2,
    });

    const enemy = makeEnemy({ id: 900, x: 45, y: 45, visibleNow: true });
    const tc = makeBuilding({ id: 100, x: 10.5, y: 10.5 });

    // Turn 8: squad took heavy damage (6/40 HP = 15% <= 20% retreatHpRatio) while far away at (42, 42)
    const woundedFarUnits = [
      makeMilitaryUnit({ id: 1, x: 42, y: 42, hp: 6, maxHp: 40, isActivelyEngaged: true, attackTarget: 900 }),
      makeMilitaryUnit({ id: 2, x: 43, y: 42, hp: 6, maxHp: 40, isActivelyEngaged: true, attackTarget: 900 }),
      makeMilitaryUnit({ id: 3, x: 42, y: 43, hp: 6, maxHp: 40, isActivelyEngaged: true, attackTarget: 900 }),
      makeMilitaryUnit({ id: 4, x: 43, y: 43, hp: 6, maxHp: 40, isActivelyEngaged: true, attackTarget: 900 }),
    ];

    const obsRetreat = makeObservation({
      turn: 8,
      worldTime: 8000,
      ownBuildings: [tc],
      ownUnits: woundedFarUnits,
      knownEnemies: [enemy],
    });
    const resRetreat = runProposeCommitCycle([planner], obsRetreat, profile, arbiter, state, 11);
    const retreatMove = resRetreat.commands.find((c) => c.type === 'move');
    expect(retreatMove).toBeDefined();
    if (retreatMove && retreatMove.type === 'move') {
      // Must retreat toward safe base TC (10.5, 10.5), not into enemy at (45, 45)
      expect(Math.hypot(retreatMove.x - tc.x, retreatMove.y - tc.y)).toBeLessThan(8);
    }
    expect(state.squads[0]!.phase).toBe('retreating');

    // Turn 12: still moving back home -> remains retreating
    const obsMovingHome = makeObservation({
      turn: 12,
      worldTime: 12_000,
      ownBuildings: [tc],
      ownUnits: woundedFarUnits.map((u) => ({ ...u, x: 25, y: 25, isMoving: true, isActivelyEngaged: false, attackTarget: null })),
      knownEnemies: [enemy],
    });
    runProposeCommitCycle([planner], obsMovingHome, profile, arbiter, state, 11);
    expect(state.squads[0]!.phase).toBe('retreating');

    // Turn 16: arrived at home TC -> transitions to recovering (NEVER directly back to attacking!)
    const obsHome = makeObservation({
      turn: 16,
      worldTime: 16_000,
      ownBuildings: [tc],
      ownUnits: woundedFarUnits.map((u, idx) => ({ ...u, x: 11 + idx * 0.5, y: 11, isMoving: false, isActivelyEngaged: false, attackTarget: null })),
      knownEnemies: [enemy],
    });
    runProposeCommitCycle([planner], obsHome, profile, arbiter, state, 11);
    expect(state.squads[0]!.phase).toBe('recovering');

    // Turns 18..36 while STILL wounded at 15% HP: must NOT ping-pong back to attacking!
    const phaseHistory: SquadState['phase'][] = [];
    for (let turn = 18; turn <= 36; turn += 2) {
      const obsRecover = makeObservation({
        turn,
        worldTime: turn * 1000,
        ownBuildings: [tc],
        ownUnits: woundedFarUnits.map((u, idx) => ({ ...u, x: 11 + idx * 0.5, y: 11, isMoving: false, isActivelyEngaged: false, attackTarget: null })),
        knownEnemies: [enemy],
      });
      const res = runProposeCommitCycle([planner], obsRecover, profile, arbiter, state, 11);
      phaseHistory.push(state.squads[0]!.phase);
      expect(res.commands.filter((c) => c.type === 'attack')).toHaveLength(0);
    }
    expect(phaseHistory.every((p) => p === 'recovering')).toBe(true);

    // Now Priest heals units back to 38/40 HP (95%) -> squad recovers cleanly to forming/rallying/attacking
    const healedUnits = woundedFarUnits.map((u, idx) => ({
      ...u,
      x: 11 + idx * 0.5,
      y: 11,
      hp: 38,
      isMoving: false,
      isActivelyEngaged: false,
      attackTarget: null,
    }));
    const obsHealed = makeObservation({
      turn: 38,
      worldTime: 38_000,
      ownBuildings: [tc],
      ownUnits: healedUnits,
      knownEnemies: [enemy],
    });
    runProposeCommitCycle([planner], obsHealed, profile, arbiter, state, 11);
    expect(['forming', 'rallying', 'attacking']).toContain(state.squads[0]!.phase);
  });
});

describe('T06 M04 — Passability grouping, unreachable islands, and fog-safe scouting fallback', () => {
  test('separates naval warships from land squads and isolates land units on disconnected islands', () => {
    const planner = createSquadPlanner();
    const profile = getBotProfile('medium');
    const arbiter = createArbiterState();
    const state = makePlannerState();

    const westLand1 = makeMilitaryUnit({ id: 1, x: 8, y: 10 });
    const westLand2 = makeMilitaryUnit({ id: 2, x: 9, y: 10 });
    const eastLand1 = makeMilitaryUnit({ id: 3, x: 38, y: 10 });
    const ship1 = makeWarshipUnit({ id: 4, x: 22, y: 10 });
    const ship2 = makeWarshipUnit({ id: 5, x: 22, y: 12 });

    const obs = makeObservation({
      turn: 0,
      worldTime: 0,
      ownUnits: [westLand1, westLand2, eastLand1, ship1, ship2],
      knownEnemies: [],
      canReach: (actorId, tx) => {
        if (actorId === 1 || actorId === 2) return tx < 20;
        if (actorId === 3) return tx >= 25;
        if (actorId === 4 || actorId === 5) return tx >= 20 && tx <= 24;
        return false;
      },
      findNearestExploreTarget: (actorId) => {
        if (actorId === 1 || actorId === 2) return { x: 15.5, y: 15.5 };
        if (actorId === 3) return { x: 40.5, y: 15.5 };
        if (actorId === 4 || actorId === 5) return { x: 22.5, y: 25.5 };
        return null;
      },
    });

    runProposeCommitCycle([planner], obs, profile, arbiter, state, 13);

    const navalSquads = state.squads.filter((s) => s.role === 'naval');
    const landSquads = state.squads.filter((s) => s.role !== 'naval');

    expect(navalSquads.length).toBeGreaterThanOrEqual(1);
    for (const ns of navalSquads) {
      for (const uid of ns.memberIds) {
        expect([4, 5]).toContain(uid);
      }
    }
    for (const ls of landSquads) {
      for (const uid of ls.memberIds) {
        expect([1, 2, 3]).toContain(uid);
      }
      // West land units and East island unit must NEVER share a squad
      const hasWest = ls.memberIds.some((id) => id === 1 || id === 2);
      const hasEast = ls.memberIds.includes(3);
      expect(hasWest && hasEast).toBe(false);
    }
  });

  test('never spams attack against unreachable island enemies and falls back to scouting/idle without fog leak', () => {
    const planner = createSquadPlanner();
    const profile = getBotProfile('medium');
    const arbiter = createArbiterState();
    const state = makePlannerState();

    const landUnits = [
      makeMilitaryUnit({ id: 1, x: 10, y: 10 }),
      makeMilitaryUnit({ id: 2, x: 11, y: 10 }),
      makeMilitaryUnit({ id: 3, x: 10, y: 11 }),
      makeMilitaryUnit({ id: 4, x: 11, y: 11 }),
    ];
    // Known enemy strictly on isolated east island (x = 40)
    const islandEnemy = makeEnemy({ id: 999, x: 40.5, y: 40.5, visibleNow: true });

    let attackCount = 0;
    let moveCount = 0;
    for (let turn = 0; turn <= 12; turn += 2) {
      const obs = makeObservation({
        turn,
        worldTime: turn * 1000,
        ownUnits: landUnits.map((u) => ({ ...u, isMoving: turn > 0 && turn < 6 })),
        knownEnemies: [islandEnemy],
        canReach: (_actorId, tx) => tx < 20, // x >= 20 unreachable!
        findNearestExploreTarget: () => (turn < 6 ? { x: 15.5, y: 15.5 } : null),
      });
      const res = runProposeCommitCycle([planner], obs, profile, arbiter, state, 21);
      attackCount += res.commands.filter((c) => c.type === 'attack').length;
      moveCount += res.commands.filter((c) => c.type === 'move').length;
    }

    expect(attackCount).toBe(0);
    // Bounded scouting move fallback when unexplored reachable tiles exist, not infinite spam
    expect(moveCount).toBeGreaterThanOrEqual(1);
    expect(moveCount).toBeLessThanOrEqual(3);
  });

  test('drops vanished fogged mobile enemy target without peeking World', () => {
    const planner = createSquadPlanner();
    const profile = getBotProfile('medium');
    const arbiter = createArbiterState();
    const state = makePlannerState({
      squads: [
        {
          id: 1,
          role: 'assault',
          phase: 'attacking',
          memberIds: [1, 2, 3, 4],
          targetId: 777,
          targetPos: { x: 35.5, y: 35.5 },
          lastOrderTurn: 2,
          lastOrderTime: 2000,
          stuckSinceTurn: null,
        },
      ],
      nextSquadSeq: 2,
    });

    const units = [
      makeMilitaryUnit({ id: 1, x: 34.5, y: 35.5 }),
      makeMilitaryUnit({ id: 2, x: 35.0, y: 35.0 }),
      makeMilitaryUnit({ id: 3, x: 35.5, y: 34.5 }),
      makeMilitaryUnit({ id: 4, x: 34.0, y: 34.5 }),
    ];

    // Mobile enemy 777 stepped into fog/died -> absent from observation.knownEnemies, while tile (35,35) IS visible
    const obs = makeObservation({
      turn: 8,
      worldTime: 8000,
      ownUnits: units,
      knownEnemies: [],
      isTileVisible: () => true,
      findNearestExploreTarget: () => null,
    });

    const res = runProposeCommitCycle([planner], obs, profile, arbiter, state, 31);
    expect(res.commands.some((c) => c.type === 'attack' && c.target === 777)).toBe(false);
    expect(state.squads[0]!.targetId).toBeNull();
    expect(state.squads[0]!.phase).not.toBe('attacking');
  });

  test('naval warships target coastal enemies within weapon range while skipping unreachable deep inland enemies', () => {
    const planner = createSquadPlanner();
    const profile = getBotProfile('medium');
    const arbiter = createArbiterState();
    const state = makePlannerState();

    const ships = [
      makeWarshipUnit({ id: 1, x: 22.5, y: 10.5 }),
      makeWarshipUnit({ id: 2, x: 22.5, y: 11.5 }),
    ];
    // Coastal enemy within warship range 5 (e.g. at x=19, dist 3.5 <= 5), vs deep inland enemy at x=5 (unreachable)
    const coastalEnemy = makeEnemy({ id: 601, x: 19.0, y: 11.0, visibleNow: true });
    const inlandEnemy = makeEnemy({ id: 602, x: 5.0, y: 11.0, visibleNow: true });

    const obs = makeObservation({
      turn: 0,
      worldTime: 0,
      ownUnits: ships,
      knownEnemies: [inlandEnemy, coastalEnemy],
      canReach: (_actorId, tx, _ty, range = 0) => tx >= 20 - range && tx <= 24 + range,
    });

    const res = runProposeCommitCycle([planner], obs, profile, arbiter, state, 44);
    expect(res.commands).toHaveLength(1);
    expect(res.commands[0]).toMatchObject({ type: 'attack', target: coastalEnemy.id });
    expect(state.squads[0]!.role).toBe('naval');
    expect(state.squads[0]!.phase).toBe('attacking');
  });
});

describe('T06 Profile differentiation & defense B05 rejection safety', () => {
  test('respects profile minAttackSquadSize across easy (6) vs hard (3) on identical observation', () => {
    const units = [
      makeMilitaryUnit({ id: 1, x: 11, y: 11 }),
      makeMilitaryUnit({ id: 2, x: 12, y: 11 }),
      makeMilitaryUnit({ id: 3, x: 11, y: 12 }),
    ];
    const enemy = makeEnemy({ id: 901, x: 40, y: 40, visibleNow: true });
    const obs = makeObservation({ turn: 0, worldTime: 0, ownUnits: units, knownEnemies: [enemy] });

    const hardRes = runProposeCommitCycle(
      [createSquadPlanner()],
      obs,
      getBotProfile('hard'),
      createArbiterState(),
      makePlannerState(),
      1,
    );
    const easyRes = runProposeCommitCycle(
      [createSquadPlanner()],
      obs,
      getBotProfile('easy'),
      createArbiterState(),
      makePlannerState(),
      1,
    );

    expect(hardRes.commands.some((c) => c.type === 'attack')).toBe(true);
    expect(easyRes.commands.some((c) => c.type === 'attack')).toBe(false);
  });

  test('rejected defense preemption intent does not mutate squad role or phase', () => {
    const planner = createSquadPlanner();
    const profile = getBotProfile('medium');
    const arbiter = createArbiterState();
    const state = makePlannerState({
      squads: [
        {
          id: 1,
          role: 'assault',
          phase: 'rallying',
          memberIds: [1, 2, 3, 4],
          targetId: null,
          targetPos: { x: 12, y: 12 },
          lastOrderTurn: 0,
          lastOrderTime: 0,
          stuckSinceTurn: null,
        },
      ],
      nextSquadSeq: 2,
    });

    const obs = makeObservation({
      turn: 4,
      worldTime: 4000,
      ownUnits: [
        makeMilitaryUnit({ id: 1, x: 11, y: 11 }),
        makeMilitaryUnit({ id: 2, x: 12, y: 11 }),
        makeMilitaryUnit({ id: 3, x: 11, y: 12 }),
        makeMilitaryUnit({ id: 4, x: 12, y: 12 }),
      ],
      knownEnemies: [makeEnemy({ id: 888, x: 14, y: 11, visibleNow: true })],
    });

    const input = createPlannerInput(obs, profile, arbiter, state, 5);
    const proposed = planner.propose(input);
    const rejected = arbitrateIntents(proposed, obs, arbiter, 0);
    planner.commit(rejected.outcomesByKey, createPlannerInput(obs, profile, arbiter, state, 5));

    expect(state.squads[0]!.role).toBe('assault');
    expect(state.squads[0]!.phase).toBe('rallying');
    expect(state.squads[0]!.targetId).toBeNull();
  });
});

describe('T06 Integration — Real @aoe/sim World with COMMAND_DELAY_TURNS=2', () => {
  test('drives squad lifecycle, CTI=2 arbiter, island exclusion, reinforcement, and bounded command churn in real World', () => {
    const size = 48;
    const map = new TileMap(size, size);
    for (let x = 0; x < size; x++) {
      for (let y = 0; y < size; y++) {
        // Water channel x = 28..32 splits mainland (0..27) from east island (33..47)
        map.setTile(x, y, x >= 28 && x <= 32 ? TERRAIN_WATER : TERRAIN_GRASS);
      }
    }

    const startUnits: StartUnit[] = [
      // Bot (player 2) base & 4 Clubmen on mainland
      { owner: 2, type: TOWN_CENTER, x: 8.5, y: 10.5 },
      { owner: 2, type: HOUSE, x: 5.5, y: 10.5 },
      { owner: 2, type: BARRACKS, x: 11.5, y: 10.5 },
      { owner: 2, type: CLUBMAN, x: 13.5, y: 10.5 },
      { owner: 2, type: CLUBMAN, x: 14.5, y: 10.5 },
      { owner: 2, type: CLUBMAN, x: 13.5, y: 11.5 },
      { owner: 2, type: CLUBMAN, x: 14.5, y: 11.5 },
      // Reachable enemy Clubman & Barracks on mainland (initially in TILE_BLACK at y=24)
      { owner: 1, type: CLUBMAN, x: 14.5, y: 24.5 },
      { owner: 1, type: BARRACKS, x: 18.5, y: 26.5 },
      // Unreachable enemy on isolated east island
      { owner: 1, type: CLUBMAN, x: 40.5, y: 12.5 },
    ];

    const world = new World({ players: 3, map, units: startUnits, victory: { type: VICTORY_SPECIAL } });
    // Reveal isolated island enemy (still unreachable by land!) and keep mainland enemy at y=24 in TILE_BLACK initially
    world.visibility.exploreRect(2, 38, 10, 43, 15);
    expect(world.tileVisibility(2, 14, 24)).toBe(TILE_BLACK);

    const planner = createSquadPlanner();
    const profile = getBotProfile('medium');
    const arbiterState = createArbiterState();
    const plannerState = makePlannerState();
    let memory = createEmptyBotMemory();

    const issuedCommands: ReturnType<typeof arbitrateIntents>['commands'] = [];
    const islandEnemy = [...world.entities.ofPlayer(1)].find((e) => e.x > 35)!;
    const mainlandEnemyClubman = [...world.entities.ofPlayer(1)].find((e) => e.type === CLUBMAN && e.x < 25)!;

    // Phase 1: First 6 turns — mainland enemy is still in TILE_BLACK; must NOT attack islandEnemy or hidden enemy
    for (let i = 0; i < 6; i++) {
      if (i % 2 === 0) {
        const { observation, memory: nextMem } = createBotObservation(world, 2, memory);
        memory = nextMem;
        const res = runProposeCommitCycle([planner], observation, profile, arbiterState, plannerState, 77);
        if (res.commands.length > 0) {
          issuedCommands.push(...res.commands);
          world.addBatch(world.turn, 2, res.commands);
        }
      }
      world.runTurn();
    }

    expect(issuedCommands.some((c) => c.type === 'attack' && c.target === islandEnemy.id)).toBe(false);
    expect(issuedCommands.some((c) => c.type === 'attack' && c.target === mainlandEnemyClubman.id)).toBe(false);

    // Phase 2: Scout/visibility reveals mainland enemies -> squad engages & fights through COMMAND_DELAY_TURNS=2
    world.visibility.exploreRect(2, 12, 21, 21, 29);

    // Also train a 5th Clubman at Barracks partway through to verify reinforcement without resetting attacking squad
    const barracks = [...world.entities.ofPlayer(2)].find((e) => e.type === BARRACKS)!;
    world.addBatch(world.turn, 2, [{ type: 'queue', building: barracks.id, unit: CLUBMAN, count: 1 }]);

    let attackCountWhileFighting = 0;
    for (let i = 0; i < 70; i++) {
      if (i % 2 === 0) {
        const { observation, memory: nextMem } = createBotObservation(world, 2, memory);
        memory = nextMem;
        const res = runProposeCommitCycle([planner], observation, profile, arbiterState, plannerState, 77);
        if (res.commands.length > 0) {
          issuedCommands.push(...res.commands);
          attackCountWhileFighting += res.commands.filter((c) => c.type === 'attack').length;
          world.addBatch(world.turn, 2, res.commands);
        }
      }
      world.runTurn();
    }

    // Never attacked unreachable island enemy
    expect(issuedCommands.some((c) => c.type === 'attack' && c.target === islandEnemy.id)).toBe(false);
    // Engaged mainland enemies and killed/damaged them
    expect(attackCountWhileFighting).toBeGreaterThanOrEqual(1);
    // Bounded command churn: far fewer attack commands than the 35 think ticks!
    expect(attackCountWhileFighting).toBeLessThanOrEqual(8);
    expect(mainlandEnemyClubman.state).toBeGreaterThan(ObjectState.Active);

    // Unique squad membership invariant in final state
    const seen = new Set<number>();
    for (const s of plannerState.squads) {
      for (const uid of s.memberIds) {
        expect(seen.has(uid)).toBe(false);
        seen.add(uid);
      }
    }
    expect(seen.size).toBeGreaterThanOrEqual(1);
  });

  test('walled-off enemy inside same connected zone is detected via dynamic check and never spammed', () => {
    const map = new TileMap(40, 40);
    const units: StartUnit[] = [
      { owner: 2, type: TOWN_CENTER, x: 8.5, y: 8.5 },
      { owner: 2, type: CLUBMAN, x: 10.5, y: 12.5 },
      { owner: 2, type: CLUBMAN, x: 11.5, y: 12.5 },
      { owner: 2, type: CLUBMAN, x: 10.5, y: 13.5 },
      { owner: 2, type: CLUBMAN, x: 11.5, y: 13.5 },
      { owner: 1, type: CLUBMAN, x: 18.5, y: 12.5 },
    ];
    for (let x = 16; x <= 20; x++) {
      units.push({ owner: 1, type: SMALL_WALL, x: x + 0.5, y: 10.5 });
      units.push({ owner: 1, type: SMALL_WALL, x: x + 0.5, y: 14.5 });
    }
    for (let y = 11; y <= 13; y++) {
      units.push({ owner: 1, type: SMALL_WALL, x: 16.5, y: y + 0.5 });
      units.push({ owner: 1, type: SMALL_WALL, x: 20.5, y: y + 0.5 });
    }

    const world = new World({ players: 3, map, units, victory: { type: VICTORY_SPECIAL } });
    world.visibility.exploreRect(2, 14, 9, 22, 16);

    const planner = createSquadPlanner();
    const profile = getBotProfile('medium');
    const arbiterState = createArbiterState();
    const plannerState = makePlannerState();
    let memory = createEmptyBotMemory();

    const trappedClubman = [...world.entities.ofPlayer(1)].find((e) => e.type === CLUBMAN)!;
    let attacksOnTrapped = 0;

    for (let i = 0; i < 16; i++) {
      if (i % 2 === 0) {
        const { observation, memory: nextMem } = createBotObservation(world, 2, memory);
        memory = nextMem;
        const res = runProposeCommitCycle([planner], observation, profile, arbiterState, plannerState, 9);
        attacksOnTrapped += res.commands.filter((c) => c.type === 'attack' && c.target === trappedClubman.id).length;
        if (res.commands.length > 0) {
          world.addBatch(world.turn, 2, res.commands);
        }
      }
      world.runTurn();
    }

    // Dynamic path check detects enclosure around trappedClubman; bot may target reachable wall or skip trappedClubman,
    // and never spams attack on trappedClubman!
    expect(attacksOnTrapped).toBe(0);
    expect(COMMAND_DELAY_TURNS).toBe(2);
  });
});
