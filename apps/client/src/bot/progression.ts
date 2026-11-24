import {
  ARCHERY_RANGE,
  ATTR_FOOD,
  ATTR_GOLD,
  ATTR_STONE,
  ATTR_WOOD,
  BARRACKS,
  BRONZE_AGE,
  COMMAND_DELAY_TURNS,
  GRANARY,
  HOUSE,
  IRON_AGE,
  MARKET,
  ObjectState,
  STABLE,
  STORAGE_PIT,
  TECH_AVAILABLE,
  TECH_DISABLED,
  TECH_DONE,
  TECH_LOCKED,
  TECHS,
  TOOL_AGE,
  TOWN_CENTER,
  type Command,
} from '@aoe/sim';
import type {
  BotIntent,
  BotIntentSpot,
  BotObservation,
  BotPlanner,
  BotProfile,
  IntentOutcome,
  ObservedMaster,
  ObservedOwnBuilding,
  ObservedOwnUnit,
  PendingAction,
  PlannerInput,
  ResourceClaim,
} from './types';

export const ACADEMY = 0;
export const DOCK = 45;
export const SIEGE_WORKSHOP = 49;
export const GOVERNMENT_CENTER = 82;
export const TEMPLE = 104;
export const BUILDER = 118;

const AGE_TECH_ORDER: readonly number[] = [TOOL_AGE, BRONZE_AGE, IRON_AGE];
const BRONZE_PREREQ_BUILDINGS: readonly number[] = [
  GOVERNMENT_CENTER,
  SIEGE_WORKSHOP,
  ACADEMY,
  TEMPLE,
];
const ALL_FISH_TYPES = new Set<number>([53, 260, 263, 370]);

// Building-specific techs that indicate whether a building has useful outputs in this civ
const BUILDING_UNLOCK_TECH: Readonly<Record<number, number>> = {
  [DOCK]: 0,
  [GRANARY]: 10,
  [TEMPLE]: 17,
  [MARKET]: 26,
  [GOVERNMENT_CENTER]: 33,
  [STORAGE_PIT]: 39,
  [SIEGE_WORKSHOP]: 53,
  [ARCHERY_RANGE]: 55,
  [BARRACKS]: 62,
  [STABLE]: 67,
  [ACADEMY]: 72,
};

export type ProgressionStrategy =
  | 'balanced'
  | 'infantry'
  | 'archer'
  | 'cavalry'
  | 'boom'
  | 'siege';

export interface ProgressionPlannerOptions {
  readonly strategy?: ProgressionStrategy;
}

interface AvailableResources {
  food: number;
  wood: number;
  stone: number;
  gold: number;
  headroom: number;
}

interface BuildingGoal {
  readonly type: number;
  readonly targetCount: number;
  readonly priority: number;
  readonly minVillagers: number;
  readonly minWoodReserve?: number;
  readonly requireAge?: number;
}

interface ProposedMeta {
  readonly commandType: Command['type'];
  readonly unitIds: readonly number[];
  readonly buildingId?: number;
}

function getAvailableBudget(
  obs: BotObservation,
  activePending: readonly PendingAction[],
): AvailableResources {
  let food = 0;
  let wood = 0;
  let stone = 0;
  let gold = 0;
  let headroom = 0;
  for (const p of activePending) {
    food += p.cost.food ?? 0;
    wood += p.cost.wood ?? 0;
    stone += p.cost.stone ?? 0;
    gold += p.cost.gold ?? 0;
    headroom += p.cost.headroom ?? 0;
  }
  return {
    food: Math.max(0, obs.resources.food - food),
    wood: Math.max(0, obs.resources.wood - wood),
    stone: Math.max(0, obs.resources.stone - stone),
    gold: Math.max(0, obs.resources.gold - gold),
    headroom: Math.max(0, obs.population.headroom - headroom),
  };
}

