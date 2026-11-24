import { MAX_COMMANDS_PER_BATCH } from '@aoe/protocol';
import {
  COMMAND_DELAY_TURNS,
  ObjectState,
  TECH_AVAILABLE,
  TECH_DISABLED,
  TECH_RESEARCHING,
  type Command,
} from '@aoe/sim';
import type {
  ArbiterResult,
  BotIntent,
  BotIntentSpot,
  BotObservation,
  BotPlanner,
  BotPlannerState,
  BotProfile,
  IntentOutcome,
  IntentRejectReason,
  ObservedEnemy,
  ObservedOwnBuilding,
  ObservedOwnUnit,
  ObservedResource,
  PendingAction,
  PlannerInput,
  ResourceClaim,
} from './types';

export const DEFAULT_PENDING_TTL_TURNS = COMMAND_DELAY_TURNS + 4;
export const MIN_PENDING_TTL_TURNS = COMMAND_DELAY_TURNS + 1;

export interface AvailableResources {
  food: number;
  wood: number;
  stone: number;
  gold: number;
}

export interface AvailableBudget extends AvailableResources {
  headroom: number;
}

export interface ArbiterState {
  pending: PendingAction[];
  lastResolved: PendingAction[];
}

interface QueuePendingMeta {
  countDelta: number;
  switchesUnitType: boolean;
}

const queuePendingMeta = new WeakMap<PendingAction, QueuePendingMeta>();

export function createArbiterState(): ArbiterState {
  return {
    pending: [],
    lastResolved: [],
  };
}

export function getActivePending(state: ArbiterState): readonly PendingAction[] {
  return state.pending.filter((p) => p.status === 'issued');
}

export function hasPendingKey(state: ArbiterState, key: string): boolean {
  return state.pending.some((p) => p.status === 'issued' && p.key === key);
}

export function isTechPending(state: ArbiterState, techId: number): boolean {
  return state.pending.some((p) => p.status === 'issued' && p.techId === techId);
}

export function isBuildingPending(state: ArbiterState, buildingId: number): boolean {
  return state.pending.some((p) => p.status === 'issued' && p.buildingId === buildingId);
}

export function isUnitPending(state: ArbiterState, unitId: number): boolean {
  return state.pending.some((p) => p.status === 'issued' && p.unitIds.includes(unitId));
}

export function resetArbiterState(state: ArbiterState): void {
  state.pending.length = 0;
  state.lastResolved.length = 0;
}

function isOwnUnitAlive(u: ObservedOwnUnit | undefined): u is ObservedOwnUnit {
  return Boolean(u && u.hp > 0 && u.state < ObjectState.Dying);
}

function isOwnBuildingAlive(b: ObservedOwnBuilding | undefined): b is ObservedOwnBuilding {
  return Boolean(b && b.hp > 0 && b.state < ObjectState.Dying);
}

function getEffectiveQueueCount(b: ObservedOwnBuilding): number {
  let queuedTotal = 0;
  for (const q of b.queuedUnits) {
    if (q.count > 0) queuedTotal += q.count;
  }
  return Math.max(b.queueLength, queuedTotal, b.trainingUnit !== null ? 1 : 0);
}

