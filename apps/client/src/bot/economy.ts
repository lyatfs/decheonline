import {
  ATTR_FOOD,
  ATTR_GOLD,
  ATTR_HEADROOM,
  ATTR_STONE,
  ATTR_WOOD,
  BUILDER,
  COMMAND_DELAY_TURNS,
  ELEPHANT,
  FARM,
  FORAGE,
  FORAGER,
  GAZELLE,
  GRANARY,
  HUNTER,
  LUMBERJACK,
  MINE_GOLD,
  MINE_STONE,
  MINER_GOLD,
  MINER_STONE,
  ObjectState,
  STORAGE_PIT,
  TOWN_CENTER,
  TREES,
  VILLAGER,
  WORK_FAILED,
} from '@aoe/sim';
import type { AvailableBudget } from './budget';
import { computeAgeReserve } from './research-planner';
import type {
  BotIntent,
  BotObservation,
  BotPlanner,
  IntentOutcome,
  ObservedMaster,
  ObservedOwnBuilding,
  ObservedOwnUnit,
  ObservedResource,
  PendingAction,
  PlannerInput,
  ResourceClaim,
} from './types';

const DOCK = 45;
const FISHING_BOAT = 13;
const FISHERMAN = 119;
const FARMER = 259;

const RESOURCE_GROUP_WOOD = 0;
const RESOURCE_GROUP_FORAGE = 1;
const RESOURCE_GROUP_FISH = 2;
const RESOURCE_GROUP_STONE = 3;
const RESOURCE_GROUP_GOLD = 4;

const SHORE_FISH_IDS = new Set<number>([260, 263]);
const ALL_FISH_IDS = new Set<number>([53, 260, 263, 370]);
const TREE_IDS = new Set<number>(TREES);

export const ECO_COOLDOWN_TURNS = COMMAND_DELAY_TURNS + 2;
export const FAILED_TARGET_BACKOFF_TURNS = 20;
export const MIN_ELEPHANT_HUNTERS = 3;
export const MAX_ELEPHANT_HUNTERS = 4;
export const MIN_ELEPHANT_HUNTER_HP = 18;
export const MIN_ELEPHANT_HUNTER_HP_RATIO = 0.65;
export const MIN_ACTIVE_HUNTER_HP = 12;
export const MIN_ACTIVE_HUNTER_HP_RATIO = 0.5;
export const MIN_ACTIVE_HUNTER_PARTY = 2;

const OFFSET_PROBES: readonly (readonly [number, number])[] = [
  [4, 0],
  [-4, 0],
  [0, 4],
  [0, -4],
  [4, 4],
  [-4, -4],
  [4, -4],
  [-4, 4],
  [7, 0],
  [-7, 0],
  [0, 7],
  [0, -7],
];

export function isProductiveFarm(building: ObservedOwnBuilding): boolean {
  if (building.type !== FARM) return false;
  if (building.isUnbuilt || building.hp <= 0 || building.state !== ObjectState.Active) {
    return false;
  }
  return (building.makeTimer !== null && building.makeTimer > 0) || building.heldAmount > 0;
}

export function isDepletedFarm(building: ObservedOwnBuilding): boolean {
  if (building.type !== FARM) return false;
  if (building.isUnbuilt && building.hp > 0 && building.state === ObjectState.Unbuilt) {
    return false;
  }
  return !isProductiveFarm(building);
}

function isOwnBuildingAlive(b: ObservedOwnBuilding): boolean {
  return b.hp > 0 && b.state < ObjectState.Dying;
}

function isOwnBuildingActive(b: ObservedOwnBuilding): boolean {
  return !b.isUnbuilt && b.hp > 0 && b.state === ObjectState.Active;
}

function isOwnUnitAlive(u: ObservedOwnUnit): boolean {
  return u.hp > 0 && u.state < ObjectState.Dying && u.inside === null;
}

function isTreeResource(r: ObservedResource, obs: BotObservation): boolean {
  if (TREE_IDS.has(r.type) || r.heldType === ATTR_WOOD) return true;
  if (r.type === GAZELLE || r.type === ELEPHANT || r.isDangerous || ALL_FISH_IDS.has(r.type)) {
    return false;
  }
  const m = obs.enabledMasters[r.type];
  return Boolean(m && m.trackAsResource === 1 && m.resourceGroup === RESOURCE_GROUP_WOOD);
}

function isForageResource(r: ObservedResource): boolean {
  return r.type === FORAGE || r.resourceGroup === RESOURCE_GROUP_FORAGE;
}

function isGoldResource(r: ObservedResource): boolean {
  return r.type === MINE_GOLD || r.resourceGroup === RESOURCE_GROUP_GOLD;
}

function isStoneResource(r: ObservedResource): boolean {
  return r.type === MINE_STONE || r.resourceGroup === RESOURCE_GROUP_STONE;
}

function isFishResource(r: ObservedResource): boolean {
  return ALL_FISH_IDS.has(r.type) || r.resourceGroup === RESOURCE_GROUP_FISH;
}

function isShoreFishResource(r: ObservedResource): boolean {
  return SHORE_FISH_IDS.has(r.type);
}

function computeAvailableBudget(
  obs: BotObservation,
  pendingActions: readonly PendingAction[],
): AvailableBudget {
  let foodClaimed = 0;
  let woodClaimed = 0;
  let stoneClaimed = 0;
  let goldClaimed = 0;
  let headroomClaimed = 0;

  for (const p of pendingActions) {
    if (p.status !== 'issued') continue;
    foodClaimed += p.cost.food ?? 0;
    woodClaimed += p.cost.wood ?? 0;
    stoneClaimed += p.cost.stone ?? 0;
    goldClaimed += p.cost.gold ?? 0;
    headroomClaimed += p.cost.headroom ?? 0;
  }

  return {
    food: Math.max(0, obs.resources.food - foodClaimed),
    wood: Math.max(0, obs.resources.wood - woodClaimed),
    stone: Math.max(0, obs.resources.stone - stoneClaimed),
    gold: Math.max(0, obs.resources.gold - goldClaimed),
    headroom: Math.max(0, obs.population.headroom - headroomClaimed),
  };
}