function extractMasterCost(m: ObservedMaster): ResourceClaim {
  let food = 0;
  let wood = 0;
  let stone = 0;
  let gold = 0;
  for (const c of m.costs) {
    if (c.flag === 0 || c.amount <= 0) continue;
    if (c.type === ATTR_FOOD) food += c.amount;
    else if (c.type === ATTR_WOOD) wood += c.amount;
    else if (c.type === ATTR_STONE) stone += c.amount;
    else if (c.type === ATTR_GOLD) gold += c.amount;
  }
  const claim: { food?: number; wood?: number; stone?: number; gold?: number } = {};
  if (food > 0) claim.food = food;
  if (wood > 0) claim.wood = wood;
  if (stone > 0) claim.stone = stone;
  if (gold > 0) claim.gold = gold;
  return claim;
}

function extractTechCost(techId: number): ResourceClaim {
  const tech = TECHS[techId];
  if (!tech) return {};
  let food = 0;
  let wood = 0;
  let stone = 0;
  let gold = 0;
  for (const c of tech.costs) {
    if (c.flag === 0 || c.amount <= 0) continue;
    if (c.type === ATTR_FOOD) food += c.amount;
    else if (c.type === ATTR_WOOD) wood += c.amount;
    else if (c.type === ATTR_STONE) stone += c.amount;
    else if (c.type === ATTR_GOLD) gold += c.amount;
  }
  const claim: { food?: number; wood?: number; stone?: number; gold?: number } = {};
  if (food > 0) claim.food = food;
  if (wood > 0) claim.wood = wood;
  if (stone > 0) claim.stone = stone;
  if (gold > 0) claim.gold = gold;
  return claim;
}

function canAffordClaim(avail: AvailableResources, cost: ResourceClaim): boolean {
  return (
    avail.food >= (cost.food ?? 0) &&
    avail.wood >= (cost.wood ?? 0) &&
    avail.stone >= (cost.stone ?? 0) &&
    avail.gold >= (cost.gold ?? 0)
  );
}

function deductClaim(avail: AvailableResources, cost: ResourceClaim): void {
  avail.food = Math.max(0, avail.food - (cost.food ?? 0));
  avail.wood = Math.max(0, avail.wood - (cost.wood ?? 0));
  avail.stone = Math.max(0, avail.stone - (cost.stone ?? 0));
  avail.gold = Math.max(0, avail.gold - (cost.gold ?? 0));
}

function isBuildingAlive(b: ObservedOwnBuilding): boolean {
  return b.hp > 0 && b.state < ObjectState.Dying;
}

function isBuildingActive(b: ObservedOwnBuilding): boolean {
  return isBuildingAlive(b) && b.state === ObjectState.Active && !b.isUnbuilt;
}

function isBuildingEnabled(obs: BotObservation, masterId: number): boolean {
  const m = obs.enabledMasters[masterId];
  return Boolean(m && m.enabled);
}

function isBuildingUsefulForCiv(
  obs: BotObservation,
  buildingType: number,
  profile: BotProfile,
): boolean {
  if (!isBuildingEnabled(obs, buildingType)) return false;

  if (
    buildingType === HOUSE ||
    buildingType === TOWN_CENTER ||
    buildingType === GRANARY ||
    buildingType === STORAGE_PIT ||
    buildingType === MARKET
  ) {
    return true;
  }

  if (buildingType === DOCK) {
    if (!profile.allowNaval) return false;
    return obs.knownResources.some((r) => ALL_FISH_TYPES.has(r.type));
  }

  // Check if the building trains any enabled unit, can unlock its base unit via tech,
  // or offers any non-disabled tech in TECHS.
  for (const m of Object.values(obs.enabledMasters)) {
    if (m.trainLocationId === buildingType && m.enabled) {
      return true;
    }
  }

  const unlockTech = BUILDING_UNLOCK_TECH[buildingType];
  if (unlockTech !== undefined) {
    const state = obs.techStates[unlockTech];
    if (state !== undefined && state !== TECH_DISABLED) {
      return true;
    }
  }

  for (let techId = 0; techId < TECHS.length; techId++) {
    const t = TECHS[techId]!;
    if (t.location === buildingType && obs.techStates[techId] !== TECH_DISABLED) {
      return true;
    }
  }

  return false;
}