function isActionMaterialized(
  action: PendingAction,
  observation: BotObservation,
  ownUnitsById: ReadonlyMap<number, ObservedOwnUnit>,
  ownBuildingsById: ReadonlyMap<number, ObservedOwnBuilding>,
): boolean {
  switch (action.commandType) {
    case 'build':
    case 'build-wall': {
      const spot = action.spot;
      if (!spot) return false;
      return observation.ownBuildings.some(
        (b) =>
          isOwnBuildingAlive(b) &&
          b.type === spot.masterId &&
          Math.hypot(b.x - spot.x, b.y - spot.y) < 1,
      );
    }
    case 'research': {
      if (action.techId === undefined) return false;
      if ((observation.techStates[action.techId] ?? 0) >= TECH_RESEARCHING) {
        return true;
      }
      if (action.buildingId !== undefined) {
        const b = ownBuildingsById.get(action.buildingId);
        if (isOwnBuildingAlive(b) && b.researchingTech === action.techId) {
          return true;
        }
      }
      return observation.ownBuildings.some(
        (b) => isOwnBuildingAlive(b) && b.researchingTech === action.techId,
      );
    }
    case 'queue': {
      if (action.buildingId === undefined) return false;
      const b = ownBuildingsById.get(action.buildingId);
      if (!isOwnBuildingAlive(b)) return false;
      const currentCount = getEffectiveQueueCount(b);
      const meta = queuePendingMeta.get(action);

      if (meta && meta.countDelta < 0) {
        return (
          observation.turn > action.expectedApplyTurn &&
          currentCount <= (action.expectedQueueCount ?? 0)
        );
      }

      const hasTrainUnit =
        action.trainUnitId === undefined ||
        b.trainingUnit === action.trainUnitId ||
        b.queuedUnits.some((q) => q.unit === action.trainUnitId);

      if (meta?.switchesUnitType && observation.turn <= action.expectedApplyTurn) {
        return false;
      }

      if (action.expectedQueueCount !== undefined) {
        if (action.expectedQueueCount === 0 && !meta) {
          return observation.turn > action.expectedApplyTurn && currentCount === 0;
        }
        if (!hasTrainUnit) return false;
        if (currentCount >= action.expectedQueueCount) return true;
        if (observation.turn > action.expectedApplyTurn && currentCount > 0) {
          return true;
        }
        return false;
      }
      return hasTrainUnit && currentCount > 0;
    }
    case 'attack': {
      if (observation.turn <= action.expectedApplyTurn || action.targetId === undefined) return false;
      return action.unitIds.some((id) => {
        const u = ownUnitsById.get(id);
        return (
          isOwnUnitAlive(u) &&
          ((u.isActivelyEngaged && u.attackTarget === action.targetId) ||
            (u.isWorkActive && u.workTarget === action.targetId))
        );
      });
    }
    case 'work':
    case 'repair': {
      if (observation.turn <= action.expectedApplyTurn || action.targetId === undefined) return false;
      return action.unitIds.some((id) => {
        const u = ownUnitsById.get(id);
        return isOwnUnitAlive(u) && u.isWorkActive && u.workTarget === action.targetId;
      });
    }
    case 'move': {
      if (observation.turn <= action.expectedApplyTurn) return false;
      return action.unitIds.some((id) => {
        const u = ownUnitsById.get(id);
        return isOwnUnitAlive(u) && u.isMoving;
      });
    }
    default:
      return false;
  }
}

function isActionFailedEarly(
  action: PendingAction,
  observation: BotObservation,
  ownUnitsById: ReadonlyMap<number, ObservedOwnUnit>,
  ownBuildingsById: ReadonlyMap<number, ObservedOwnBuilding>,
  enemiesById: ReadonlyMap<number, ObservedEnemy>,
  resourcesById: ReadonlyMap<number, ObservedResource>,
): boolean {
  if (action.unitIds.length > 0 && action.unitIds.every((id) => !isOwnUnitAlive(ownUnitsById.get(id)))) {
    return true;
  }

  if (action.buildingId !== undefined && !isOwnBuildingAlive(ownBuildingsById.get(action.buildingId))) {
    return true;
  }

  if (
    action.commandType === 'research' &&
    action.techId !== undefined &&
    observation.techStates[action.techId] === TECH_DISABLED
  ) {
    return true;
  }

  if (action.targetId !== undefined) {
    if (action.commandType === 'attack') {
      const enemy = enemiesById.get(action.targetId);
      if (!enemy || enemy.hp <= 0 || enemy.state >= ObjectState.Dying) {
        return true;
      }
    } else if (action.commandType === 'repair') {
      const building = ownBuildingsById.get(action.targetId);
      const unit = ownUnitsById.get(action.targetId);
      if (!isOwnBuildingAlive(building) && !isOwnUnitAlive(unit)) {
        return true;
      }
    } else if (action.commandType === 'work') {
      const resource = resourcesById.get(action.targetId);
      if (resource) {
        if (resource.heldAmount <= 0 || resource.state >= ObjectState.PendingRemoval) {
          return true;
        }
      } else {
        const building = ownBuildingsById.get(action.targetId);
        if (building) {
          if (!isOwnBuildingAlive(building)) return true;
        } else {
          const unit = ownUnitsById.get(action.targetId);
          if (unit) {
            if (!isOwnUnitAlive(unit)) return true;
          } else {
            const enemy = enemiesById.get(action.targetId);
            if (!enemy || enemy.hp <= 0 || enemy.state >= ObjectState.Dying) {
              return true;
            }
          }
        }
      }
    }
  }

  return false;
}

