import { describe, expect, test, vi } from 'vitest';
import {
  ATTR_FOOD,
  ATTR_GOLD,
  ATTR_STONE,
  ATTR_WOOD,
  CIV_COUNT,
  CIV_RANDOM,
  DEFAULT_GAME_SETTINGS,
  lobbyWorldOptions,
  resolveCivs,
  World,
} from '@aoe/sim';
import {
  BOT_PROFILES,
  DEFAULT_BOT_DIFFICULTY,
  getBotProfile,
  isBotDifficulty,
  parseBotDifficulty,
  resolveBotDifficulty,
  shouldThinkAtTime,
  validateBotProfile,
} from './difficulty';
import {
  BOT_CONTRACT_VERSION,
  type BotDifficulty,
  type BotObservation,
  type BotProfile,
  type ObservedOwnBuilding,
  type PendingAction,
  type PlannerInput,
  type SinglePlayerSetup,
} from './types';

describe('T00 D01 — Deterministic difficulty & game-time think cadence', () => {
  test('contract version is pinned to phase2-v1', () => {
    expect(BOT_CONTRACT_VERSION).toBe('phase2-v1');
  });

  test('shouldThinkAtTime and profile resolution are purely deterministic and ignore wall clock and Math.random', () => {
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
      const difficulties: BotDifficulty[] = ['easy', 'medium', 'hard'];
      const times = [0, 500, 1000, 1500, 2000, 2500, 4000, 6000];

      const runTrace = (difficulty: BotDifficulty) => {
        const profile = getBotProfile(resolveBotDifficulty(difficulty));
        let lastThink = -1;
        const trace: boolean[] = [];
        for (const t of times) {
          const think = shouldThinkAtTime(lastThink, t, profile);
          trace.push(think);
          if (think) lastThink = t;
        }
        return { profile, trace };
      };

      for (const d of difficulties) {
        const runA = runTrace(d);
        const runB = runTrace(d);
        expect(runA).toEqual(runB);
        expect(runA.trace[0]).toBe(true); // Initial think at worldTime 0 when lastThink < 0
      }

      expect(dateSpy).not.toHaveBeenCalled();
      expect(perfSpy).not.toHaveBeenCalled();
      expect(randSpy).not.toHaveBeenCalled();
    } finally {
      dateSpy.mockRestore();
      perfSpy.mockRestore();
      randSpy.mockRestore();
    }
  });

  test('shouldThinkAtTime handles pause (unchanged worldTime) and invalid/out-of-order times cleanly', () => {
    const medium = getBotProfile('medium');

    expect(shouldThinkAtTime(-1, 0, medium)).toBe(true);
    expect(shouldThinkAtTime(-Infinity, 0, medium)).toBe(true);
    expect(shouldThinkAtTime(0, 0, medium)).toBe(false);
    expect(shouldThinkAtTime(0, medium.thinkIntervalMs - 1, medium)).toBe(false);
    expect(shouldThinkAtTime(0, medium.thinkIntervalMs, medium)).toBe(true);

    // Sim paused at worldTime = 2000 after thinking at 2000
    expect(shouldThinkAtTime(2000, 2000, medium)).toBe(false);

    // Invalid or non-monotonic inputs
    expect(shouldThinkAtTime(2000, 1500, medium)).toBe(false);
    expect(shouldThinkAtTime(-1, -1, medium)).toBe(false);
    expect(shouldThinkAtTime(0, Number.NaN, medium)).toBe(false);
    expect(shouldThinkAtTime(Number.NaN, 5000, medium)).toBe(false);
    expect(shouldThinkAtTime(0, Number.POSITIVE_INFINITY, medium)).toBe(false);
  });
});