function spotsOverlap(
  obs: BotObservation,
  ax: number,
  ay: number,
  aMasterId: number,
  b: BotIntentSpot,
): boolean {
  const ma = obs.enabledMasters[aMasterId];
  const mb = obs.enabledMasters[b.masterId];
  const acx = ma && ma.clearanceX > 0 ? ma.clearanceX : (ma?.radiusX ?? 1);
  const acy = ma && ma.clearanceY > 0 ? ma.clearanceY : (ma?.radiusY ?? 1);
  const bcx = mb && mb.clearanceX > 0 ? mb.clearanceX : (mb?.radiusX ?? 1);
  const bcy = mb && mb.clearanceY > 0 ? mb.clearanceY : (mb?.radiusY ?? 1);
  return Math.abs(ax - b.x) < acx + bcx && Math.abs(ay - b.y) < acy + bcy;
}

function findNonOverlappingPlacement(
  obs: BotObservation,
  buildingType: number,
  nearX: number,
  nearY: number,
  builderId: number,
  reservedSpots: readonly BotIntentSpot[],
): { x: number; y: number } | null {
  const m = obs.enabledMasters[buildingType];
  if (!m || !m.enabled) return null;

  if (buildingType === DOCK) {
    const primary = obs.findDockPlacement(nearX, nearY, builderId);
    if (primary && !reservedSpots.some((s) => spotsOverlap(obs, primary.x, primary.y, DOCK, s))) {
      return primary;
    }
    const actor = obs.ownUnits.find((u) => u.id === builderId);
    if (actor) {
      const alt = obs.findDockPlacement(actor.x, actor.y, builderId);
      if (alt && !reservedSpots.some((s) => spotsOverlap(obs, alt.x, alt.y, DOCK, s))) {
        return alt;
      }
    }
    return null;
  }

  const reachRange = Math.max(m.clearanceX, m.clearanceY) + 1.5;
  const primary = obs.findBuildPlacement(buildingType, nearX, nearY, 36, builderId);
  if (primary && !reservedSpots.some((s) => spotsOverlap(obs, primary.x, primary.y, buildingType, s))) {
    return primary;
  }

  // Fallback deterministic spiral scan around anchor when primary overlaps pending/proposed spots or base is congested
  const halfX = m.clearanceX - Math.trunc(m.clearanceX) > 0 ? 0.5 : 0;
  const halfY = m.clearanceY - Math.trunc(m.clearanceY) > 0 ? 0.5 : 0;
  const baseX = Math.floor(nearX) + halfX;
  const baseY = Math.floor(nearY) + halfY;
  const maxR = Math.min(Math.max(36, Math.max(obs.mapWidth, obs.mapHeight)), 56);

  const scan = (startDist: number, endDist: number, step: number): { x: number; y: number } | null => {
    for (let dist = startDist; dist <= endDist; dist += step) {
      for (let dx = -dist; dx <= dist; dx += step) {
        for (let dy = -dist; dy <= dist; dy += step) {
          if (Math.abs(dx) !== dist && Math.abs(dy) !== dist) continue;
          const x = baseX + dx;
          const y = baseY + dy;
          if (x - m.clearanceX < 1 || x + m.clearanceX >= obs.mapWidth - 1) continue;
          if (y - m.clearanceY < 1 || y + m.clearanceY >= obs.mapHeight - 1) continue;
          if (reservedSpots.some((s) => spotsOverlap(obs, x, y, buildingType, s))) continue;
          if (!obs.canPlaceBuilding(buildingType, x, y)) continue;
          if (!obs.canReach(builderId, x, y, reachRange, true)) continue;
          return { x, y };
        }
      }
    }
    return null;
  };

  return scan(4, Math.min(maxR, 24), 2) ?? scan(1, maxR, 1);
}