/**
 * Transitions active pending actions (`issued` -> `applied` | `failed` | `expired`)
 * and removes all resolved/dead entries so reservations release **exactly once**.
 */
export function reconcilePending(observation: BotObservation, state: ArbiterState): PendingAction[] {
  const ownUnitsById = new Map<number, ObservedOwnUnit>();
  for (const u of observation.ownUnits) ownUnitsById.set(u.id, u);

  const ownBuildingsById = new Map<number, ObservedOwnBuilding>();
  for (const b of observation.ownBuildings) ownBuildingsById.set(b.id, b);

  const enemiesById = new Map<number, ObservedEnemy>();
  for (const e of observation.knownEnemies) enemiesById.set(e.id, e);

  const resourcesById = new Map<number, ObservedResource>();
  for (const r of observation.knownResources) resourcesById.set(r.id, r);

  const nextPending: PendingAction[] = [];
  const resolved: PendingAction[] = [];

  for (const action of state.pending) {
    if (action.status !== 'issued') {
      continue;
    }

    if (isActionMaterialized(action, observation, ownUnitsById, ownBuildingsById)) {
      action.status = 'applied';
      resolved.push(action);
      continue;
    }

    if (isActionFailedEarly(action, observation, ownUnitsById, ownBuildingsById, enemiesById, resourcesById)) {
      action.status = 'failed';
      resolved.push(action);
      continue;
    }

    if (!Number.isFinite(action.expiresTurn) || observation.turn > action.expiresTurn) {
      action.status = 'expired';
      resolved.push(action);
      continue;
    }

    nextPending.push(action);
  }

  state.pending = nextPending;
  state.lastResolved = resolved;
  return state.pending;
}

/**
 * Computes available resources & headroom for this tick by subtracting active `pending` claims,
 * clamped >= 0.
 */
export function getAvailableBudget(observation: BotObservation, state: ArbiterState): AvailableBudget {
  let foodClaimed = 0;
  let woodClaimed = 0;
  let stoneClaimed = 0;
  let goldClaimed = 0;
  let headroomClaimed = 0;

  for (const p of state.pending) {
    if (p.status !== 'issued') continue;
    foodClaimed += p.cost.food ?? 0;
    woodClaimed += p.cost.wood ?? 0;
    stoneClaimed += p.cost.stone ?? 0;
    goldClaimed += p.cost.gold ?? 0;
    headroomClaimed += p.cost.headroom ?? 0;
  }

  return {
    food: Math.max(0, observation.resources.food - foodClaimed),
    wood: Math.max(0, observation.resources.wood - woodClaimed),
    stone: Math.max(0, observation.resources.stone - stoneClaimed),
    gold: Math.max(0, observation.resources.gold - goldClaimed),
    headroom: Math.max(0, observation.population.headroom - headroomClaimed),
  };
}

/**
 * Computes remaining tick resources (`observation.resources` minus active `pending` claims, clamped >= 0).
 */
export function getAvailableResources(observation: BotObservation, state: ArbiterState): AvailableResources {
  const { food, wood, stone, gold } = getAvailableBudget(observation, state);
  return { food, wood, stone, gold };
}

function isValidResourceValue(v: number | undefined): boolean {
  return v === undefined || (typeof v === 'number' && Number.isFinite(v) && v >= 0);
}

function isValidCost(cost: ResourceClaim | undefined): boolean {
  if (cost === undefined) return true;
  if (typeof cost !== 'object' || cost === null || Array.isArray(cost)) return false;
  return (
    isValidResourceValue(cost.food) &&
    isValidResourceValue(cost.wood) &&
    isValidResourceValue(cost.stone) &&
    isValidResourceValue(cost.gold) &&
    isValidResourceValue(cost.headroom)
  );
}