function getMasterCostClaim(
  master: ObservedMaster | undefined,
  includeHeadroom: boolean,
): ResourceClaim | null {
  if (!master || !master.enabled) return null;
  let food = 0;
  let wood = 0;
  let stone = 0;
  let gold = 0;
  let headroom = 0;

  for (const c of master.costs) {
    if (c.flag !== 0) {
      if (c.type === ATTR_FOOD) food += c.amount;
      else if (c.type === ATTR_WOOD) wood += c.amount;
      else if (c.type === ATTR_STONE) stone += c.amount;
      else if (c.type === ATTR_GOLD) gold += c.amount;
    } else if (includeHeadroom && c.type === ATTR_HEADROOM && c.amount > 0) {
      headroom += c.amount;
    }
  }
  if (includeHeadroom && headroom === 0) {
    headroom = 1;
  }

  return {
    ...(food > 0 ? { food } : {}),
    ...(wood > 0 ? { wood } : {}),
    ...(stone > 0 ? { stone } : {}),
    ...(gold > 0 ? { gold } : {}),
    ...(headroom > 0 ? { headroom } : {}),
  };
}

function canAffordClaim(budget: AvailableBudget, claim: ResourceClaim): boolean {
  return (
    budget.food >= (claim.food ?? 0) &&
    budget.wood >= (claim.wood ?? 0) &&
    budget.stone >= (claim.stone ?? 0) &&
    budget.gold >= (claim.gold ?? 0) &&
    budget.headroom >= (claim.headroom ?? 0)
  );
}

function spendLocalBudget(budget: AvailableBudget, claim: ResourceClaim): void {
  budget.food -= claim.food ?? 0;
  budget.wood -= claim.wood ?? 0;
  budget.stone -= claim.stone ?? 0;
  budget.gold -= claim.gold ?? 0;
  budget.headroom -= claim.headroom ?? 0;
}

function getBuildingReachRange(obs: BotObservation, b: ObservedOwnBuilding): number {
  const m = obs.enabledMasters[b.type];
  if (!m) return 3.0;
  return Math.max(m.clearanceX, m.clearanceY, m.radiusX, m.radiusY) + 1.5;
}

function spotClearance(obs: BotObservation, masterId: number): { cx: number; cy: number } {
  const m = obs.enabledMasters[masterId];
  if (!m) return { cx: 1.5, cy: 1.5 };
  return {
    cx: m.clearanceX > 0 ? m.clearanceX : m.radiusX > 0 ? m.radiusX : 1,
    cy: m.clearanceY > 0 ? m.clearanceY : m.radiusY > 0 ? m.radiusY : 1,
  };
}

function spotsOverlap(
  obs: BotObservation,
  a: { x: number; y: number; masterId: number },
  b: { x: number; y: number; masterId: number },
): boolean {
  const ca = spotClearance(obs, a.masterId);
  const cb = spotClearance(obs, b.masterId);
  return Math.abs(a.x - b.x) < ca.cx + cb.cx && Math.abs(a.y - b.y) < ca.cy + cb.cy;
}

function findNonOverlappingPlacement(
  obs: BotObservation,
  masterId: number,
  nearX: number,
  nearY: number,
  maxRadius: number,
  actorId: number,
  reservedSpots: readonly { x: number; y: number; masterId: number }[],
): { x: number; y: number } | null {
  const primary = obs.findBuildPlacement(masterId, nearX, nearY, maxRadius, actorId);
  if (primary && !reservedSpots.some((s) => spotsOverlap(obs, { ...primary, masterId }, s))) {
    return primary;
  }

  for (const [dx, dy] of OFFSET_PROBES) {
    const px = Math.min(obs.mapWidth - 2, Math.max(2, nearX + dx));
    const py = Math.min(obs.mapHeight - 2, Math.max(2, nearY + dy));
    const candidate = obs.findBuildPlacement(masterId, px, py, Math.min(maxRadius, 12), actorId);
    if (candidate && !reservedSpots.some((s) => spotsOverlap(obs, { ...candidate, masterId }, s))) {
      return candidate;
    }
  }

  return null;
}

function sortByDistSq<T extends { id: number; x: number; y: number }>(
  items: readonly T[],
  x: number,
  y: number,
): T[] {
  return [...items].sort((a, b) => {
    const da = (a.x - x) * (a.x - x) + (a.y - y) * (a.y - y);
    const db = (b.x - x) * (b.x - x) + (b.y - y) * (b.y - y);
    if (da !== db) return da - db;
    return a.id - b.id;
  });
}

function hasReachableDropSite(
  obs: BotObservation,
  actorId: number,
  actorX: number,
  actorY: number,
  dropSites: readonly ObservedOwnBuilding[],
): boolean {
  if (dropSites.length === 0) return false;
  const zoneMatches = dropSites.filter((d) =>
    obs.canReach(actorId, d.x, d.y, getBuildingReachRange(obs, d), false),
  );
  if (zoneMatches.length === 0) return false;
  const sorted = sortByDistSq(zoneMatches, actorX, actorY);
  const limit = Math.min(sorted.length, 4);
  for (let i = 0; i < limit; i++) {
    const d = sorted[i]!;
    if (obs.canReach(actorId, d.x, d.y, getBuildingReachRange(obs, d), true)) {
      return true;
    }
  }
  return false;
}

function pickNearestReachableResource(
  obs: BotObservation,
  actor: ObservedOwnUnit,
  candidates: readonly ObservedResource[],
  dropSites: readonly ObservedOwnBuilding[],
  range = 1.5,
): ObservedResource | null {
  if (candidates.length === 0) return null;
  if (!hasReachableDropSite(obs, actor.id, actor.x, actor.y, dropSites)) return null;

  const zoneMatches = candidates.filter((r) => obs.canReach(actor.id, r.x, r.y, range, false));
  if (zoneMatches.length === 0) return null;

  const sorted = sortByDistSq(zoneMatches, actor.x, actor.y);
  const limit = Math.min(sorted.length, 12);
  for (let i = 0; i < limit; i++) {
    const r = sorted[i]!;
    if (obs.canReach(actor.id, r.x, r.y, range, true)) {
      return r;
    }
  }
  return null;
}

