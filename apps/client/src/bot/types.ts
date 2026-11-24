import type { Command, GameSettings } from '@aoe/sim';

export const BOT_CONTRACT_VERSION = 'phase2-v1' as const;

export type BotContractVersion = typeof BOT_CONTRACT_VERSION;

export type BotDifficulty = 'easy' | 'medium' | 'hard';

export type RoomMode = 'multiplayer' | 'single-player';

export interface SinglePlayerSetup {
  humanCiv: number;
  botCiv: number;
  settings: GameSettings;
  difficulty: BotDifficulty;
}

/**
 * Behavioral difficulty parameters. All profiles obey identical fog of war,
 * resource costs, tech rules, and map visibility (no map-hack, no bonus resources).
 */
export interface BotProfile {
  readonly difficulty: BotDifficulty;
  /** Game-time cadence between think ticks in ms (`worldTime`, never wall clock). */
  readonly thinkIntervalMs: number;
  readonly targetVillagers: number;
  readonly targetFarms: number;
  readonly minAttackSquadSize: number;
  readonly maxSquads: number;
  readonly retreatHpRatio: number;
  readonly maxResearchDepth: number;
  readonly maxMilitaryTrainPerTick: number;
  readonly ecoReserveRatio: number;
  readonly allowCounterAttack: boolean;
  readonly allowNaval: boolean;
  readonly allowElephantHunt: boolean;
}

export interface ObservedMasterCost {
  readonly type: number;
  readonly amount: number;
  readonly flag: number;
}

export interface ObservedMasterCombat {
  readonly range: number;
  readonly minRange: number;
  readonly baseArmour: number;
  readonly attacks: readonly { readonly group: number; readonly amount: number }[];
}

/**
 * Read-only projection of a player's master record (reflecting `copyObj` and tech-mutated stats).
 */
export interface ObservedMaster {
  readonly id: number;
  readonly name: string;
  readonly masterType: number;
  readonly group: number;
  readonly hitPoints: number;
  readonly los: number;
  readonly fogFlag: number;
  readonly speed: number;
  readonly radiusX: number;
  readonly radiusY: number;
  readonly clearanceX: number;
  readonly clearanceY: number;
  readonly terrainRestriction: number;
  readonly unitLevel: number;
  readonly trackAsResource: number;
  readonly resourceGroup: number;
  readonly enabled: boolean;
  readonly costs: readonly ObservedMasterCost[];
  readonly trainTime: number;
  readonly trainLocationId: number;
  readonly combat: ObservedMasterCombat | null;
}

export interface ObservedOwnUnit {
  readonly id: number;
  readonly type: number;
  readonly x: number;
  readonly y: number;
  readonly hp: number;
  readonly maxHp: number;
  readonly state: number;
  readonly heldType: number;
  readonly heldAmount: number;
  readonly isVillager: boolean;
  readonly isMilitary: boolean;
  readonly isNaval: boolean;
  readonly isMoving: boolean;
  readonly workTarget: number | null;
  readonly workState: number | null;
  readonly isWorkActive: boolean;
  readonly attackTarget: number | null;
  readonly attackState: number | null;
  readonly isActivelyEngaged: boolean;
  readonly inside: number | null;
  readonly cargoCount: number;
}

export interface ObservedOwnBuilding {
  readonly id: number;
  readonly type: number;
  readonly x: number;
  readonly y: number;
  readonly hp: number;
  readonly maxHp: number;
  readonly state: number;
  readonly isUnbuilt: boolean;
  readonly buildPoints: number;
  readonly requiredBuildPoints: number;
  readonly heldType: number;
  readonly heldAmount: number;
  readonly makeTimer: number | null;
  readonly trainingUnit: number | null;
  readonly queueLength: number;
  readonly queuedUnits: readonly { readonly unit: number; readonly count: number }[];
  readonly researchingTech: number | null;
  readonly isBusy: boolean;
}

export interface ObservedEnemy {
  readonly id: number;
  readonly owner: number;
  readonly type: number;
  readonly x: number;
  readonly y: number;
  readonly hp: number;
  readonly maxHp: number;
  readonly state: number;
  readonly isBuilding: boolean;
  readonly isStatic: boolean;
  readonly isVillager: boolean;
  readonly isMilitary: boolean;
  readonly visibleNow: boolean;
  readonly lastSeenTurn: number;
  readonly reachRange: number;
}

export interface ObservedResource {
  readonly id: number;
  readonly type: number;
  readonly x: number;
  readonly y: number;
  readonly state: number;
  readonly heldType: number;
  readonly heldAmount: number;
  readonly resourceGroup: number;
  readonly visibleNow: boolean;
  readonly lastSeenTurn: number;
  readonly isDangerous: boolean;
}

/**
 * Fog-filtered, read-only observation snapshot passed to bot planners (`T01`–`T06`).
 * Planners never read raw `world.entities.all()` or mutate simulation state.
 */