function isPositiveInt(v: unknown): v is number {
  return typeof v === 'number' && Number.isInteger(v) && v > 0;
}

function isNonNegativeInt(v: unknown): v is number {
  return typeof v === 'number' && Number.isInteger(v) && v >= 0;
}

function isValidSpot(spot: BotIntentSpot | undefined): boolean {
  if (spot === undefined) return true;
  if (typeof spot !== 'object' || spot === null) return false;
  return (
    typeof spot.x === 'number' &&
    Number.isFinite(spot.x) &&
    typeof spot.y === 'number' &&
    Number.isFinite(spot.y) &&
    isNonNegativeInt(spot.masterId)
  );
}

function isValidIntent(intent: BotIntent): boolean {
  if (!intent || typeof intent !== 'object') return false;
  if (typeof intent.key !== 'string' || intent.key.trim().length === 0) return false;
  if (typeof intent.priority !== 'number' || !Number.isFinite(intent.priority)) return false;
  if (!intent.command || typeof intent.command !== 'object' || typeof intent.command.type !== 'string') {
    return false;
  }
  if (!isValidCost(intent.cost)) return false;
  if (
    intent.ttlTurns !== undefined &&
    (typeof intent.ttlTurns !== 'number' || !Number.isFinite(intent.ttlTurns) || intent.ttlTurns < 0)
  ) {
    return false;
  }
  if (intent.unitIds !== undefined) {
    if (!Array.isArray(intent.unitIds) || !intent.unitIds.every(isPositiveInt)) return false;
  }
  if (intent.buildingId !== undefined && !isPositiveInt(intent.buildingId)) return false;
  if (!isValidSpot(intent.spot)) return false;

  const cmd = intent.command;
  if (cmd.type === 'queue') {
    if (!isPositiveInt(cmd.building) || !isNonNegativeInt(cmd.unit) || !Number.isInteger(cmd.count) || cmd.count === 0) {
      return false;
    }
  } else if (cmd.type === 'research') {
    if (!isPositiveInt(cmd.building) || !isNonNegativeInt(cmd.tech)) return false;
  } else if (cmd.type === 'build') {
    if (
      !Number.isFinite(cmd.x) ||
      !Number.isFinite(cmd.y) ||
      !isNonNegativeInt(cmd.unitType) ||
      !Array.isArray(cmd.units) ||
      !cmd.units.every(isPositiveInt)
    ) {
      return false;
    }
  } else if ('units' in cmd) {
    if (!Array.isArray(cmd.units) || !cmd.units.every(isPositiveInt)) return false;
  }

  return true;
}

function extractUnitIds(intent: BotIntent): number[] {
  const raw = intent.unitIds ?? ('units' in intent.command ? intent.command.units : []);
  if (raw.length <= 1) return [...raw];
  const seen = new Set<number>();
  const unique: number[] = [];
  for (const id of raw) {
    if (!seen.has(id)) {
      seen.add(id);
      unique.push(id);
    }
  }
  return unique;
}

function extractBuildingId(intent: BotIntent): number | undefined {
  if (intent.buildingId !== undefined) return intent.buildingId;
  if (intent.command.type === 'research' || intent.command.type === 'queue') {
    return intent.command.building;
  }
  return undefined;
}

function extractSpot(intent: BotIntent): { x: number; y: number; masterId: number } | undefined {
  if (intent.spot) {
    return { x: intent.spot.x, y: intent.spot.y, masterId: intent.spot.masterId };
  }
  if (intent.command.type === 'build') {
    return { x: intent.command.x, y: intent.command.y, masterId: intent.command.unitType };
  }
  return undefined;
}

function extractTargetId(command: Command): number | undefined {
  if (
    command.type === 'attack' ||
    command.type === 'work' ||
    command.type === 'repair' ||
    command.type === 'cancel'
  ) {
    return command.target;
  }
  return undefined;
}

function spotClearance(observation: BotObservation, masterId: number): { cx: number; cy: number } {
  const m = observation.enabledMasters[masterId];
  if (!m) return { cx: 1, cy: 1 };
  const cx = m.clearanceX > 0 ? m.clearanceX : m.radiusX > 0 ? m.radiusX : 1;
  const cy = m.clearanceY > 0 ? m.clearanceY : m.radiusY > 0 ? m.radiusY : 1;
  return { cx, cy };
}

