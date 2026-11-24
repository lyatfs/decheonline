import type { BotDifficulty, BotProfile } from './types';

export const DEFAULT_BOT_DIFFICULTY: BotDifficulty = 'medium';

export const BOT_DIFFICULTIES: readonly BotDifficulty[] = ['easy', 'medium', 'hard'] as const;

export const BOT_PROFILES: Readonly<Record<BotDifficulty, BotProfile>> = Object.freeze({
  easy: Object.freeze<BotProfile>({
    difficulty: 'easy',
    thinkIntervalMs: 4000,
    targetVillagers: 14,
    targetFarms: 4,
    minAttackSquadSize: 6,
    maxSquads: 2,
    retreatHpRatio: 0.35,
    maxResearchDepth: 1,
    maxMilitaryTrainPerTick: 1,
    ecoReserveRatio: 0.15,
    allowCounterAttack: false,
    allowNaval: false,
    allowElephantHunt: false,
  }),
  medium: Object.freeze<BotProfile>({
    difficulty: 'medium',
    thinkIntervalMs: 2000,
    targetVillagers: 26,
    targetFarms: 8,
    minAttackSquadSize: 4,
    maxSquads: 3,
    retreatHpRatio: 0.2,
    maxResearchDepth: 2,
    maxMilitaryTrainPerTick: 2,
    ecoReserveRatio: 0.25,
    allowCounterAttack: true,
    allowNaval: true,
    allowElephantHunt: true,
  }),
  hard: Object.freeze<BotProfile>({
    difficulty: 'hard',
    thinkIntervalMs: 1000,
    targetVillagers: 36,
    targetFarms: 12,
    minAttackSquadSize: 3,
    maxSquads: 5,
    retreatHpRatio: 0.25,
    maxResearchDepth: 4,
    maxMilitaryTrainPerTick: 4,
    ecoReserveRatio: 0.3,
    allowCounterAttack: true,
    allowNaval: true,
    allowElephantHunt: true,
  }),
});

export function isBotDifficulty(value: unknown): value is BotDifficulty {
  return value === 'easy' || value === 'medium' || value === 'hard';
}

export function parseBotDifficulty(value: unknown): BotDifficulty | null {
  return isBotDifficulty(value) ? value : null;
}

export function resolveBotDifficulty(value: unknown): BotDifficulty {
  return parseBotDifficulty(value) ?? DEFAULT_BOT_DIFFICULTY;
}

export function getBotProfile(difficulty: unknown): BotProfile {
  const resolved = resolveBotDifficulty(difficulty);
  return { ...BOT_PROFILES[resolved] };
}

export function validateBotProfile(profile: unknown): profile is BotProfile {
  if (typeof profile !== 'object' || profile === null || Array.isArray(profile)) return false;
  const p = profile as Partial<BotProfile>;
  if (!isBotDifficulty(p.difficulty)) return false;
  if (typeof p.thinkIntervalMs !== 'number' || !Number.isFinite(p.thinkIntervalMs) || p.thinkIntervalMs < 200 || p.thinkIntervalMs > 60_000) {
    return false;
  }
  if (!Number.isInteger(p.targetVillagers) || p.targetVillagers! < 1 || p.targetVillagers! > 200) return false;
  if (!Number.isInteger(p.targetFarms) || p.targetFarms! < 0 || p.targetFarms! > 50) return false;
  if (!Number.isInteger(p.minAttackSquadSize) || p.minAttackSquadSize! < 1 || p.minAttackSquadSize! > 50) return false;
  if (!Number.isInteger(p.maxSquads) || p.maxSquads! < 1 || p.maxSquads! > 20) return false;
  if (typeof p.retreatHpRatio !== 'number' || !Number.isFinite(p.retreatHpRatio) || p.retreatHpRatio < 0 || p.retreatHpRatio >= 1) {
    return false;
  }
  if (!Number.isInteger(p.maxResearchDepth) || p.maxResearchDepth! < 0 || p.maxResearchDepth! > 10) return false;
  if (!Number.isInteger(p.maxMilitaryTrainPerTick) || p.maxMilitaryTrainPerTick! < 1 || p.maxMilitaryTrainPerTick! > 20) {
    return false;
  }
  if (typeof p.ecoReserveRatio !== 'number' || !Number.isFinite(p.ecoReserveRatio) || p.ecoReserveRatio < 0 || p.ecoReserveRatio >= 1) {
    return false;
  }
  if (typeof p.allowCounterAttack !== 'boolean') return false;
  if (typeof p.allowNaval !== 'boolean') return false;
  if (typeof p.allowElephantHunt !== 'boolean') return false;
  return true;
}

/**
 * Purely simulation-time (`worldTime`) think cadence check.
 * Never reads wall-clock timers (`Date.now` / `performance.now`).
 */
export function shouldThinkAtTime(lastThinkTime: number, worldTime: number, profile: BotProfile): boolean {
  if (!Number.isFinite(worldTime) || worldTime < 0) return false;
  if (!Number.isFinite(profile.thinkIntervalMs) || profile.thinkIntervalMs <= 0) return false;
  if (Number.isNaN(lastThinkTime)) return false;
  if (lastThinkTime < 0) return true;
  if (worldTime < lastThinkTime) return false;
  return worldTime - lastThinkTime >= profile.thinkIntervalMs;
}