function hasAnyReachableCandidate(
  obs: BotObservation,
  actor: ObservedOwnUnit,
  candidates: readonly ObservedResource[],
  dropSites: readonly ObservedOwnBuilding[],
  range = 1.5,
): boolean {
  return pickNearestReachableResource(obs, actor, candidates, dropSites, range) !== null;
}

function isHealthyForElephantHunt(u: ObservedOwnUnit): boolean {
  const maxHp = Math.max(1, u.maxHp);
  return u.hp >= Math.min(maxHp, MIN_ELEPHANT_HUNTER_HP) && u.hp / maxHp >= MIN_ELEPHANT_HUNTER_HP_RATIO;
}

function isSafeToContinueElephantHunt(u: ObservedOwnUnit): boolean {
  const maxHp = Math.max(1, u.maxHp);
  return u.hp >= Math.min(maxHp, MIN_ACTIVE_HUNTER_HP) && u.hp / maxHp >= MIN_ACTIVE_HUNTER_HP_RATIO;
}

function getEffectiveQueueCount(b: ObservedOwnBuilding): number {
  let queuedTotal = 0;
  for (const q of b.queuedUnits) {
    if (q.count > 0) queuedTotal += q.count;
  }
  return Math.max(b.queueLength, queuedTotal, b.trainingUnit !== null ? 1 : 0);
}

function computeDesiredFarms(
  obs: BotObservation,
  villagerCount: number,
  targetFarmsCap: number,
): number {
  if (targetFarmsCap <= 0 || villagerCount <= 0) return 0;
  const scaled = villagerCount <= 2 ? villagerCount : Math.max(2, Math.floor(villagerCount * 0.6));
  return Math.min(targetFarmsCap, scaled);
}

export class EconomyPlanner implements BotPlanner {
  readonly name = 'economy';