function spotsOverlap(
  observation: BotObservation,
  a: { x: number; y: number; masterId: number },
  b: { x: number; y: number; masterId: number },
): boolean {
  const ca = spotClearance(observation, a.masterId);
  const cb = spotClearance(observation, b.masterId);
  return Math.abs(a.x - b.x) < ca.cx + cb.cx && Math.abs(a.y - b.y) < ca.cy + cb.cy;
}

function computeQueueExpectation(
  command: Command,
  ownBuildingsById: ReadonlyMap<number, ObservedOwnBuilding>,
): { expectedQueueCount: number | undefined; meta: QueuePendingMeta | undefined } {
  if (command.type !== 'queue') {
    return { expectedQueueCount: undefined, meta: undefined };
  }
  const b = ownBuildingsById.get(command.building);
  if (!b) {
    return {
      expectedQueueCount: Math.max(0, command.count),
      meta: { countDelta: command.count, switchesUnitType: false },
    };
  }
  const current = getEffectiveQueueCount(b);
  if (command.count > 0) {
    const lastQueued = b.queuedUnits[b.queuedUnits.length - 1];
    const hasDifferentLastQueued = Boolean(lastQueued && lastQueued.unit !== command.unit);
    const hasDifferentActiveUnit =
      b.queuedUnits.length === 0 && b.trainingUnit !== null && b.trainingUnit !== command.unit;
    const switchesUnitType = hasDifferentLastQueued || hasDifferentActiveUnit;
    return {
      expectedQueueCount: switchesUnitType ? command.count : current + command.count,
      meta: { countDelta: command.count, switchesUnitType },
    };
  }
  return {
    expectedQueueCount: Math.max(0, current + command.count),
    meta: { countDelta: command.count, switchesUnitType: false },
  };
}

function copyCost(cost: ResourceClaim | undefined): ResourceClaim {
  if (!cost) return {};
  const out: {
    food?: number;
    wood?: number;
    stone?: number;
    gold?: number;
    headroom?: number;
  } = {};
  if (cost.food !== undefined && cost.food > 0) out.food = cost.food;
  if (cost.wood !== undefined && cost.wood > 0) out.wood = cost.wood;
  if (cost.stone !== undefined && cost.stone > 0) out.stone = cost.stone;
  if (cost.gold !== undefined && cost.gold > 0) out.gold = cost.gold;
  if (cost.headroom !== undefined && cost.headroom > 0) out.headroom = cost.headroom;
  return out;
}

/**
 * Deterministic single-tick arbiter:
 * - Sorts by priority desc, lexicographical key asc, original order asc
 * - Enforces budget, unit/building/spot exclusivity, tech deduplication (`R03`), and `maxCommands`
 * - Rejected intents never mutate budget, claims, or `state.pending`
 */