describe('T00 D02 — Distinct bounded profiles and fair sim rules', () => {
  test('easy, medium, and hard profiles pass validation and have distinct bounded parameters', () => {
    const easy = getBotProfile('easy');
    const medium = getBotProfile('medium');
    const hard = getBotProfile('hard');

    expect(validateBotProfile(easy)).toBe(true);
    expect(validateBotProfile(medium)).toBe(true);
    expect(validateBotProfile(hard)).toBe(true);

    // Medium stays aligned with existing ai-bot.ts rhythm
    expect(medium.thinkIntervalMs).toBe(2000);
    expect(medium.minAttackSquadSize).toBe(4);
    expect(medium.targetVillagers).toBe(26);
    expect(medium.targetFarms).toBe(8);

    // Ordered progression across difficulties
    expect(easy.thinkIntervalMs).toBeGreaterThan(medium.thinkIntervalMs);
    expect(medium.thinkIntervalMs).toBeGreaterThan(hard.thinkIntervalMs);

    expect(easy.targetVillagers).toBeLessThan(medium.targetVillagers);
    expect(medium.targetVillagers).toBeLessThan(hard.targetVillagers);

    expect(easy.targetFarms).toBeLessThan(medium.targetFarms);
    expect(medium.targetFarms).toBeLessThan(hard.targetFarms);

    expect(easy.minAttackSquadSize).toBeGreaterThan(medium.minAttackSquadSize);
    expect(medium.minAttackSquadSize).toBeGreaterThanOrEqual(hard.minAttackSquadSize);

    expect(easy.maxSquads).toBeLessThan(medium.maxSquads);
    expect(medium.maxSquads).toBeLessThan(hard.maxSquads);

    expect(easy.maxResearchDepth).toBeLessThan(medium.maxResearchDepth);
    expect(medium.maxResearchDepth).toBeLessThan(hard.maxResearchDepth);

    expect(easy.maxMilitaryTrainPerTick).toBeLessThan(medium.maxMilitaryTrainPerTick);
    expect(medium.maxMilitaryTrainPerTick).toBeLessThan(hard.maxMilitaryTrainPerTick);

    expect(easy.allowCounterAttack).toBe(false);
    expect(medium.allowCounterAttack).toBe(true);
    expect(hard.allowCounterAttack).toBe(true);

    expect(BOT_PROFILES.easy).toEqual(easy);
    expect(BOT_PROFILES.medium).toEqual(medium);
    expect(BOT_PROFILES.hard).toEqual(hard);
  });

  test('validateBotProfile rejects unbounded or malformed profiles', () => {
    const base = getBotProfile('medium');
    const badCases: BotProfile[] = [
      { ...base, thinkIntervalMs: 0 },
      { ...base, thinkIntervalMs: -500 },
      { ...base, thinkIntervalMs: Number.NaN },
      { ...base, thinkIntervalMs: Number.POSITIVE_INFINITY },
      { ...base, targetVillagers: 0 },
      { ...base, targetVillagers: 2.5 },
      { ...base, targetFarms: -1 },
      { ...base, minAttackSquadSize: 0 },
      { ...base, maxSquads: 0 },
      { ...base, retreatHpRatio: -0.1 },
      { ...base, retreatHpRatio: 1 },
      { ...base, ecoReserveRatio: -0.01 },
      { ...base, ecoReserveRatio: 1.0 },
      { ...base, maxResearchDepth: -1 },
      { ...base, maxMilitaryTrainPerTick: 0 },
    ];
    for (const c of badCases) {
      expect(validateBotProfile(c)).toBe(false);
    }
    expect(validateBotProfile(null as unknown as BotProfile)).toBe(false);
    expect(validateBotProfile({ ...base, difficulty: 'nightmare' as BotDifficulty })).toBe(false);
  });

  test('no difficulty profile grants extra starting resources or map-hack vision', () => {
    const seed = 424242;
    const setups: SinglePlayerSetup[] = (['easy', 'medium', 'hard'] as const).map((difficulty) => ({
      humanCiv: 1,
      botCiv: 1,
      settings: { ...DEFAULT_GAME_SETTINGS },
      difficulty,
    }));

    const worlds = setups.map((setup) => {
      const profile = getBotProfile(setup.difficulty);
      expect(validateBotProfile(profile)).toBe(true);
      const world = new World(lobbyWorldOptions(seed, setup.settings, [setup.humanCiv, setup.botCiv], true));
      return { difficulty: setup.difficulty, world };
    });

    for (const { world } of worlds) {
      // Bot (player 2) has identical starting stockpiles and explored tiles as human (player 1)
      expect(world.attributes[2]![ATTR_FOOD]).toBe(world.attributes[1]![ATTR_FOOD]);
      expect(world.attributes[2]![ATTR_WOOD]).toBe(world.attributes[1]![ATTR_WOOD]);
      expect(world.attributes[2]![ATTR_STONE]).toBe(world.attributes[1]![ATTR_STONE]);
      expect(world.attributes[2]![ATTR_GOLD]).toBe(world.attributes[1]![ATTR_GOLD]);
      expect(world.visibility.explored[2]).toBe(world.visibility.explored[1]);
    }
  });
});