  propose(input: PlannerInput): BotIntent[] {
    const { observation: obs, profile, state, pendingActions, seed } = input;
    const turn = obs.turn;
    const intents: BotIntent[] = [];

    const localBudget = computeAvailableBudget(obs, pendingActions);

    const reservedUnits = new Set<number>();
    const reservedBuildings = new Set<number>();
    const reservedSpots: { x: number; y: number; masterId: number }[] = [];
    const pendingWorkTargets = new Map<number, number>();
    const pendingQueueCountByBuilding = new Map<number, number>();
    let pendingVillagerQueues = 0;
    let pendingBoatQueues = 0;
    let pendingFarmBuilds = 0;
    let pendingGranaryBuilds = 0;
    let pendingStorageBuilds = 0;
    let pendingDockBuilds = 0;

    for (const p of pendingActions) {
      if (p.status !== 'issued') continue;
      for (const uid of p.unitIds) reservedUnits.add(uid);
      if (p.buildingId !== undefined) reservedBuildings.add(p.buildingId);
      if (p.spot) {
        reservedSpots.push(p.spot);
        if (p.spot.masterId === FARM) pendingFarmBuilds++;
        else if (p.spot.masterId === GRANARY) pendingGranaryBuilds++;
        else if (p.spot.masterId === STORAGE_PIT) pendingStorageBuilds++;
        else if (p.spot.masterId === DOCK) pendingDockBuilds++;
      }
      if (p.commandType === 'work' && p.targetId !== undefined) {
        pendingWorkTargets.set(p.targetId, (pendingWorkTargets.get(p.targetId) ?? 0) + p.unitIds.length);
      }
      if (p.commandType === 'queue' && p.buildingId !== undefined) {
        pendingQueueCountByBuilding.set(
          p.buildingId,
          (pendingQueueCountByBuilding.get(p.buildingId) ?? 0) + 1,
        );
        if (p.trainUnitId === VILLAGER) pendingVillagerQueues++;
        else if (p.trainUnitId === FISHING_BOAT) pendingBoatQueues++;
      }
    }

    const aliveUnits = obs.ownUnits.filter(isOwnUnitAlive);
    const villagers = aliveUnits.filter((u) => u.isVillager);
    const fishingBoats = aliveUnits.filter((u) => u.type === FISHING_BOAT);

    const aliveBuildings = obs.ownBuildings.filter(isOwnBuildingAlive);
    const activeBuildings = aliveBuildings.filter(isOwnBuildingActive);
    const unbuiltBuildings = aliveBuildings.filter((b) => b.isUnbuilt && b.state === ObjectState.Unbuilt);

    const activeTCs = activeBuildings.filter((b) => b.type === TOWN_CENTER);
    const activeGranaries = activeBuildings.filter((b) => b.type === GRANARY);
    const activeStoragePits = activeBuildings.filter((b) => b.type === STORAGE_PIT);
    const activeDocks = activeBuildings.filter((b) => b.type === DOCK);
    const productiveFarms = activeBuildings.filter(isProductiveFarm);
    const unbuiltFarms = unbuiltBuildings.filter((b) => b.type === FARM);

    const foodBerryDropSites = [...activeTCs, ...activeGranaries];
    const generalDropSites = [...activeTCs, ...activeStoragePits];

    const primaryTC = activeTCs[0] ?? aliveBuildings.find((b) => b.type === TOWN_CENTER);
    const anchorX = primaryTC ? primaryTC.x : (villagers[0]?.x ?? Math.floor(obs.mapWidth / 2));
    const anchorY = primaryTC ? primaryTC.y : (villagers[0]?.y ?? Math.floor(obs.mapHeight / 2));

    const depletedSet = new Set<number>(state.depletedResourceIds);
    const isTargetAvailable = (id: number): boolean => {
      if (depletedSet.has(id)) return false;
      const failed = state.failedTargets[id];
      return !failed || failed.retryAfterTurn <= turn;
    };

    const validResources = obs.knownResources.filter(
      (r) =>
        r.heldAmount > 0 &&
        r.state < ObjectState.PendingRemoval &&
        isTargetAvailable(r.id),
    );
    const berries = validResources.filter(isForageResource);
    const trees = validResources.filter((r) => isTreeResource(r, obs));
    const goldMines = validResources.filter(isGoldResource);
    const stoneMines = validResources.filter(isStoneResource);
    const gazelles = validResources.filter(
      (r) => r.type === GAZELLE && r.state === ObjectState.Active,
    );
    const elephants = validResources.filter(
      (r) => r.type === ELEPHANT && r.state === ObjectState.Active,
    );
    const shoreFish = validResources.filter(isShoreFishResource);
    const allFish = validResources.filter(isFishResource);

    const isUnitReady = (u: ObservedOwnUnit): boolean =>
      !reservedUnits.has(u.id) && (state.unitCooldownUntil[u.id] ?? 0) <= turn;

    const isIdleVillager = (v: ObservedOwnUnit): boolean =>
      isUnitReady(v) && !v.isWorkActive && !v.isMoving && !v.isActivelyEngaged;

    const isBuildingReady = (b: ObservedOwnBuilding): boolean =>
      isOwnBuildingActive(b) &&
      !reservedBuildings.has(b.id) &&
      b.researchingTech === null &&
      (state.buildingCooldownUntil[b.id] ?? 0) <= turn;

    const emitIntent = (intent: BotIntent): void => {
      intents.push(intent);
      for (const uid of intent.unitIds ?? []) reservedUnits.add(uid);
      if (intent.buildingId !== undefined) reservedBuildings.add(intent.buildingId);
      if (intent.spot) reservedSpots.push(intent.spot);
      if (intent.cost) spendLocalBudget(localBudget, intent.cost);
    };

    // 0. Safety check: cancel/retarget active Elephant hunters when hunt becomes unsafe
    const aliveElephantById = new Map<number, ObservedResource>(elephants.map((el) => [el.id, el]));
    const activeHuntersByElephant = new Map<number, ObservedOwnUnit[]>();
    for (const v of villagers) {
      if (v.isWorkActive && v.workTarget !== null && aliveElephantById.has(v.workTarget)) {
        const list = activeHuntersByElephant.get(v.workTarget) ?? [];
        list.push(v);
        activeHuntersByElephant.set(v.workTarget, list);
      }
    }

    for (const [elephantId, hunters] of activeHuntersByElephant) {
      const el = aliveElephantById.get(elephantId)!;
      const healthyReachableCount = hunters.filter(
        (h) =>
          isSafeToContinueElephantHunt(h) &&
          obs.canReach(h.id, el.x, el.y, 1.5, false),
      ).length;

      for (const hunter of hunters) {
        const hunterSafe =
          profile.allowElephantHunt &&
          isSafeToContinueElephantHunt(hunter) &&
          healthyReachableCount >= MIN_ACTIVE_HUNTER_PARTY &&
          obs.canReach(hunter.id, el.x, el.y, 1.5, false);

        if (hunterSafe || !isUnitReady(hunter)) continue;

        const safeTarget =
          pickNearestReachableResource(obs, hunter, berries, foodBerryDropSites, 1.5) ??
          pickNearestReachableResource(obs, hunter, gazelles, generalDropSites, 1.5) ??
          pickNearestReachableResource(obs, hunter, trees, generalDropSites, 1.5) ??
          pickNearestReachableResource(obs, hunter, goldMines, generalDropSites, 1.5) ??
          pickNearestReachableResource(obs, hunter, stoneMines, generalDropSites, 1.5);

        if (safeTarget) {
          emitIntent({
            key: `eco:cancel-hunt:${hunter.id}:${elephantId}`,
            priority: 96,
            reason: 'Retarget villager from unsafe elephant hunt to safe resource',
            unitIds: [hunter.id],
            command: {
              type: 'work',
              units: [hunter.id],
              target: safeTarget.id,
              x: safeTarget.x,
              y: safeTarget.y,
            },
          });
        } else {
          emitIntent({
            key: `eco:retreat-hunt:${hunter.id}:${elephantId}`,
            priority: 96,
            reason: 'Retreat villager from unsafe elephant hunt',
            unitIds: [hunter.id],
            command: {
              type: 'move',
              units: [hunter.id],
              x: anchorX,
              y: anchorY,
            },
          });
        }
      }
    }

    // 1. Villager training at active Town Centers (prioritized above expensive military when recovering)
    const villagerMaster = obs.enabledMasters[VILLAGER];
    const villagerCost = getMasterCostClaim(villagerMaster, true);
    const ageReserve = computeAgeReserve(obs, localBudget, villagers.length, pendingActions);
    if (villagerCost && !(ageReserve.food && villagers.length >= 5) && villagers.length + pendingVillagerQueues < profile.targetVillagers) {
      const recoveringEco =
        villagers.length < Math.min(profile.targetVillagers, 8) || localBudget.food < 150;
      const villagerPriority = recoveringEco ? 95 : 90;

      for (const tc of activeTCs) {
        if (villagers.length + pendingVillagerQueues >= profile.targetVillagers) break;
        if (!isBuildingReady(tc)) continue;
        const queued = getEffectiveQueueCount(tc) + (pendingQueueCountByBuilding.get(tc.id) ?? 0);
        if (queued >= 2) continue;
        if (!canAffordClaim(localBudget, villagerCost)) break;

        pendingVillagerQueues++;
        emitIntent({
          key: `eco:queue:villager:${tc.id}`,
          priority: villagerPriority,
          reason: recoveringEco
            ? 'Recover villager economy ahead of military'
            : 'Maintain villager production',
          cost: villagerCost,
          buildingId: tc.id,
          command: { type: 'queue', building: tc.id, unit: VILLAGER, count: 1 },
        });
      }
    }

    // Track current worker allocations
    const workedTargets = new Set<number>(pendingWorkTargets.keys());
    let foodWorkers = 0;
    let woodWorkers = 0;
    let goldWorkers = 0;
    let stoneWorkers = 0;

    for (const v of villagers) {
      if (!v.isWorkActive) continue;
      if (v.workTarget !== null) workedTargets.add(v.workTarget);
      if (v.type === FORAGER || v.type === HUNTER || v.type === FISHERMAN || v.type === FARMER) {
        foodWorkers++;
      } else if (v.type === LUMBERJACK) {
        woodWorkers++;
      } else if (v.type === MINER_GOLD) {
        goldWorkers++;
      } else if (v.type === MINER_STONE) {
        stoneWorkers++;
      }
    }

    const pickBuilder = (nearX: number, nearY: number): ObservedOwnUnit | null => {
      const idle = villagers.filter(isIdleVillager);
      if (idle.length > 0) return sortByDistSq(idle, nearX, nearY)[0] ?? null;
      const fallback = villagers.filter(
        (v) =>
          isUnitReady(v) &&
          !(v.type === BUILDER && v.isWorkActive) &&
          v.type !== HUNTER &&
          !(v.type === FARMER && v.isWorkActive),
      );
      return sortByDistSq(fallback, nearX, nearY)[0] ?? null;
    };

    const refVillager = villagers[0];
    const naturalEasyFoodExhausted = refVillager
      ? !villagers.some(
          (v) =>
            hasAnyReachableCandidate(obs, v, berries, foodBerryDropSites, 1.5) ||
            hasAnyReachableCandidate(obs, v, gazelles, generalDropSites, 1.5) ||
            hasAnyReachableCandidate(obs, v, shoreFish, generalDropSites, 1.5),
        )
      : true;

    // 2. Farm construction & multi-cycle replenishment (E01, E02)
    // Only productive + unbuilt + pending farms count; empty/dead farms NEVER block target count!
    const farmMaster = obs.enabledMasters[FARM];
    const farmCost = getMasterCostClaim(farmMaster, false);
    const activeOrPlannedFarms =
      productiveFarms.length + unbuiltFarms.length + pendingFarmBuilds;
    const desiredFarms = computeDesiredFarms(obs, villagers.length, profile.targetFarms);
    const farmAnchor = activeGranaries[0] ?? primaryTC;
    const farmNearX = farmAnchor ? farmAnchor.x : anchorX;
    const farmNearY = farmAnchor ? farmAnchor.y : anchorY;

    const shouldBuildFarm =
      farmCost !== null &&
      pendingFarmBuilds === 0 &&
      activeOrPlannedFarms < desiredFarms &&
      villagers.length >= 1 &&
      (naturalEasyFoodExhausted ||
        (villagers.length >= 5 &&
          (localBudget.food < 500 ||
            (obs.age >= 2 && activeOrPlannedFarms < Math.min(desiredFarms, 3)))));

    if (shouldBuildFarm && farmCost && canAffordClaim(localBudget, farmCost)) {
      const builderCandidates = sortByDistSq(
        villagers.filter(
          (v) =>
            isUnitReady(v) &&
            !(v.type === BUILDER && v.isWorkActive) &&
            v.type !== HUNTER &&
            hasReachableDropSite(obs, v.id, v.x, v.y, foodBerryDropSites),
        ),
        farmNearX,
        farmNearY,
      );
      const idleFirst = [
        ...builderCandidates.filter(isIdleVillager),
        ...builderCandidates.filter((v) => !isIdleVillager(v)),
      ];

      for (const builder of idleFirst) {
        const spot = findNonOverlappingPlacement(
          obs,
          FARM,
          farmNearX,
          farmNearY,
          24,
          builder.id,
          reservedSpots,
        );
        if (!spot) continue;
        emitIntent({
          key: `eco:build:farm:${spot.x}:${spot.y}`,
          priority: naturalEasyFoodExhausted || localBudget.food < 200 ? 92 : 88,
          reason:
            productiveFarms.length === 0
              ? 'Build replacement farm for sustainable food'
              : 'Expand farm production',
          cost: farmCost,
          unitIds: [builder.id],
          spot: { x: spot.x, y: spot.y, masterId: FARM },
          command: {
            type: 'build',
            units: [builder.id],
            unitType: FARM,
            x: spot.x,
            y: spot.y,
          },
        });
        break;
      }
    }

    // 3. Assign idle villagers to finish unbuilt buildings
    for (const b of unbuiltBuildings) {
      const maxBuilders = b.type === FARM ? 1 : 2;
      const activeBuilders = villagers.filter(
        (v) => v.isWorkActive && v.workTarget === b.id,
      ).length;
      const pendingBuilders = pendingWorkTargets.get(b.id) ?? 0;
      if (activeBuilders + pendingBuilders >= maxBuilders) continue;

      const range = getBuildingReachRange(obs, b);
      const candidates = sortByDistSq(
        villagers.filter(
          (v) => isIdleVillager(v) && obs.canReach(v.id, b.x, b.y, range, true),
        ),
        b.x,
        b.y,
      );
      const builder = candidates[0];
      if (!builder) continue;

      emitIntent({
        key: `eco:work:build:${builder.id}:${b.id}`,
        priority: b.type === FARM || b.type === TOWN_CENTER ? 89 : 87,
        reason: 'Finish unbuilt building foundation',
        unitIds: [builder.id],
        command: { type: 'work', units: [builder.id], target: b.id, x: b.x, y: b.y },
      });
    }

    // 4. Assign unworked productive Farms first (never assign depleted/empty farms!)
    const unworkedFarms = productiveFarms.filter((f) => !workedTargets.has(f.id));
    for (const farm of unworkedFarms) {
      const range = getBuildingReachRange(obs, farm);
      const idleCandidates = sortByDistSq(
        villagers.filter(
          (v) =>
            isIdleVillager(v) &&
            obs.canReach(v.id, farm.x, farm.y, range, true) &&
            hasReachableDropSite(obs, v.id, v.x, v.y, foodBerryDropSites),
        ),
        farm.x,
        farm.y,
      );

      let chosen = idleCandidates[0];
      // If no idle villager is available and food is needed, reassign a non-critical gatherer
      if (!chosen && (foodWorkers < Math.max(1, Math.ceil(villagers.length * 0.45)) || localBudget.food < 400)) {
        const reassignPool = sortByDistSq(
          villagers.filter(
            (v) =>
              isUnitReady(v) &&
              !(v.type === BUILDER && v.isWorkActive) &&
              v.type !== FARMER &&
              v.type !== FORAGER &&
              v.type !== HUNTER &&
              (v.type !== LUMBERJACK || woodWorkers > 1 || localBudget.wood >= 150) &&
              obs.canReach(v.id, farm.x, farm.y, range, true) &&
              hasReachableDropSite(obs, v.id, v.x, v.y, foodBerryDropSites),
          ),
          farm.x,
          farm.y,
        );
        chosen = reassignPool[0];
      }

      if (!chosen) continue;
      workedTargets.add(farm.id);
      foodWorkers++;
      emitIntent({
        key: `eco:work:farm:${chosen.id}:${farm.id}`,
        priority: 86,
        reason: 'Assign villager to productive Farm',
        unitIds: [chosen.id],
        command: { type: 'work', units: [chosen.id], target: farm.id, x: farm.x, y: farm.y },
      });
    }

    // 5. Safe Elephant Group Hunting (E04)
    const idleAfterFarms = villagers.filter(isIdleVillager);
    const wantsMoreFood =
      foodWorkers < Math.max(2, Math.ceil(villagers.length * 0.55)) || localBudget.food < 500;

    if (
      profile.allowElephantHunt &&
      idleAfterFarms.length > 0 &&
      elephants.length > 0 &&
      villagers.length >= MIN_ELEPHANT_HUNTERS &&
      wantsMoreFood
    ) {
      const ref = idleAfterFarms[0]!;
      const hasSafeEasyFood =
        hasAnyReachableCandidate(obs, ref, berries, foodBerryDropSites, 1.5) ||
        hasAnyReachableCandidate(obs, ref, gazelles, generalDropSites, 1.5) ||
        hasAnyReachableCandidate(obs, ref, shoreFish, generalDropSites, 1.5);

      if (!hasSafeEasyFood) {
        const candidateElephants = sortByDistSq(
          elephants.filter((el) => obs.canReach(ref.id, el.x, el.y, 1.5, false)),
          ref.x,
          ref.y,
        );
        for (const el of candidateElephants) {
          if (!hasReachableDropSite(obs, ref.id, ref.x, ref.y, generalDropSites)) continue;
          if (!obs.canReach(ref.id, el.x, el.y, 1.5, true)) continue;

          const existingHunters = activeHuntersByElephant.get(el.id) ?? [];
          const existingHealthy = existingHunters.filter((h) =>
            isSafeToContinueElephantHunt(h),
          ).length;

          if (existingHealthy >= MIN_ACTIVE_HUNTER_PARTY) {
            // Safe to reinforce with healthy idle villager
            const healthyIdle = idleAfterFarms.filter(
              (v) =>
                isHealthyForElephantHunt(v) &&
                obs.canReach(v.id, el.x, el.y, 1.5, true) &&
                hasReachableDropSite(obs, v.id, v.x, v.y, generalDropSites),
            );
            const reinforce = sortByDistSq(healthyIdle, el.x, el.y)[0];
            if (reinforce) {
              foodWorkers++;
              emitIntent({
                key: `eco:hunt:reinforce:${reinforce.id}:${el.id}`,
                priority: 82,
                reason: 'Reinforce established safe Elephant hunting party',
                unitIds: [reinforce.id],
                command: {
                  type: 'work',
                  units: [reinforce.id],
                  target: el.id,
                  x: el.x,
                  y: el.y,
                },
              });
            }
            break;
          }

          // Initiate a new coordinated hunting party of >= MIN_ELEPHANT_HUNTERS healthy reachable villagers
          const party: ObservedOwnUnit[] = sortByDistSq(
            idleAfterFarms.filter(
              (v) =>
                isHealthyForElephantHunt(v) &&
                obs.canReach(v.id, el.x, el.y, 1.5, true) &&
                hasReachableDropSite(obs, v.id, v.x, v.y, generalDropSites),
            ),
            el.x,
            el.y,
          ).slice(0, MAX_ELEPHANT_HUNTERS);

          if (party.length < MIN_ELEPHANT_HUNTERS) {
            const extras = sortByDistSq(
              villagers.filter(
                (v) =>
                  !party.some((p) => p.id === v.id) &&
                  isUnitReady(v) &&
                  isHealthyForElephantHunt(v) &&
                  !(v.type === BUILDER && v.isWorkActive) &&
                  v.type !== HUNTER &&
                  !(v.type === FARMER && v.isWorkActive) &&
                  obs.canReach(v.id, el.x, el.y, 1.5, true) &&
                  hasReachableDropSite(obs, v.id, v.x, v.y, generalDropSites),
              ),
              el.x,
              el.y,
            );
            while (party.length < MIN_ELEPHANT_HUNTERS && extras.length > 0) {
              party.push(extras.shift()!);
            }
          }

          if (party.length >= MIN_ELEPHANT_HUNTERS) {
            const unitIds = party.map((p) => p.id);
            foodWorkers += unitIds.length;
            emitIntent({
              key: `eco:hunt:party:${el.id}:${unitIds.join(',')}`,
              priority: 83,
              reason: 'Dispatch coordinated healthy hunting party for Elephant',
              unitIds,
              command: { type: 'work', units: unitIds, target: el.id, x: el.x, y: el.y },
            });
            break;
          }
        }
      }
    }

    // 6. Individual Idle Villager Resource Assignment & Source Switching (E03)
    const remainingIdle = villagers.filter(isIdleVillager);
    const villagerIdSet = new Set<number>(villagers.map((v) => v.id));
    let activeExploreVillagers = villagers.filter((v) => !v.isWorkActive && v.isMoving).length;
    for (const p of pendingActions) {
      if (p.status === 'issued' && p.commandType === 'move' && p.unitIds.some((id) => villagerIdSet.has(id))) {
        activeExploreVillagers++;
      }
    }
    for (const v of remainingIdle) {
      const bestBerry = pickNearestReachableResource(obs, v, berries, foodBerryDropSites, 1.5);
      const bestGazelle = pickNearestReachableResource(obs, v, gazelles, generalDropSites, 1.5);
      const bestShoreFish = pickNearestReachableResource(obs, v, shoreFish, generalDropSites, 1.5);
      const bestTree = pickNearestReachableResource(obs, v, trees, generalDropSites, 1.5);
      const bestGold = pickNearestReachableResource(obs, v, goldMines, generalDropSites, 1.5);
      const bestStone = pickNearestReachableResource(obs, v, stoneMines, generalDropSites, 1.5);
      const bestSafeFood = bestBerry ?? bestShoreFish ?? bestGazelle;

      const desiredFoodWorkers = Math.max(2, Math.ceil(villagers.length * 0.45));
      const desiredWoodWorkers = Math.max(2, Math.ceil(villagers.length * 0.3));

      const needFood =
        bestSafeFood !== null &&
        (foodWorkers < desiredFoodWorkers ||
          (localBudget.food < 500 && foodWorkers <= woodWorkers + 1));
      const needGold =
        bestGold !== null &&
        ((obs.age >= 2 && goldWorkers < 3) ||
          (localBudget.gold < 800 && obs.age >= 3 && goldWorkers < 4));
      const needWood =
        bestTree !== null && (woodWorkers < desiredWoodWorkers || localBudget.wood < 200);
      const needStone = bestStone !== null && stoneWorkers < 2;

      let chosen: ObservedResource | null = null;
      if (needFood) {
        chosen = bestSafeFood;
        if (chosen) foodWorkers++;
      } else if (needWood) {
        chosen = bestTree;
        if (chosen) woodWorkers++;
      } else if (needGold) {
        chosen = bestGold;
        if (chosen) goldWorkers++;
      } else if (bestSafeFood !== null) {
        chosen = bestSafeFood;
        if (chosen) foodWorkers++;
      } else if (bestTree !== null) {
        chosen = bestTree;
        if (chosen) woodWorkers++;
      } else if (bestGold !== null && obs.age >= 2) {
        chosen = bestGold;
        if (chosen) goldWorkers++;
      } else if (needStone || bestStone !== null) {
        chosen = bestStone;
        if (chosen) stoneWorkers++;
      } else if (bestGold !== null) {
        chosen = bestGold;
        if (chosen) goldWorkers++;
      }

      if (chosen) {
        emitIntent({
          key: `eco:work:gather:${v.id}:${chosen.id}`,
          priority: 84,
          reason: 'Assign idle villager to reachable resource with valid drop-off',
          unitIds: [v.id],
          command: { type: 'work', units: [v.id], target: chosen.id, x: chosen.x, y: chosen.y },
        });
      } else if (activeExploreVillagers < 2) {
        const exploreDest = obs.findNearestExploreTarget(v.id, seed + v.id + turn);
        if (exploreDest) {
          activeExploreVillagers++;
          emitIntent({
            key: `eco:explore:${v.id}:${turn}`,
            priority: 45,
            reason: 'Explore fog for new resources when known resources are depleted',
            unitIds: [v.id],
            command: { type: 'move', units: [v.id], x: exploreDest.x, y: exploreDest.y },
          });
        }
      }
    }

    // 7. Economy drop-off buildings (Granary / Storage Pit) when missing and wood reserve allows
    const granaryCount =
      aliveBuildings.filter((b) => b.type === GRANARY).length + pendingGranaryBuilds;
    const storageCount =
      aliveBuildings.filter((b) => b.type === STORAGE_PIT).length + pendingStorageBuilds;
    const granaryCost = getMasterCostClaim(obs.enabledMasters[GRANARY], false);
    const storageCost = getMasterCostClaim(obs.enabledMasters[STORAGE_PIT], false);

    if (
      granaryCount === 0 &&
      granaryCost &&
      villagers.length >= 3 &&
      canAffordClaim(localBudget, granaryCost) &&
      (!shouldBuildFarm || localBudget.wood >= (granaryCost.wood ?? 0) + 75)
    ) {
      const builder = pickBuilder(anchorX, anchorY);
      if (builder) {
        const spot = findNonOverlappingPlacement(
          obs,
          GRANARY,
          anchorX,
          anchorY,
          16,
          builder.id,
          reservedSpots,
        );
        if (spot) {
          emitIntent({
            key: `eco:build:granary:${spot.x}:${spot.y}`,
            priority: 78,
            reason: 'Build Granary for food drop-off and Farm support',
            cost: granaryCost,
            unitIds: [builder.id],
            spot: { x: spot.x, y: spot.y, masterId: GRANARY },
            command: {
              type: 'build',
              units: [builder.id],
              unitType: GRANARY,
              x: spot.x,
              y: spot.y,
            },
          });
        }
      }
    }

    if (
      storageCount === 0 &&
      storageCost &&
      villagers.length >= 3 &&
      canAffordClaim(localBudget, storageCost) &&
      (!shouldBuildFarm || localBudget.wood >= (storageCost.wood ?? 0) + 75)
    ) {
      const builder = pickBuilder(anchorX, anchorY);
      if (builder) {
        const spot = findNonOverlappingPlacement(
          obs,
          STORAGE_PIT,
          anchorX,
          anchorY,
          16,
          builder.id,
          reservedSpots,
        );
        if (spot) {
          emitIntent({
            key: `eco:build:storage:${spot.x}:${spot.y}`,
            priority: 77,
            reason: 'Build Storage Pit for wood/gold/stone/meat drop-off',
            cost: storageCost,
            unitIds: [builder.id],
            spot: { x: spot.x, y: spot.y, masterId: STORAGE_PIT },
            command: {
              type: 'build',
              units: [builder.id],
              unitType: STORAGE_PIT,
              x: spot.x,
              y: spot.y,
            },
          });
        }
      }
    }

    // 8. Naval economy: Dock, Fishing Boats, and Sea Fishing (when profile.allowNaval is enabled)
    if (profile.allowNaval) {
      const dockCount =
        aliveBuildings.filter((b) => b.type === DOCK).length + pendingDockBuilds;
      const dockCost = getMasterCostClaim(obs.enabledMasters[DOCK], false);
      if (
        dockCount === 0 &&
        dockCost &&
        villagers.length >= 6 &&
        allFish.length > 0 &&
        canAffordClaim(localBudget, dockCost)
      ) {
        const builder = pickBuilder(anchorX, anchorY);
        if (builder) {
          const dockSpot = obs.findDockPlacement(anchorX, anchorY, builder.id);
          if (
            dockSpot &&
            !reservedSpots.some((s) => spotsOverlap(obs, { ...dockSpot, masterId: DOCK }, s))
          ) {
            emitIntent({
              key: `eco:build:dock:${dockSpot.x}:${dockSpot.y}`,
              priority: 74,
              reason: 'Build Dock for sea fishing economy',
              cost: dockCost,
              unitIds: [builder.id],
              spot: { x: dockSpot.x, y: dockSpot.y, masterId: DOCK },
              command: {
                type: 'build',
                units: [builder.id],
                unitType: DOCK,
                x: dockSpot.x,
                y: dockSpot.y,
              },
            });
          }
        }
      }

      const boatCost = getMasterCostClaim(obs.enabledMasters[FISHING_BOAT], true);
      if (boatCost && fishingBoats.length + pendingBoatQueues < 3 && allFish.length > 0) {
        for (const dock of activeDocks) {
          if (fishingBoats.length + pendingBoatQueues >= 3) break;
          if (!isBuildingReady(dock)) continue;
          const queued =
            getEffectiveQueueCount(dock) + (pendingQueueCountByBuilding.get(dock.id) ?? 0);
          if (queued >= 2) continue;
          if (!canAffordClaim(localBudget, boatCost)) break;

          const hasFishNearDock =
            fishingBoats.some((b) =>
              allFish.some((f) => obs.canReach(b.id, f.x, f.y, 2.5, false)),
            ) ||
            allFish.some((f) => Math.hypot(f.x - dock.x, f.y - dock.y) <= 28);
          if (!hasFishNearDock) continue;

          pendingBoatQueues++;
          emitIntent({
            key: `eco:queue:fishing-boat:${dock.id}`,
            priority: 72,
            reason: 'Train Fishing Boat at Dock',
            cost: boatCost,
            buildingId: dock.id,
            command: { type: 'queue', building: dock.id, unit: FISHING_BOAT, count: 1 },
          });
        }
      }

      for (const boat of fishingBoats) {
        if (!isUnitReady(boat) || boat.isWorkActive || boat.isMoving) continue;
        if (!hasReachableDropSite(obs, boat.id, boat.x, boat.y, activeDocks)) continue;
        const reachableFish = sortByDistSq(
          allFish.filter((f) => obs.canReach(boat.id, f.x, f.y, 2.5, false)),
          boat.x,
          boat.y,
        );
        const targetFish = reachableFish.find((f) => obs.canReach(boat.id, f.x, f.y, 2.5, true));
        if (!targetFish) continue;

        emitIntent({
          key: `eco:work:fish:${boat.id}:${targetFish.id}`,
          priority: 70,
          reason: 'Assign idle Fishing Boat to reachable fish',
          unitIds: [boat.id],
          command: {
            type: 'work',
            units: [boat.id],
            target: targetFish.id,
            x: targetFish.x,
            y: targetFish.y,
          },
        });
      }
    }

    return intents;
  }