function getAnchorPoint(obs: BotObservation): { x: number; y: number } {
  const activeTc = obs.ownBuildings.find((b) => b.type === TOWN_CENTER && isBuildingActive(b));
  if (activeTc) return { x: activeTc.x, y: activeTc.y };
  const anyTc = obs.ownBuildings.find((b) => b.type === TOWN_CENTER && isBuildingAlive(b));
  if (anyTc) return { x: anyTc.x, y: anyTc.y };
  const firstUnit = obs.ownUnits.find((u) => u.hp > 0 && u.state === ObjectState.Active);
  if (firstUnit) return { x: firstUnit.x, y: firstUnit.y };
  return { x: obs.mapWidth / 2, y: obs.mapHeight / 2 };
}

function sortVillagersByDist(
  villagers: readonly ObservedOwnUnit[],
  targetX: number,
  targetY: number,
): ObservedOwnUnit[] {
  return [...villagers].sort((a, b) => {
    const da = (a.x - targetX) * (a.x - targetX) + (a.y - targetY) * (a.y - targetY);
    const db = (b.x - targetX) * (b.x - targetX) + (b.y - targetY) * (b.y - targetY);
    return da - db || a.id - b.id;
  });
}

function getCandidateBuilders(
  obs: BotObservation,
  claimedUnitIds: ReadonlySet<number>,
  unitCooldownUntil: Readonly<Record<number, number>>,
  unbuiltIds: ReadonlySet<number>,
  nearX: number,
  nearY: number,
): ObservedOwnUnit[] {
  const available = obs.ownUnits.filter(
    (u) =>
      u.isVillager &&
      u.hp > 0 &&
      u.state === ObjectState.Active &&
      u.inside === null &&
      !claimedUnitIds.has(u.id) &&
      (unitCooldownUntil[u.id] ?? 0) <= obs.turn &&
      !(u.type === BUILDER && u.isWorkActive) &&
      !(u.isWorkActive && u.workTarget !== null && unbuiltIds.has(u.workTarget)),
  );

  const idle = sortVillagersByDist(
    available.filter((u) => !u.isWorkActive && !u.isActivelyEngaged && !u.isMoving),
    nearX,
    nearY,
  );
  const busy = sortVillagersByDist(
    available.filter((u) => u.isWorkActive || u.isActivelyEngaged || u.isMoving),
    nearX,
    nearY,
  );
  return [...idle, ...busy];
}