describe('T00 D03 — Difficulty parsing, fallback, and seed-deterministic Random civ resolution', () => {
  test('isBotDifficulty and parseBotDifficulty reject invalid/missing/prototype-pollution inputs', () => {
    expect(DEFAULT_BOT_DIFFICULTY).toBe('medium');

    expect(isBotDifficulty('easy')).toBe(true);
    expect(isBotDifficulty('medium')).toBe(true);
    expect(isBotDifficulty('hard')).toBe(true);

    expect(parseBotDifficulty('easy')).toBe('easy');
    expect(parseBotDifficulty('medium')).toBe('medium');
    expect(parseBotDifficulty('hard')).toBe('hard');

    const invalidInputs: unknown[] = [null, undefined, '', 'nightmare', 'EASY', ' medium ', 123, true, {}, [], '__proto__', 'constructor', 'toString'];
    for (const bad of invalidInputs) {
      expect(isBotDifficulty(bad)).toBe(false);
      expect(parseBotDifficulty(bad)).toBeNull();
    }
  });

  test('resolveBotDifficulty falls back cleanly to DEFAULT_BOT_DIFFICULTY (medium)', () => {
    expect(resolveBotDifficulty('easy')).toBe('easy');
    expect(resolveBotDifficulty('medium')).toBe('medium');
    expect(resolveBotDifficulty('hard')).toBe('hard');

    expect(resolveBotDifficulty(null)).toBe('medium');
    expect(resolveBotDifficulty(undefined)).toBe('medium');
    expect(resolveBotDifficulty('')).toBe('medium');
    expect(resolveBotDifficulty('nightmare')).toBe('medium');
    expect(resolveBotDifficulty(123)).toBe('medium');
    expect(resolveBotDifficulty('__proto__')).toBe('medium');

    expect(getBotProfile('invalid-difficulty')).toEqual(BOT_PROFILES.medium);
  });

  test('resolveCivs(seed, [17, 17]) resolves Random civs deterministically and replayably from seed', () => {
    const seed = 98765;
    const resolvedA = resolveCivs(seed, [CIV_RANDOM, CIV_RANDOM]);
    const resolvedB = resolveCivs(seed, [CIV_RANDOM, CIV_RANDOM]);

    expect(resolvedA).toEqual(resolvedB);
    expect(resolvedA).toHaveLength(2);
    for (const civ of resolvedA) {
      expect(Number.isInteger(civ)).toBe(true);
      expect(civ).toBeGreaterThanOrEqual(1);
      expect(civ).toBeLessThanOrEqual(CIV_COUNT);
    }

    const w1 = new World(lobbyWorldOptions(seed, DEFAULT_GAME_SETTINGS, [CIV_RANDOM, CIV_RANDOM], true));
    const w2 = new World(lobbyWorldOptions(seed, DEFAULT_GAME_SETTINGS, [CIV_RANDOM, CIV_RANDOM], true));
    expect(w1.civs).toEqual(w2.civs);
    expect(w1.civs.slice(1)).toEqual(resolvedA);
    expect(w1.randomSeed).toBe(w2.randomSeed);
  });
});

describe('T00 contract DTOs (phase2-v1)', () => {
  test('ObservedOwnBuilding, PendingAction, PlannerInput, and BotObservation expose required fields and placement actorId', () => {
    const farm: ObservedOwnBuilding = {
      id: 10,
      type: 50,
      x: 12,
      y: 14,
      hp: 480,
      maxHp: 480,
      state: 2,
      isUnbuilt: false,
      buildPoints: 30,
      requiredBuildPoints: 30,
      heldType: 0,
      heldAmount: 0,
      makeTimer: 250,
      trainingUnit: null,
      queueLength: 0,
      queuedUnits: [],
      researchingTech: null,
      isBusy: false,
    };
    const emptyTimer: ObservedOwnBuilding['makeTimer'] = null;
    expect(farm.makeTimer).toBe(250);
    expect(emptyTimer).toBeNull();

    const pending: PendingAction = {
      key: 'research:101:20',
      commandType: 'research',
      issuedTurn: 10,
      expectedApplyTurn: 12,
      expiresTurn: 20,
      cost: { food: 120 },
      unitIds: [],
      buildingId: 20,
      targetId: 99,
      techId: 101,
      trainUnitId: 83,
      expectedQueueCount: 2,
      status: 'issued',
    };
    expect(pending.targetId).toBe(99);
    expect(pending.techId).toBe(101);
    expect(pending.trainUnitId).toBe(83);
    expect(pending.expectedQueueCount).toBe(2);

    type FindBuildArgs = Parameters<BotObservation['findBuildPlacement']>;
    type FindDockArgs = Parameters<BotObservation['findDockPlacement']>;
    const buildArgsWithActor: FindBuildArgs = [50, 10, 10, 12, 7];
    const dockArgsWithActor: FindDockArgs = [10, 10, 7];
    expect(buildArgsWithActor[4]).toBe(7);
    expect(dockArgsWithActor[2]).toBe(7);

    const checkPlannerInput = (input: PlannerInput): readonly PendingAction[] => input.pendingActions;
    expect(typeof checkPlannerInput).toBe('function');
  });
});