  commit(outcomes: Readonly<Record<string, IntentOutcome>>, input: PlannerInput): void {
    const { observation: obs, state } = input;
    const turn = obs.turn;

    // Prune expired cooldowns and expired failed-target backoffs
    for (const [id, until] of Object.entries(state.unitCooldownUntil)) {
      if (until <= turn) delete state.unitCooldownUntil[Number(id)];
    }
    for (const [id, until] of Object.entries(state.buildingCooldownUntil)) {
      if (until <= turn) delete state.buildingCooldownUntil[Number(id)];
    }
    for (const [id, rec] of Object.entries(state.failedTargets)) {
      if (rec.retryAfterTurn <= turn) delete state.failedTargets[Number(id)];
    }

    // Record observation-driven work failures so failing/unreachable targets back off
    for (const u of obs.ownUnits) {
      if (u.workState === WORK_FAILED && u.workTarget !== null) {
        const prev = state.failedTargets[u.workTarget];
        state.failedTargets[u.workTarget] = {
          count: (prev?.count ?? 0) + 1,
          retryAfterTurn: turn + FAILED_TARGET_BACKOFF_TURNS,
        };
      }
    }

    // Only commit command-dependent cooldowns for accepted intents belonging to EconomyPlanner
    for (const [key, outcome] of Object.entries(outcomes)) {
      if (!key.startsWith('eco:') || !outcome.accepted || !outcome.command) continue;
      const cmd = outcome.command;
      if ('units' in cmd && Array.isArray(cmd.units)) {
        for (const uid of cmd.units) {
          state.unitCooldownUntil[uid] = turn + ECO_COOLDOWN_TURNS;
        }
      }
      if ('building' in cmd && typeof cmd.building === 'number') {
        state.buildingCooldownUntil[cmd.building] = turn + ECO_COOLDOWN_TURNS;
      }
    }
  }
}

export function createEconomyPlanner(): EconomyPlanner {
  return new EconomyPlanner();
}