function buildGoalsForStrategy(
  strategy: ProgressionStrategy,
  profile: BotProfile,
): BuildingGoal[] {
  const allowExtra = profile.difficulty !== 'easy';
  const isHard = profile.difficulty === 'hard';

  const goals: BuildingGoal[] = [
    { type: TOWN_CENTER, targetCount: 1, priority: 90, minVillagers: 1 },
    { type: GRANARY, targetCount: 1, priority: 86, minVillagers: 1 },
    { type: MARKET, targetCount: 1, priority: 85, minVillagers: 1, requireAge: 2 },
    { type: STORAGE_PIT, targetCount: 1, priority: 84, minVillagers: 1 },
    { type: BARRACKS, targetCount: 1, priority: 83, minVillagers: 1 },
  ];

  if (profile.allowNaval) {
    goals.push({ type: DOCK, targetCount: 1, priority: 75, minVillagers: 3 });
  }

  switch (strategy) {
    case 'infantry':
      goals.push(
        { type: BARRACKS, targetCount: allowExtra ? 2 : 1, priority: 80, minVillagers: 5 },
        { type: GOVERNMENT_CENTER, targetCount: 1, priority: 79, minVillagers: 1, requireAge: 3 },
        { type: ACADEMY, targetCount: isHard ? 2 : 1, priority: 78, minVillagers: 1, requireAge: 3 },
        { type: SIEGE_WORKSHOP, targetCount: 1, priority: 76, minVillagers: 1, requireAge: 3 },
        { type: ARCHERY_RANGE, targetCount: 1, priority: 66, minVillagers: 1, requireAge: 2 },
      );
      break;
    case 'archer':
      goals.push(
        { type: ARCHERY_RANGE, targetCount: allowExtra ? 2 : 1, priority: 81, minVillagers: 1, requireAge: 2 },
        { type: GOVERNMENT_CENTER, targetCount: 1, priority: 79, minVillagers: 1, requireAge: 3 },
        { type: SIEGE_WORKSHOP, targetCount: 1, priority: 78, minVillagers: 1, requireAge: 3 },
      );
      break;
    case 'cavalry':
      goals.push(
        { type: STABLE, targetCount: allowExtra ? 2 : 1, priority: 81, minVillagers: 1, requireAge: 2 },
        { type: GOVERNMENT_CENTER, targetCount: 1, priority: 79, minVillagers: 1, requireAge: 3 },
        { type: SIEGE_WORKSHOP, targetCount: 1, priority: 78, minVillagers: 1, requireAge: 3 },
      );
      break;
    case 'boom':
      goals.push(
        { type: ARCHERY_RANGE, targetCount: 1, priority: 81, minVillagers: 1, requireAge: 2 },
        { type: STABLE, targetCount: 1, priority: 80, minVillagers: 1, requireAge: 2 },
        { type: GOVERNMENT_CENTER, targetCount: 1, priority: 79, minVillagers: 1, requireAge: 3 },
        { type: TOWN_CENTER, targetCount: allowExtra ? 2 : 1, priority: 77, minVillagers: 6, requireAge: 3, minWoodReserve: 250 },
        { type: TEMPLE, targetCount: 1, priority: 76, minVillagers: 1, requireAge: 3 },
        { type: SIEGE_WORKSHOP, targetCount: 1, priority: 74, minVillagers: 1, requireAge: 3 },
      );
      break;
    case 'siege':
      goals.push(
        { type: ARCHERY_RANGE, targetCount: 1, priority: 81, minVillagers: 1, requireAge: 2 },
        { type: GOVERNMENT_CENTER, targetCount: 1, priority: 79, minVillagers: 1, requireAge: 3 },
        { type: SIEGE_WORKSHOP, targetCount: allowExtra ? 2 : 1, priority: 78, minVillagers: 1, requireAge: 3 },
        { type: TEMPLE, targetCount: 1, priority: 76, minVillagers: 1, requireAge: 3 },
        { type: ACADEMY, targetCount: 1, priority: 72, minVillagers: 1, requireAge: 3 },
      );
      break;
    case 'balanced':
    default:
      goals.push(
        { type: ARCHERY_RANGE, targetCount: 1, priority: 81, minVillagers: 1, requireAge: 2 },
        { type: STABLE, targetCount: 1, priority: 80, minVillagers: 1, requireAge: 2 },
        { type: GOVERNMENT_CENTER, targetCount: 1, priority: 79, minVillagers: 1, requireAge: 3 },
        { type: SIEGE_WORKSHOP, targetCount: 1, priority: 78, minVillagers: 1, requireAge: 3 },
        { type: ACADEMY, targetCount: 1, priority: 77, minVillagers: 1, requireAge: 3 },
        { type: TEMPLE, targetCount: 1, priority: 76, minVillagers: 1, requireAge: 3 },
        { type: BARRACKS, targetCount: allowExtra ? 2 : 1, priority: 74, minVillagers: 6, minWoodReserve: 180 },
        { type: ARCHERY_RANGE, targetCount: allowExtra ? 2 : 1, priority: 58, minVillagers: 10, requireAge: 3, minWoodReserve: 300 },
        { type: STABLE, targetCount: allowExtra ? 2 : 1, priority: 56, minVillagers: 10, requireAge: 3, minWoodReserve: 300 },
      );
      break;
  }

  return goals;
}

export class ProgressionPlanner implements BotPlanner {
  readonly name = 'progression';
  private readonly strategy: ProgressionStrategy;
  private lastProposedMeta = new Map<string, ProposedMeta>();

  constructor(options: ProgressionPlannerOptions = {}) {
    this.strategy = options.strategy ?? 'balanced';
  }