export function arbitrateIntents(
  intents: readonly BotIntent[],
  observation: BotObservation,
  state: ArbiterState,
  maxCommands = MAX_COMMANDS_PER_BATCH,
): ArbiterResult {
  const effectiveMaxCommands =
    typeof maxCommands === 'number' && Number.isFinite(maxCommands) ? Math.max(0, Math.trunc(maxCommands)) : 0;

  const remaining = getAvailableBudget(observation, state);

  const activeKeys = new Set<string>();
  const activeTechs = new Set<number>();
  const claimedUnits = new Set<number>();
  const claimedBuildings = new Set<number>();
  const claimedSpots: { x: number; y: number; masterId: number }[] = [];

  for (const p of state.pending) {
    if (p.status !== 'issued') continue;
    activeKeys.add(p.key);
    if (p.techId !== undefined) activeTechs.add(p.techId);
    for (const uid of p.unitIds) claimedUnits.add(uid);
    if (p.buildingId !== undefined) claimedBuildings.add(p.buildingId);
    if (p.spot) claimedSpots.push(p.spot);
  }

  const ownUnitsById = new Map<number, ObservedOwnUnit>();
  for (const u of observation.ownUnits) ownUnitsById.set(u.id, u);

  const ownBuildingsById = new Map<number, ObservedOwnBuilding>();
  for (const b of observation.ownBuildings) {
    ownBuildingsById.set(b.id, b);
    if (isOwnBuildingAlive(b) && b.researchingTech !== null) {
      activeTechs.add(b.researchingTech);
    }
  }

  const indexed = intents.map((intent, index) => ({ intent, index }));
  indexed.sort((a, b) => {
    const aValidPri = typeof a.intent?.priority === 'number' && Number.isFinite(a.intent.priority);
    const bValidPri = typeof b.intent?.priority === 'number' && Number.isFinite(b.intent.priority);
    if (aValidPri !== bValidPri) return bValidPri ? 1 : -1;
    if (aValidPri && bValidPri && a.intent.priority !== b.intent.priority) {
      return b.intent.priority - a.intent.priority;
    }
    const aKey = typeof a.intent?.key === 'string' ? a.intent.key : '';
    const bKey = typeof b.intent?.key === 'string' ? b.intent.key : '';
    if (aKey !== bKey) return aKey < bKey ? -1 : 1;
    return a.index - b.index;
  });

  const accepted: BotIntent[] = [];
  const rejected: IntentOutcome[] = [];
  const outcomesByKey: Record<string, IntentOutcome> = {};
  const commands: Command[] = [];
  const seenKeysThisTick = new Set<string>();

  const recordReject = (key: string, reason: IntentRejectReason): void => {
    const outcome: IntentOutcome = { key, accepted: false, reason };
    rejected.push(outcome);
    if (!Object.hasOwn(outcomesByKey, key)) {
      outcomesByKey[key] = outcome;
    }
  };

  for (const { intent } of indexed) {
    const rawKey = typeof intent?.key === 'string' ? intent.key : '';

    if (!isValidIntent(intent)) {
      recordReject(rawKey, 'invalid-intent');
      continue;
    }

    if (activeKeys.has(intent.key) || seenKeysThisTick.has(intent.key)) {
      seenKeysThisTick.add(intent.key);
      recordReject(intent.key, 'duplicate-pending');
      continue;
    }
    seenKeysThisTick.add(intent.key);

    if (intent.command.type === 'research') {
      const techId = intent.command.tech;
      const techState = observation.techStates[techId];
      if (techState !== undefined && techState < TECH_AVAILABLE) {
        recordReject(intent.key, 'invalid-intent');
        continue;
      }
      if (
        activeTechs.has(techId) ||
        (techState ?? TECH_AVAILABLE) >= TECH_RESEARCHING
      ) {
        recordReject(intent.key, 'duplicate-pending');
        continue;
      }
    }

    if (accepted.length >= effectiveMaxCommands) {
      recordReject(intent.key, 'batch-limit-exceeded');
      continue;
    }

    const unitIds = extractUnitIds(intent);
    const hasUnitConflict = unitIds.some(
      (uid) => claimedUnits.has(uid) || (ownUnitsById.has(uid) && !isOwnUnitAlive(ownUnitsById.get(uid))),
    );
    if (hasUnitConflict) {
      recordReject(intent.key, 'unit-busy-or-claimed');
      continue;
    }

    const buildingId = extractBuildingId(intent);
    if (buildingId !== undefined) {
      if (claimedBuildings.has(buildingId)) {
        recordReject(intent.key, 'building-busy-or-claimed');
        continue;
      }
      const b = ownBuildingsById.get(buildingId);
      if (b) {
        if (!isOwnBuildingAlive(b) || b.isUnbuilt) {
          recordReject(intent.key, 'building-busy-or-claimed');
          continue;
        }
        if (
          intent.command.type === 'research' &&
          (b.researchingTech !== null ||
            b.trainingUnit !== null ||
            b.queueLength > 0 ||
            b.queuedUnits.length > 0 ||
            b.isBusy)
        ) {
          recordReject(intent.key, 'building-busy-or-claimed');
          continue;
        }
        if (intent.command.type === 'queue' && b.researchingTech !== null) {
          recordReject(intent.key, 'building-busy-or-claimed');
          continue;
        }
      }
    }

    const spot = extractSpot(intent);
    if (spot && claimedSpots.some((existing) => spotsOverlap(observation, spot, existing))) {
      recordReject(intent.key, 'spot-claimed');
      continue;
    }

    const needFood = intent.cost?.food ?? 0;
    const needWood = intent.cost?.wood ?? 0;
    const needStone = intent.cost?.stone ?? 0;
    const needGold = intent.cost?.gold ?? 0;
    const needHeadroom = intent.cost?.headroom ?? 0;

    if (
      remaining.food < needFood ||
      remaining.wood < needWood ||
      remaining.stone < needStone ||
      remaining.gold < needGold ||
      remaining.headroom < needHeadroom
    ) {
      recordReject(intent.key, 'insufficient-budget');
      continue;
    }

    // All checks passed: accept and reserve claims
    remaining.food -= needFood;
    remaining.wood -= needWood;
    remaining.stone -= needStone;
    remaining.gold -= needGold;
    remaining.headroom -= needHeadroom;

    activeKeys.add(intent.key);
    for (const uid of unitIds) claimedUnits.add(uid);
    if (buildingId !== undefined) claimedBuildings.add(buildingId);
    if (spot) claimedSpots.push(spot);

    const techId = intent.command.type === 'research' ? intent.command.tech : undefined;
    if (techId !== undefined) activeTechs.add(techId);

    const trainUnitId = intent.command.type === 'queue' ? intent.command.unit : undefined;
    const { expectedQueueCount, meta: queueMeta } = computeQueueExpectation(intent.command, ownBuildingsById);
    const targetId = extractTargetId(intent.command);

    const ttl = Math.max(MIN_PENDING_TTL_TURNS, Math.trunc(intent.ttlTurns ?? DEFAULT_PENDING_TTL_TURNS));
    const pendingAction: PendingAction = {
      key: intent.key,
      commandType: intent.command.type,
      issuedTurn: observation.turn,
      expectedApplyTurn: observation.turn + COMMAND_DELAY_TURNS,
      expiresTurn: observation.turn + ttl,
      cost: copyCost(intent.cost),
      unitIds,
      buildingId,
      spot,
      targetId,
      techId,
      trainUnitId,
      expectedQueueCount,
      status: 'issued',
    };
    if (queueMeta) {
      queuePendingMeta.set(pendingAction, queueMeta);
    }

    state.pending.push(pendingAction);
    accepted.push(intent);
    commands.push(intent.command);
    outcomesByKey[intent.key] = {
      key: intent.key,
      accepted: true,
      command: intent.command,
    };
  }

  return {
    accepted,
    rejected,
    outcomesByKey,
    commands,
  };
}