export interface BotObservation {
  readonly contractVersion: BotContractVersion;
  readonly player: number;
  readonly turn: number;
  readonly worldTime: number;
  readonly age: number;
  readonly civ: number;
  readonly mapWidth: number;
  readonly mapHeight: number;
  readonly resources: {
    readonly food: number;
    readonly wood: number;
    readonly stone: number;
    readonly gold: number;
  };
  readonly population: {
    readonly current: number;
    readonly limit: number;
    readonly headroom: number;
  };
  readonly ownUnits: readonly ObservedOwnUnit[];
  readonly ownBuildings: readonly ObservedOwnBuilding[];
  readonly knownEnemies: readonly ObservedEnemy[];
  readonly knownResources: readonly ObservedResource[];
  readonly techStates: readonly number[];
  readonly enabledMasters: Readonly<Record<number, ObservedMaster>>;
  canReach(actorId: number, targetX: number, targetY: number, range?: number, checkDynamicPath?: boolean): boolean;
  isTileExplored(col: number, row: number): boolean;
  isTileVisible(col: number, row: number): boolean;
  findNearestExploreTarget(actorId: number, seed: number): { x: number; y: number } | null;
  canPlaceBuilding(masterId: number, x: number, y: number): boolean;
  findBuildPlacement(masterId: number, nearX: number, nearY: number, maxRadius?: number, actorId?: number): { x: number; y: number } | null;
  findDockPlacement(nearX: number, nearY: number, actorId?: number): { x: number; y: number } | null;
}

export interface ResourceClaim {
  readonly food?: number;
  readonly wood?: number;
  readonly stone?: number;
  readonly gold?: number;
  readonly headroom?: number;
}

export interface BotIntentSpot {
  readonly x: number;
  readonly y: number;
  readonly masterId: number;
}

export interface BotIntent {
  readonly command: Command;
  readonly priority: number;
  /** Stable deduplication key across `COMMAND_DELAY_TURNS`. */
  readonly key: string;
  readonly reason: string;
  readonly cost?: ResourceClaim;
  readonly unitIds?: readonly number[];
  readonly buildingId?: number;
  readonly spot?: BotIntentSpot;
  readonly ttlTurns?: number;
}

export type IntentRejectReason =
  | 'insufficient-budget'
  | 'unit-busy-or-claimed'
  | 'building-busy-or-claimed'
  | 'duplicate-pending'
  | 'spot-claimed'
  | 'batch-limit-exceeded'
  | 'invalid-intent';

export interface IntentOutcome {
  readonly key: string;
  readonly accepted: boolean;
  readonly reason?: IntentRejectReason;
  readonly command?: Command;
}

export interface ArbiterResult {
  readonly accepted: readonly BotIntent[];
  readonly rejected: readonly IntentOutcome[];
  readonly outcomesByKey: Readonly<Record<string, IntentOutcome>>;
  readonly commands: Command[];
}

export type PendingStatus = 'issued' | 'applied' | 'failed' | 'expired';

export interface PendingAction {
  key: string;
  commandType: Command['type'];
  issuedTurn: number;
  expectedApplyTurn: number;
  expiresTurn: number;
  cost: ResourceClaim;
  unitIds: readonly number[];
  buildingId?: number;
  spot?: { x: number; y: number; masterId: number };
  targetId?: number;
  techId?: number;
  trainUnitId?: number;
  expectedQueueCount?: number;
  status: PendingStatus;
}

export type SquadRole = 'defense' | 'raider' | 'assault' | 'naval' | 'scout';

export type SquadPhase = 'forming' | 'rallying' | 'attacking' | 'retreating' | 'recovering';

export interface SquadState {
  id: number;
  role: SquadRole;
  phase: SquadPhase;
  memberIds: number[];
  targetId: number | null;
  targetPos: { x: number; y: number } | null;
  lastOrderTurn: number;
  lastOrderTime: number;
  stuckSinceTurn: number | null;
}

export interface RememberedEntity {
  id: number;
  owner: number;
  type: number;
  x: number;
  y: number;
  kind: 'enemy-building' | 'enemy-unit' | 'resource';
  lastSeenTurn: number;
  lastSeenTime: number;
  heldAmount?: number;
  isBuilding?: boolean;
}

export interface BotPlannerMemory {
  enemiesById: Record<number, RememberedEntity>;
  resourcesById: Record<number, RememberedEntity>;
}

export interface FailedTargetRecord {
  count: number;
  retryAfterTurn: number;
}

export interface BotPlannerState {
  lastThinkTime: number;
  squads: SquadState[];
  nextSquadSeq: number;
  depletedResourceIds: number[];
  failedTargets: Record<number, FailedTargetRecord>;
  unitCooldownUntil: Record<number, number>;
  buildingCooldownUntil: Record<number, number>;
  memory: BotPlannerMemory;
}

export interface PlannerInput {
  readonly observation: BotObservation;
  readonly profile: BotProfile;
  readonly state: BotPlannerState;
  readonly seed: number;
  readonly pendingActions: readonly PendingAction[];
}

/**
 * Two-phase planner contract (`propose` / `commit`):
 * - `propose` must NOT mutate command-dependent state (pending, squad phase, cooldowns).
 * - `commit` receives arbiter outcomes keyed by `BotIntent.key` and only commits state for accepted intents.
 */
export interface BotPlanner {
  readonly name: string;
  propose(input: PlannerInput): BotIntent[];
  commit(outcomes: Readonly<Record<string, IntentOutcome>>, input: PlannerInput): void;
}

export type BotCommandSink = (commands: readonly Command[]) => void;