  propose(input: PlannerInput): BotIntent[] {
    const { observation: obs, profile, state, pendingActions } = input;
    const activePending = pendingActions.filter((p) => p.status === 'issued');
    const avail = getAvailableBudget(obs, activePending);

    const claimedUnits = new Set<number>();
    const claimedBuildings = new Set<number>();
    const pendingTechs = new Set<number>();
    const reservedSpots: BotIntentSpot[] = [];
    const pendingWorkTargets = new Set<number>();

    for (const p of activePending) {
      for (const uid of p.unitIds) claimedUnits.add(uid);
      if (p.buildingId !== undefined) claimedBuildings.add(p.buildingId);
      if (p.techId !== undefined) pendingTechs.add(p.techId);
      if (p.spot) reservedSpots.push(p.spot);
      if (p.targetId !== undefined && (p.commandType === 'work' || p.commandType === 'repair')) {
        pendingWorkTargets.add(p.targetId);
      }
    }

    const aliveBuildings = obs.ownBuildings.filter(isBuildingAlive);
    const activeBuildings = aliveBuildings.filter(isBuildingActive);
    const unbuiltBuildings = aliveBuildings.filter((b) => b.isUnbuilt);
    const unbuiltIds = new Set<number>(unbuiltBuildings.map((b) => b.id));

    const activeCount = (type: number): number =>
      activeBuildings.filter((b) => b.type === type).length;
    const unbuiltCount = (type: number): number =>
      unbuiltBuildings.filter((b) => b.type === type).length;
    const pendingBuildCount = (type: number): number =>
      activePending.filter(
        (p) => (p.commandType === 'build' || p.commandType === 'build-wall') && p.spot?.masterId === type,
      ).length;
    const startedCount = (type: number): number =>
      activeCount(type) + unbuiltCount(type) + pendingBuildCount(type);

    const aliveVillagers = obs.ownUnits.filter(
      (u) => u.isVillager && u.hp > 0 && u.state === ObjectState.Active && u.inside === null,
    );

    const intents: BotIntent[] = [];
    const nextMeta = new Map<string, ProposedMeta>();
    const anchor = getAnchorPoint(obs);

    const recordIntent = (intent: BotIntent): void => {
      intents.push(intent);
      nextMeta.set(intent.key, {
        commandType: intent.command.type,
        unitIds: intent.unitIds ?? [],
        buildingId: intent.buildingId,
      });
    };

    // 1. Age-Up Research driven strictly by observation.techStates (TECH_AVAILABLE) & TECHS costs
    const nextAgeTech = AGE_TECH_ORDER.find((techId) => {
      const ts = obs.techStates[techId];
      return ts !== undefined && ts !== TECH_DONE && ts !== TECH_DISABLED;
    });

    if (
      nextAgeTech !== undefined &&
      obs.techStates[nextAgeTech] === TECH_AVAILABLE &&
      !pendingTechs.has(nextAgeTech)
    ) {
      const techInfo = TECHS[nextAgeTech];
      if (techInfo) {
        const techCost = extractTechCost(nextAgeTech);
        if (canAffordClaim(avail, techCost)) {
          const researchBuilding = activeBuildings.find(
            (b) =>
              b.type === techInfo.location &&
              !b.isBusy &&
              b.researchingTech === null &&
              b.trainingUnit === null &&
              b.queueLength === 0 &&
              b.queuedUnits.length === 0 &&
              !claimedBuildings.has(b.id) &&
              (state.buildingCooldownUntil[b.id] ?? 0) <= obs.turn,
          );
          if (researchBuilding) {
            const key = `progression:age-up:${nextAgeTech}`;
            deductClaim(avail, techCost);
            claimedBuildings.add(researchBuilding.id);
            recordIntent({
              command: { type: 'research', building: researchBuilding.id, tech: nextAgeTech },
              priority: 96,
              key,
              reason: `Advance to age tech ${nextAgeTech}`,
              cost: techCost,
              buildingId: researchBuilding.id,
            });
          }
        }
      }
    }

    // 2. Recover orphaned unbuilt foundations (e.g., when builder died or stopped)
    const sortedUnbuilt = [...unbuiltBuildings].sort((a, b) => {
      const aHouse = a.type === HOUSE ? 0 : 1;
      const bHouse = b.type === HOUSE ? 0 : 1;
      return aHouse - bHouse || a.id - b.id;
    });

    for (const foundation of sortedUnbuilt) {
      const activeBuilders = aliveVillagers.filter(
        (v) => v.isWorkActive && v.workTarget === foundation.id,
      ).length;
      const hasPendingWork =
        pendingWorkTargets.has(foundation.id) ||
        activePending.some(
          (p) =>
            (p.commandType === 'build' || p.commandType === 'build-wall') &&
            p.spot &&
            p.spot.masterId === foundation.type &&
            Math.abs(p.spot.x - foundation.x) < 1 &&
            Math.abs(p.spot.y - foundation.y) < 1,
        );
      if (activeBuilders > 0 || hasPendingWork) continue;

      const fm = obs.enabledMasters[foundation.type];
      const reachRange = Math.max(fm?.clearanceX ?? 1.5, fm?.clearanceY ?? 1.5) + 1.5;
      const candidates = getCandidateBuilders(
        obs,
        claimedUnits,
        state.unitCooldownUntil,
        unbuiltIds,
        foundation.x,
        foundation.y,
      );
      const chosen = candidates.find((v) => obs.canReach(v.id, foundation.x, foundation.y, reachRange, true));
      if (chosen) {
        claimedUnits.add(chosen.id);
        recordIntent({
          command: { type: 'work', units: [chosen.id], target: foundation.id, x: foundation.x, y: foundation.y },
          priority: foundation.type === HOUSE ? 92 : 88,
          key: `progression:resume:${foundation.id}`,
          reason: `Resume unbuilt foundation ${foundation.type}`,
          unitIds: [chosen.id],
        });
      }
    }

    const tryProposeBuild = (
      buildingType: number,
      priority: number,
      reason: string,
      minWoodReserve = 0,
    ): boolean => {
      const masterRecord = obs.enabledMasters[buildingType];
      if (!masterRecord || !masterRecord.enabled) return false;
      const cost = extractMasterCost(masterRecord);
      if (!canAffordClaim(avail, cost)) return false;
      if (minWoodReserve > 0 && avail.wood - (cost.wood ?? 0) < minWoodReserve) return false;

      const candidates = getCandidateBuilders(
        obs,
        claimedUnits,
        state.unitCooldownUntil,
        unbuiltIds,
        anchor.x,
        anchor.y,
      ).slice(0, 6);

      for (const builder of candidates) {
        const spot = findNonOverlappingPlacement(
          obs,
          buildingType,
          anchor.x,
          anchor.y,
          builder.id,
          reservedSpots,
        );
        if (!spot) continue;

        const spotClaim: BotIntentSpot = { x: spot.x, y: spot.y, masterId: buildingType };
        deductClaim(avail, cost);
        claimedUnits.add(builder.id);
        reservedSpots.push(spotClaim);

        const seq = startedCount(buildingType);
        recordIntent({
          command: { type: 'build', units: [builder.id], unitType: buildingType, x: spot.x, y: spot.y },
          priority,
          key: `progression:build:${buildingType}:${seq}`,
          reason,
          cost,
          unitIds: [builder.id],
          spot: spotClaim,
        });
        return true;
      }

      return false;
    };

    // 3. Proactive Housing / Population-Cap Management
    const unbuiltHouses = unbuiltCount(HOUSE);
    const pendingHouses = pendingBuildCount(HOUSE);
    const inFlightHouseRoom = (unbuiltHouses + pendingHouses) * 4;
    const effectiveCapacity = obs.population.current + obs.population.headroom + inFlightHouseRoom;
    const houseThreshold = obs.ownUnits.length >= 10 ? 4 : 3;
    const maxInFlightHouses =
      avail.headroom <= 0 && effectiveCapacity + 4 < obs.population.limit
        ? 2
        : obs.ownUnits.length >= 10
          ? 2
          : 1;

    if (
      isBuildingEnabled(obs, HOUSE) &&
      effectiveCapacity < obs.population.limit &&
      avail.headroom + inFlightHouseRoom <= houseThreshold &&
      unbuiltHouses + pendingHouses < maxInFlightHouses &&
      aliveVillagers.length > 0
    ) {
      const housePriority = avail.headroom <= 1 && inFlightHouseRoom === 0 ? 94 : 84;
      tryProposeBuild(HOUSE, housePriority, 'Build House for population headroom');
    }

    // 4. Strategy & Tech-Tree Building Chain (at most 1 non-House new building per tick to avoid overcommitting builders)
    const goals = buildGoalsForStrategy(this.strategy, profile);

    // Ensure at least 2 Bronze prerequisite buildings are targeted if IRON_AGE is still locked and
    // strategy omitted enough enabled Bronze buildings (or civ disabled one of the strategy's picks)
    const ironState = obs.techStates[IRON_AGE];
    if (obs.age >= 3 && ironState === TECH_LOCKED) {
      const targetedBronze = new Set(
        goals.filter((g) => BRONZE_PREREQ_BUILDINGS.includes(g.type)).map((g) => g.type),
      );
      const feasibleBronzeCount = [...targetedBronze].filter((t) =>
        isBuildingUsefulForCiv(obs, t, profile),
      ).length;
      if (feasibleBronzeCount < 2) {
        for (const bType of BRONZE_PREREQ_BUILDINGS) {
          if (!targetedBronze.has(bType) && isBuildingUsefulForCiv(obs, bType, profile)) {
            goals.push({ type: bType, targetCount: 1, priority: 65, minVillagers: 6, requireAge: 3 });
          }
        }
      }
    }

    // Also if TOOL_AGE is locked and a Stone Age prerequisite was disabled, allow Dock fallback
    if (obs.techStates[TOOL_AGE] === TECH_LOCKED && !profile.allowNaval) {
      const stoneCount = [GRANARY, STORAGE_PIT, BARRACKS].filter((t) =>
        isBuildingUsefulForCiv(obs, t, profile),
      ).length;
      if (stoneCount < 2 && isBuildingEnabled(obs, DOCK)) {
        goals.push({ type: DOCK, targetCount: 1, priority: 75, minVillagers: 4 });
      }
    }

    goals.sort((a, b) => b.priority - a.priority || a.type - b.type);

    for (const goal of goals) {
      if (goal.requireAge !== undefined && obs.age < goal.requireAge) continue;
      if (aliveVillagers.length < goal.minVillagers) continue;
      if (startedCount(goal.type) >= goal.targetCount) continue;
      if (!isBuildingUsefulForCiv(obs, goal.type, profile)) continue;

      if (
        tryProposeBuild(
          goal.type,
          goal.priority,
          `Build ${obs.enabledMasters[goal.type]?.name ?? goal.type} for ${this.strategy} progression`,
          goal.minWoodReserve ?? 0,
        )
      ) {
        break;
      }
    }

    this.lastProposedMeta = nextMeta;
    return intents;
  }

  commit(outcomes: Readonly<Record<string, IntentOutcome>>, input: PlannerInput): void {
    const cooldownTurn = input.observation.turn + COMMAND_DELAY_TURNS;
    for (const [key, meta] of this.lastProposedMeta.entries()) {
      const outcome = outcomes[key];
      if (!outcome?.accepted) continue;

      if (meta.commandType === 'build') {
        for (const uid of meta.unitIds) {
          input.state.unitCooldownUntil[uid] = Math.max(
            input.state.unitCooldownUntil[uid] ?? 0,
            cooldownTurn,
          );
        }
      }
      if (meta.buildingId !== undefined) {
        input.state.buildingCooldownUntil[meta.buildingId] = Math.max(
          input.state.buildingCooldownUntil[meta.buildingId] ?? 0,
          cooldownTurn,
        );
      }
    }
    this.lastProposedMeta.clear();
  }
}

export function createProgressionPlanner(
  options: ProgressionPlannerOptions = {},
): BotPlanner {
  return new ProgressionPlanner(options);
}