export function createPlannerInput(
  observation: BotObservation,
  profile: BotProfile,
  state: ArbiterState,
  plannerState: BotPlannerState,
  rngSeed: number,
): PlannerInput {
  return {
    observation,
    profile,
    state: plannerState,
    seed: rngSeed,
    pendingActions: [...state.pending],
  };
}

/**
 * Executes one deterministic two-phase planner cycle:
 * 1) `reconcilePending(observation, arbiterState)`
 * 2) `propose` across all planners (no command-dependent state mutations)
 * 3) `arbitrateIntents` across combined intents
 * 4) `commit(result.outcomesByKey, commitInput)` for every planner
 */
export function runProposeCommitCycle(
  planners: readonly BotPlanner[],
  observation: BotObservation,
  profile: BotProfile,
  arbiterState: ArbiterState,
  plannerState: BotPlannerState,
  rngSeed: number,
  maxCommands = MAX_COMMANDS_PER_BATCH,
): ArbiterResult {
  reconcilePending(observation, arbiterState);

  const proposeInput = createPlannerInput(observation, profile, arbiterState, plannerState, rngSeed);
  const proposed: BotIntent[] = [];
  for (const planner of planners) {
    const intents = planner.propose(proposeInput);
    if (intents.length > 0) proposed.push(...intents);
  }

  const result = arbitrateIntents(proposed, observation, arbiterState, maxCommands);
  const commitInput = createPlannerInput(observation, profile, arbiterState, plannerState, rngSeed);
  for (const planner of planners) {
    planner.commit(result.outcomesByKey, commitInput);
  }

  return result;
}
