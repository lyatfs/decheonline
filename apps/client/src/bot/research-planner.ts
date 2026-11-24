import {
  ARCHERY_RANGE,
  ATTR_FOOD,
  ATTR_GOLD,
  ATTR_HEADROOM,
  ATTR_STONE,
  ATTR_WOOD,
  BARRACKS,
  BOWMAN,
  BRONZE_AGE,
  CLUBMAN,
  COMMAND_DELAY_TURNS,
  GRANARY,
  IRON_AGE,
  MARKET,
  ObjectState,
  SCOUT,
  SLINGER,
  STABLE,
  STORAGE_PIT,
  TECH_AVAILABLE,
  TECH_DONE,
  TECH_LOCKED,
  TECHS,
  TOOL_AGE,
  TOWN_CENTER,
  VILLAGER,
  ASIAN_SPEARMAN,
} from '@aoe/sim';
import type {
  BotIntent,
  BotObservation,
  BotPlanner,
  BotProfile,
  IntentOutcome,
  ObservedMaster,
  ObservedOwnBuilding,
  PendingAction,
  PlannerInput,
  ResourceClaim,
} from './types';

const ACADEMY = 0;
const DOCK = 45;
const SIEGE_WORKSHOP = 49;
const GOVERNMENT_CENTER = 82;
const TEMPLE = 104;

// Trainable destination master IDs (note: copyObj upgrades overwrite destination records while keeping these IDs)
const SHORT_SWORDSMAN = 75;
const IMPROVED_BOWMAN = 5;
const HORSE_ARCHER = 39;
const CHARIOT_ARCHER = 41;
const ELEPHANT_ARCHER = 25;
const CAVALRY = 37;
const CHARIOT = 40;
const WAR_ELEPHANT = 46;
const CAMEL_RIDER = 338;
const HOPLITE = 93;
const STONE_THROWER = 35;
const BALLISTA = 11;
const PRIEST = 125;
const SCOUT_SHIP = 19;
const CATAPULT_TRIREME = 250;
const FIRE_GALLEY = 360;

// Tech IDs verified against packages/sim/src/unit-data.ts TECH_RECORDS
const TECH_WAR_GALLEY = 5;
const TECH_TRIREME = 7;
const TECH_CATAPULT_TRIREME = 9;
const TECH_JUGGERNAUT = 25;
const TECH_FISHING_SHIP = 4;
const TECH_MERCHANT_SHIP = 6;
const TECH_HEAVY_TRANSPORT = 8;

const TECH_SMALL_WALL = 11;
const TECH_SENTRY_TOWER = 12;
const TECH_MED_WALL = 13;
const TECH_FORT_WALL = 14;
const TECH_GUARD_TOWER = 15;
const TECH_WATCH_TOWER = 16;
const TECH_BALLISTA_TOWER = 2;

const TECH_FANATICISM = 20;

const TECH_WHEEL = 28;
const TECH_COINAGE = 30;
const TECH_PLOW = 31;
const TECH_ARTISANSHIP = 32;
const TECH_IRRIGATION = 80;
const TECH_DOMESTICATION = 81;
const TECH_WOODWORKING = 107;
const TECH_GOLD_MINING = 108;
const TECH_STONE_MINING = 109;
const TECH_CRAFTSMANSHIP = 110;
const TECH_SIEGECRAFT = 111;

const TECH_NOBILITY = 34;
const TECH_ENGINEERING = 35;
const TECH_ALCHEMY = 37;
const TECH_BALLISTICS = 106;
const TECH_ARCHITECTURE = 112;
const TECH_ARISTOCRACY = 113;
const TECH_WRITING = 114;
const TECH_LOGISTICS = 121;

const TECH_TOOL_ARMOR_INF = 40;
const TECH_TOOL_ARMOR_ARCH = 41;
const TECH_TOOL_ARMOR_CAV = 42;
const TECH_BRONZE_ARMOR_INF = 43;
const TECH_BRONZE_ARMOR_ARCH = 44;
const TECH_BRONZE_ARMOR_CAV = 45;
const TECH_TOOL_WORKING = 46;
const TECH_BRONZE_SHIELD = 47;
const TECH_IRON_ARMOR_INF = 48;
const TECH_IRON_ARMOR_ARCH = 49;
const TECH_IRON_ARMOR_CAV = 50;
const TECH_METALLURGY = 51;
const TECH_IRON_ATTACK = 52;
const TECH_TOWER_SHIELD = 117;
const TECH_IRON_SHIELD = 122;

const TECH_AXEMAN = 63;
const TECH_SHORT_SWORD = 64;
const TECH_BROAD_SWORD = 65;
const TECH_LONG_SWORD = 66;
const TECH_LEGION = 77;

const TECH_IMPROVED_BOW = 56;
const TECH_COMPOSITE_BOW = 57;
const TECH_CHARIOT_ARCHER = 59;
const TECH_HORSE_ARCHER = 60;
const TECH_ELEPHANT_ARCHER = 61;
const TECH_HEAVY_HORSE_ARCHER = 38;

const TECH_CHARIOT = 68;
const TECH_CAVALRY = 69;
const TECH_WAR_ELEPHANT = 70;
const TECH_HEAVY_CAVALRY = 71;
const TECH_CATAPHRACT = 78;
const TECH_ARMORED_ELEPHANT = 125;
const TECH_SCYTHE_CHARIOT = 126;

const TECH_PHALANX = 73;
const TECH_CENTURION = 79;

const TECH_CATAPULT = 54;
const TECH_HEAVY_CATAPULT = 36;
const TECH_BALLISTA = 58;
const TECH_HELEPOLIS = 27;

const BUILDING_COOLDOWN_TURNS = COMMAND_DELAY_TURNS + 1;

const KEY_RESEARCH_PREFIX = 'research:';
const KEY_QUEUE_MIL_PREFIX = 'queue:mil:';

/**
 * Curated tech list per building, cross-checked at runtime against `TECHS[id].location`,
 * `observation.techStates[id] === TECH_AVAILABLE`, and `profile.maxResearchDepth`.
 */
export const RESEARCH_PRIORITY_TECHS: Readonly<Record<number, readonly number[]>> = {
  [MARKET]: [
    TECH_WOODWORKING,
    TECH_DOMESTICATION,
    TECH_WHEEL,
    TECH_GOLD_MINING,
    TECH_PLOW,
    TECH_ARTISANSHIP,
    TECH_STONE_MINING,
    TECH_IRRIGATION,
    TECH_CRAFTSMANSHIP,
    TECH_SIEGECRAFT,
    TECH_COINAGE,
  ],
  [BARRACKS]: [TECH_SHORT_SWORD, TECH_BROAD_SWORD, TECH_LONG_SWORD, TECH_LEGION, TECH_AXEMAN],
  [ARCHERY_RANGE]: [
    TECH_IMPROVED_BOW,
    TECH_COMPOSITE_BOW,
    TECH_HEAVY_HORSE_ARCHER,
    TECH_CHARIOT_ARCHER,
    TECH_HORSE_ARCHER,
    TECH_ELEPHANT_ARCHER,
  ],
  [STABLE]: [
    TECH_HEAVY_CAVALRY,
    TECH_CATAPHRACT,
    TECH_ARMORED_ELEPHANT,
    TECH_SCYTHE_CHARIOT,
    TECH_CAVALRY,
    TECH_CHARIOT,
    TECH_WAR_ELEPHANT,
  ],
  [STORAGE_PIT]: [
    TECH_TOOL_WORKING,
    TECH_METALLURGY,
    TECH_IRON_ATTACK,
    TECH_TOOL_ARMOR_INF,
    TECH_TOOL_ARMOR_ARCH,
    TECH_TOOL_ARMOR_CAV,
    TECH_BRONZE_ARMOR_INF,
    TECH_BRONZE_ARMOR_ARCH,
    TECH_BRONZE_ARMOR_CAV,
    TECH_BRONZE_SHIELD,
    TECH_IRON_ARMOR_INF,
    TECH_IRON_ARMOR_ARCH,
    TECH_IRON_ARMOR_CAV,
    TECH_TOWER_SHIELD,
    TECH_IRON_SHIELD,
  ],
  [GOVERNMENT_CENTER]: [
    TECH_ARCHITECTURE,
    TECH_NOBILITY,
    TECH_LOGISTICS,
    TECH_BALLISTICS,
    TECH_ALCHEMY,
    TECH_ENGINEERING,
    TECH_ARISTOCRACY,
    TECH_WRITING,
  ],
  [ACADEMY]: [TECH_PHALANX, TECH_CENTURION],
  [SIEGE_WORKSHOP]: [TECH_CATAPULT, TECH_HEAVY_CATAPULT, TECH_HELEPOLIS, TECH_BALLISTA],
  [DOCK]: [
    TECH_FISHING_SHIP,
    TECH_WAR_GALLEY,
    TECH_TRIREME,
    TECH_CATAPULT_TRIREME,
    TECH_JUGGERNAUT,
    TECH_HEAVY_TRANSPORT,
    TECH_MERCHANT_SHIP,
  ],
  [GRANARY]: [
    TECH_WATCH_TOWER,
    TECH_SENTRY_TOWER,
    TECH_GUARD_TOWER,
    TECH_BALLISTA_TOWER,
    TECH_SMALL_WALL,
    TECH_MED_WALL,
    TECH_FORT_WALL,
  ],
  [TEMPLE]: [21, 22, 24, TECH_FANATICISM, 18, 19, 23, 119, 120],
};

const TECH_DEPTH: Readonly<Record<number, number>> = {
  // Depth 1: Basic economy, Tool upgrades & initial unit-line unlocks
  [TECH_WOODWORKING]: 1,
  [TECH_DOMESTICATION]: 1,
  [TECH_GOLD_MINING]: 1,
  [TECH_STONE_MINING]: 1,
  [TECH_AXEMAN]: 1,
  [TECH_SHORT_SWORD]: 1,
  [TECH_IMPROVED_BOW]: 1,
  [TECH_CAVALRY]: 1,
  [TECH_CHARIOT]: 1,
  [TECH_WAR_ELEPHANT]: 1,
  [TECH_CHARIOT_ARCHER]: 1,
  [TECH_HORSE_ARCHER]: 1,
  [TECH_ELEPHANT_ARCHER]: 1,
  [TECH_BALLISTA]: 1,
  [TECH_TOOL_ARMOR_INF]: 1,
  [TECH_TOOL_ARMOR_ARCH]: 1,
  [TECH_TOOL_ARMOR_CAV]: 1,
  [TECH_TOOL_WORKING]: 1,
  [TECH_FISHING_SHIP]: 1,
  [TECH_SMALL_WALL]: 1,
  [TECH_WATCH_TOWER]: 1,

  // Depth 2: Bronze upgrades & tier-2 unit lines
  [TECH_WHEEL]: 2,
  [TECH_PLOW]: 2,
  [TECH_ARTISANSHIP]: 2,
  [TECH_BROAD_SWORD]: 2,
  [TECH_COMPOSITE_BOW]: 2,
  [TECH_HEAVY_CAVALRY]: 2,
  [TECH_PHALANX]: 2,
  [TECH_CATAPULT]: 2,
  [TECH_BRONZE_ARMOR_INF]: 2,
  [TECH_BRONZE_ARMOR_ARCH]: 2,
  [TECH_BRONZE_ARMOR_CAV]: 2,
  [TECH_BRONZE_SHIELD]: 2,
  [TECH_METALLURGY]: 2,
  [TECH_NOBILITY]: 2,
  [TECH_ARCHITECTURE]: 2,
  [TECH_LOGISTICS]: 2,
  [TECH_BALLISTICS]: 2,
  [TECH_WRITING]: 2,
  [TECH_WAR_GALLEY]: 2,
  [TECH_MERCHANT_SHIP]: 2,
  [TECH_HEAVY_TRANSPORT]: 2,
  [TECH_SENTRY_TOWER]: 2,
  [TECH_MED_WALL]: 2,
  21: 2,
  22: 2,
  24: 2,

  // Depth 3: Iron Age core & tier-3 unit upgrades
  [TECH_CRAFTSMANSHIP]: 3,
  [TECH_IRRIGATION]: 3,
  [TECH_SIEGECRAFT]: 3,
  [TECH_COINAGE]: 3,
  [TECH_LONG_SWORD]: 3,
  [TECH_HEAVY_HORSE_ARCHER]: 3,
  [TECH_SCYTHE_CHARIOT]: 3,
  [TECH_IRON_ARMOR_INF]: 3,
  [TECH_IRON_ARMOR_ARCH]: 3,
  [TECH_IRON_ARMOR_CAV]: 3,
  [TECH_TOWER_SHIELD]: 3,
  [TECH_ENGINEERING]: 3,
  [TECH_ALCHEMY]: 3,
  [TECH_ARISTOCRACY]: 3,
  [TECH_TRIREME]: 3,
  [TECH_CATAPULT_TRIREME]: 3,
  [TECH_FORT_WALL]: 3,
  [TECH_GUARD_TOWER]: 3,
  18: 3,
  19: 3,
  [TECH_FANATICISM]: 3,
  23: 3,
  119: 3,
  120: 3,

  // Depth 4: Elite Iron Age endgame upgrades
  [TECH_LEGION]: 4,
  [TECH_CATAPHRACT]: 4,
  [TECH_ARMORED_ELEPHANT]: 4,
  [TECH_CENTURION]: 4,
  [TECH_HEAVY_CATAPULT]: 4,
  [TECH_HELEPOLIS]: 4,
  [TECH_IRON_ATTACK]: 4,
  [TECH_IRON_SHIELD]: 4,
  [TECH_JUGGERNAUT]: 4,
  [TECH_BALLISTA_TOWER]: 4,
};

const ECO_TECH_IDS = new Set<number>([
  TECH_WOODWORKING,
  TECH_DOMESTICATION,
  TECH_WHEEL,
  TECH_GOLD_MINING,
  TECH_PLOW,
  TECH_CRAFTSMANSHIP,
  TECH_STONE_MINING,
  TECH_IRRIGATION,
  TECH_ARTISANSHIP,
  TECH_COINAGE,
  TECH_FISHING_SHIP,
]);

const NAVAL_TECH_IDS = new Set<number>([
  TECH_FISHING_SHIP,
  TECH_WAR_GALLEY,
  TECH_TRIREME,
  TECH_CATAPULT_TRIREME,
  TECH_JUGGERNAUT,
  TECH_MERCHANT_SHIP,
  TECH_HEAVY_TRANSPORT,
]);

const MILITARY_TRAINING_BUILDINGS: readonly number[] = [
  BARRACKS,
  ARCHERY_RANGE,
  STABLE,
  ACADEMY,
  SIEGE_WORKSHOP,
  DOCK,
];

const NAVAL_WARSHIP_IDS = new Set<number>([SCOUT_SHIP, CATAPULT_TRIREME, FIRE_GALLEY]);
const CAVALRY_GROUP_IDS = new Set<number>([12, 23, 24, 35, 36]);

interface MutableBudget {
  food: number;
  wood: number;
  stone: number;
  gold: number;
  headroom: number;
}

function getTechCostClaim(techId: number): ResourceClaim {
  const info = TECHS[techId];
  if (!info) return {};
  let food = 0;
  let wood = 0;
  let stone = 0;
  let gold = 0;
  for (const c of info.costs) {
    if (c.flag === 0) continue;
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

function getMasterCostClaim(m: ObservedMaster): ResourceClaim {
  let food = 0;
  let wood = 0;
  let stone = 0;
  let gold = 0;
  let headroom = 1;
  for (const c of m.costs) {
    if (c.type === ATTR_HEADROOM) {
      headroom = Math.max(0, c.amount);
      continue;
    }
    if (c.flag === 0) continue;
    if (c.type === ATTR_FOOD) food += c.amount;
    else if (c.type === ATTR_WOOD) wood += c.amount;
    else if (c.type === ATTR_STONE) stone += c.amount;
    else if (c.type === ATTR_GOLD) gold += c.amount;
  }
  const claim: { food?: number; wood?: number; stone?: number; gold?: number; headroom?: number } = {};
  if (food > 0) claim.food = food;
  if (wood > 0) claim.wood = wood;
  if (stone > 0) claim.stone = stone;
  if (gold > 0) claim.gold = gold;
  if (headroom > 0) claim.headroom = headroom;
  return claim;
}

function canAffordClaim(budget: Readonly<MutableBudget>, cost: ResourceClaim, checkHeadroom = false): boolean {
  if (!Number.isFinite(budget.food) || (cost.food ?? 0) > budget.food) return false;
  if (!Number.isFinite(budget.wood) || (cost.wood ?? 0) > budget.wood) return false;
  if (!Number.isFinite(budget.stone) || (cost.stone ?? 0) > budget.stone) return false;
  if (!Number.isFinite(budget.gold) || (cost.gold ?? 0) > budget.gold) return false;
  if (checkHeadroom && (!Number.isFinite(budget.headroom) || budget.headroom <= 0)) return false;
  if (checkHeadroom && (cost.headroom ?? 0) > budget.headroom) return false;
  return true;
}

function spendClaim(budget: MutableBudget, cost: ResourceClaim): void {
  budget.food = Math.max(0, budget.food - (cost.food ?? 0));
  budget.wood = Math.max(0, budget.wood - (cost.wood ?? 0));
  budget.stone = Math.max(0, budget.stone - (cost.stone ?? 0));
  budget.gold = Math.max(0, budget.gold - (cost.gold ?? 0));
  budget.headroom = Math.max(0, budget.headroom - (cost.headroom ?? 0));
}

function computeAvailableBudget(obs: BotObservation, pendingActions: readonly PendingAction[]): MutableBudget {
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

function getQueueCount(b: ObservedOwnBuilding): number {
  let queuedTotal = 0;
  for (const q of b.queuedUnits) {
    if (q.count > 0) queuedTotal += q.count;
  }
  return Math.max(b.queueLength, queuedTotal, b.trainingUnit !== null ? 1 : 0);
}

function isBuildingAliveAndActive(b: ObservedOwnBuilding): boolean {
  return !b.isUnbuilt && b.state === ObjectState.Active && b.hp > 0;
}

function isBuildingAvailableForResearch(
  b: ObservedOwnBuilding,
  turn: number,
  state: PlannerInput['state'],
  claimedBuildings: ReadonlySet<number>,
): boolean {
  if (!isBuildingAliveAndActive(b)) return false;
  if (claimedBuildings.has(b.id)) return false;
  if (b.isBusy || b.researchingTech !== null || b.trainingUnit !== null || b.queueLength > 0 || b.queuedUnits.length > 0) {
    return false;
  }
  if ((state.buildingCooldownUntil[b.id] ?? 0) > turn) return false;
  return true;
}

function isBuildingAvailableForQueue(
  b: ObservedOwnBuilding,
  turn: number,
  state: PlannerInput['state'],
  claimedBuildings: ReadonlySet<number>,
): boolean {
  if (!isBuildingAliveAndActive(b)) return false;
  if (claimedBuildings.has(b.id)) return false;
  if (b.researchingTech !== null) return false;
  if ((state.buildingCooldownUntil[b.id] ?? 0) > turn) return false;
  if (getQueueCount(b) >= 2) return false;
  return true;
}

export function computeAgeReserve(
  obs: BotObservation,
  available: Readonly<MutableBudget>,
  villagerCount: number,
  activePending: readonly PendingAction[],
): ResourceClaim {
  const nextAgeTech =
    obs.age === 1 ? TOOL_AGE : obs.age === 2 ? BRONZE_AGE : obs.age === 3 ? IRON_AGE : -1;
  if (nextAgeTech === -1) return {};

  const techState = obs.techStates[nextAgeTech] ?? TECH_LOCKED;
  if (techState !== TECH_AVAILABLE) return {};

  const hasActiveTc = obs.ownBuildings.some((b) => b.type === TOWN_CENTER && isBuildingAliveAndActive(b));
  if (!hasActiveTc) return {};

  // If Age-Up is already pending in transit, its cost is already subtracted from `available`
  if (activePending.some((p) => p.commandType === 'research' && p.techId === nextAgeTech)) {
    return {};
  }

  const ageCost = getTechCostClaim(nextAgeTech);
  if (canAffordClaim(available, ageCost)) {
    return ageCost;
  }

  if (nextAgeTech === TOOL_AGE) {
    if (villagerCount >= 8 || (available.food >= 350 && (villagerCount >= 5 || available.food >= 450))) {
      return ageCost;
    }
  } else if (nextAgeTech === BRONZE_AGE) {
    if (villagerCount >= 14 || (available.food >= 550 && (villagerCount >= 7 || available.food >= 700))) {
      return ageCost;
    }
  } else if (nextAgeTech === IRON_AGE) {
    if (
      villagerCount >= 16 ||
      (available.food >= 650 &&
        available.gold >= 450 &&
        (villagerCount >= 8 || (available.food >= 850 && available.gold >= 600)))
    ) {
      return ageCost;
    }
  }

  return {};
}

function getTechDepth(techId: number): number {
  return TECH_DEPTH[techId] ?? 2;
}

function isKeyUpgradeTech(techId: number): boolean {
  return (
    techId === TECH_AXEMAN ||
    techId === TECH_SHORT_SWORD ||
    techId === TECH_BROAD_SWORD ||
    techId === TECH_LONG_SWORD ||
    techId === TECH_LEGION ||
    techId === TECH_IMPROVED_BOW ||
    techId === TECH_COMPOSITE_BOW ||
    techId === TECH_HEAVY_HORSE_ARCHER ||
    techId === TECH_HEAVY_CAVALRY ||
    techId === TECH_CATAPHRACT ||
    techId === TECH_ARMORED_ELEPHANT ||
    techId === TECH_SCYTHE_CHARIOT ||
    techId === TECH_PHALANX ||
    techId === TECH_CENTURION ||
    techId === TECH_CATAPULT ||
    techId === TECH_HEAVY_CATAPULT ||
    techId === TECH_HELEPOLIS ||
    techId === TECH_WAR_GALLEY ||
    techId === TECH_TRIREME
  );
}

interface ArmyPresence {
  hasInfantry: boolean;
  hasArchers: boolean;
  hasCavalry: boolean;
  hasSiege: boolean;
  hasPriests: boolean;
  hasFishingBoats: boolean;
  hasWarships: boolean;
  hasEnemyCavalry: boolean;
  enemyNearBase: boolean;
}

function analyzeArmyPresence(obs: BotObservation): ArmyPresence {
  let hasInfantry = Boolean(obs.enabledMasters[SHORT_SWORDSMAN]?.enabled || obs.enabledMasters[HOPLITE]?.enabled);
  let hasArchers = Boolean(
    obs.enabledMasters[IMPROVED_BOWMAN]?.enabled ||
      obs.enabledMasters[HORSE_ARCHER]?.enabled ||
      obs.enabledMasters[CHARIOT_ARCHER]?.enabled ||
      obs.enabledMasters[ELEPHANT_ARCHER]?.enabled ||
      obs.enabledMasters[BOWMAN]?.enabled,
  );
  let hasCavalry = Boolean(
    obs.enabledMasters[CAVALRY]?.enabled ||
      obs.enabledMasters[CHARIOT]?.enabled ||
      obs.enabledMasters[WAR_ELEPHANT]?.enabled ||
      obs.enabledMasters[CAMEL_RIDER]?.enabled,
  );
  let hasSiege = Boolean(obs.enabledMasters[STONE_THROWER]?.enabled || obs.enabledMasters[BALLISTA]?.enabled);
  let hasPriests = false;
  let hasFishingBoats = false;
  let hasWarships = false;

  for (const u of obs.ownUnits) {
    if (u.type === CLUBMAN || u.type === SHORT_SWORDSMAN || u.type === HOPLITE || u.type === ASIAN_SPEARMAN) {
      hasInfantry = true;
    } else if (u.type === BOWMAN || u.type === IMPROVED_BOWMAN || u.type === HORSE_ARCHER || u.type === CHARIOT_ARCHER || u.type === ELEPHANT_ARCHER) {
      hasArchers = true;
    } else if (u.type === CAVALRY || u.type === CHARIOT || u.type === WAR_ELEPHANT || u.type === CAMEL_RIDER || u.type === SCOUT) {
      hasCavalry = true;
    } else if (u.type === STONE_THROWER || u.type === BALLISTA) {
      hasSiege = true;
    } else if (u.type === PRIEST) {
      hasPriests = true;
    } else if (u.type === 13) {
      hasFishingBoats = true;
    } else if (NAVAL_WARSHIP_IDS.has(u.type)) {
      hasWarships = true;
    }
  }

  let hasEnemyCavalry = false;
  let enemyNearBase = false;
  const tc = obs.ownBuildings.find((b) => b.type === TOWN_CENTER && isBuildingAliveAndActive(b));
  for (const enemy of obs.knownEnemies) {
    if (!enemy.visibleNow) continue;
    const em = obs.enabledMasters[enemy.type];
    if (em && CAVALRY_GROUP_IDS.has(em.group)) {
      hasEnemyCavalry = true;
    }
    if (tc && Math.hypot(enemy.x - tc.x, enemy.y - tc.y) < 18) {
      enemyNearBase = true;
    }
  }

  return {
    hasInfantry,
    hasArchers,
    hasCavalry,
    hasSiege,
    hasPriests,
    hasFishingBoats,
    hasWarships,
    hasEnemyCavalry,
    enemyNearBase,
  };
}

function scoreTechCandidate(
  techId: number,
  orderIndex: number,
  obs: BotObservation,
  profile: BotProfile,
  presence: ArmyPresence,
): number {
  let score = 60 - orderIndex * 0.5;

  if (ECO_TECH_IDS.has(techId)) {
    score = 76 - orderIndex * 0.5;
    if (techId === TECH_WOODWORKING || techId === TECH_WHEEL || techId === TECH_DOMESTICATION) {
      score += 4;
    }
  } else if (isKeyUpgradeTech(techId)) {
    score = 72 - orderIndex * 0.5;
    // Slightly prioritize primary combat lines
    if (
      techId === TECH_SHORT_SWORD ||
      techId === TECH_BROAD_SWORD ||
      techId === TECH_LONG_SWORD ||
      techId === TECH_LEGION ||
      techId === TECH_IMPROVED_BOW ||
      techId === TECH_COMPOSITE_BOW ||
      techId === TECH_HEAVY_CAVALRY ||
      techId === TECH_CATAPHRACT ||
      techId === TECH_PHALANX ||
      techId === TECH_CENTURION
    ) {
      score += 3;
    }
  }

  // Storage Pit contextual prioritization
  if (techId === TECH_TOOL_WORKING || techId === TECH_METALLURGY || techId === TECH_IRON_ATTACK) {
    score += 4;
  } else if (techId === TECH_TOOL_ARMOR_INF || techId === TECH_BRONZE_ARMOR_INF || techId === TECH_IRON_ARMOR_INF) {
    if (presence.hasInfantry) score += 3;
  } else if (techId === TECH_TOOL_ARMOR_ARCH || techId === TECH_BRONZE_ARMOR_ARCH || techId === TECH_IRON_ARMOR_ARCH) {
    if (presence.hasArchers) score += 3;
  } else if (techId === TECH_TOOL_ARMOR_CAV || techId === TECH_BRONZE_ARMOR_CAV || techId === TECH_IRON_ARMOR_CAV) {
    if (presence.hasCavalry) score += 3;
  }

  // Government Center contextual prioritization
  if (techId === TECH_NOBILITY && presence.hasCavalry) score += 4;
  if (techId === TECH_LOGISTICS && presence.hasInfantry) score += 4;
  if ((techId === TECH_ENGINEERING || techId === TECH_ALCHEMY || techId === TECH_BALLISTICS) && (presence.hasSiege || presence.hasArchers)) {
    score += 4;
  }
  if (techId === TECH_ARISTOCRACY && obs.ownBuildings.some((b) => b.type === ACADEMY && isBuildingAliveAndActive(b))) {
    score += 4;
  }

  // Prerequisite unlock boosts for Hard/Iron upgrades
  if (techId === TECH_FANATICISM && obs.techStates[TECH_LONG_SWORD] === TECH_DONE && obs.techStates[TECH_LEGION] === TECH_LOCKED) {
    score += 12;
  }
  if (techId === TECH_CRAFTSMANSHIP && obs.techStates[TECH_BALLISTA] === TECH_DONE && obs.techStates[TECH_HELEPOLIS] === TECH_LOCKED) {
    score += 6;
  }
  if (techId === TECH_SIEGECRAFT && obs.techStates[TECH_CATAPULT] === TECH_DONE && obs.techStates[TECH_HEAVY_CATAPULT] === TECH_LOCKED) {
    score += 6;
  }
  if (techId === TECH_TOWER_SHIELD && obs.techStates[TECH_WAR_ELEPHANT] === TECH_DONE && obs.techStates[TECH_ARMORED_ELEPHANT] === TECH_LOCKED) {
    score += 6;
  }

  // Low-priority optional buildings unless relevant
  if (TECHS[techId]?.location === GRANARY) {
    score = 44 - orderIndex * 0.5;
  }
  if (TECHS[techId]?.location === TEMPLE) {
    const unlocksLegion = techId === TECH_FANATICISM && obs.techStates[TECH_LONG_SWORD] === TECH_DONE && obs.techStates[TECH_LEGION] === TECH_LOCKED;
    if (!presence.hasPriests && !unlocksLegion && obs.resources.gold < 600) {
      score = 38 - orderIndex * 0.5;
    }
  }
  if (techId === TECH_FISHING_SHIP && !presence.hasFishingBoats) {
    score -= 10;
  }
  if (techId === TECH_MERCHANT_SHIP) {
    score -= 12;
  }

  // Clamp within [35, 80] so Progression Age-Up (90+) and Economy Villager/Farm (80+) outrank Research
  const capped = Math.min(79, Math.max(35, Math.round(score)));
  // Easy profile places slightly less urgency on non-eco techs
  if (profile.difficulty === 'easy' && !ECO_TECH_IDS.has(techId)) {
    return Math.max(35, capped - 4);
  }
  return capped;
}

function getEligibleTechsForBuilding(
  building: ObservedOwnBuilding,
  obs: BotObservation,
  profile: BotProfile,
  spendableBudget: Readonly<MutableBudget>,
  activeTechs: ReadonlySet<number>,
  presence: ArmyPresence,
): { techId: number; cost: ResourceClaim; priority: number }[] {
  const candidates = RESEARCH_PRIORITY_TECHS[building.type];
  if (!candidates || candidates.length === 0) return [];

  const results: { techId: number; cost: ResourceClaim; priority: number }[] = [];
  for (let idx = 0; idx < candidates.length; idx++) {
    const techId = candidates[idx]!;
    if (activeTechs.has(techId)) continue;
    if (NAVAL_TECH_IDS.has(techId) && !profile.allowNaval) continue;

    const info = TECHS[techId];
    if (!info || info.location !== building.type) continue;
    if ((obs.techStates[techId] ?? TECH_LOCKED) !== TECH_AVAILABLE) continue;
    if (getTechDepth(techId) > profile.maxResearchDepth) continue;

    const cost = getTechCostClaim(techId);
    if (!canAffordClaim(spendableBudget, cost, false)) continue;

    results.push({
      techId,
      cost,
      priority: scoreTechCandidate(techId, idx, obs, profile, presence),
    });
  }

  results.sort((a, b) => b.priority - a.priority || a.techId - b.techId);
  return results;
}

function hasPendingOrAffordableUpgradeForBuilding(
  building: ObservedOwnBuilding,
  obs: BotObservation,
  profile: BotProfile,
  spendableBudget: Readonly<MutableBudget>,
  activeTechs: ReadonlySet<number>,
): boolean {
  const candidates = RESEARCH_PRIORITY_TECHS[building.type];
  if (!candidates) return false;
  for (const techId of candidates) {
    if (activeTechs.has(techId)) continue;
    if (!isKeyUpgradeTech(techId)) continue;
    const info = TECHS[techId];
    if (!info || info.location !== building.type) continue;
    if ((obs.techStates[techId] ?? TECH_LOCKED) !== TECH_AVAILABLE) continue;
    if (getTechDepth(techId) > profile.maxResearchDepth) continue;
    const cost = getTechCostClaim(techId);
    if (canAffordClaim(spendableBudget, cost, false)) return true;
  }
  return false;
}

function countMilitaryAndQueued(obs: BotObservation, pendingActions: readonly PendingAction[]): number {
  let count = 0;
  for (const u of obs.ownUnits) {
    if (u.isMilitary) count++;
  }
  for (const b of obs.ownBuildings) {
    if (!isBuildingAliveAndActive(b)) continue;
    if (b.type === TOWN_CENTER) continue;
    for (const q of b.queuedUnits) {
      if (q.count > 0 && q.unit !== VILLAGER && q.unit !== 13 && q.unit !== 15 && q.unit !== 17) {
        count += q.count;
      }
    }
    if (b.queuedUnits.length === 0 && b.trainingUnit !== null && b.trainingUnit !== VILLAGER) {
      count += 1;
    }
  }
  for (const p of pendingActions) {
    if (p.status === 'issued' && p.commandType === 'queue' && p.trainUnitId !== undefined && p.trainUnitId !== VILLAGER) {
      count += 1;
    }
  }
  return count;
}

function getDesiredMilitaryCount(obs: BotObservation, profile: BotProfile): number {
  const nextAgeTech =
    obs.age === 1 ? TOOL_AGE : obs.age === 2 ? BRONZE_AGE : obs.age === 3 ? IRON_AGE : -1;
  const nextAgeAvailable = nextAgeTech !== -1 && obs.techStates[nextAgeTech] === TECH_AVAILABLE;

  if (obs.age <= 1) {
    if (nextAgeAvailable) return 0;
    return profile.difficulty === 'easy' ? 2 : 3;
  }
  if (obs.age === 2) {
    return profile.difficulty === 'easy' ? 6 : profile.difficulty === 'medium' ? 8 : 12;
  }
  if (obs.age === 3) {
    return profile.difficulty === 'easy' ? 10 : profile.difficulty === 'medium' ? 16 : 22;
  }
  return profile.difficulty === 'easy' ? 14 : profile.difficulty === 'medium' ? 25 : 32;
}

function isEnabledAtBuilding(obs: BotObservation, unitId: number, buildingType: number): ObservedMaster | null {
  const m = obs.enabledMasters[unitId];
  if (!m || !m.enabled) return null;
  if (m.trainLocationId !== buildingType) return null;
  return m;
}

function getUnitCombatScore(m: ObservedMaster): number {
  const maxAtk = m.combat ? m.combat.attacks.reduce((mx, a) => Math.max(mx, a.amount), 0) : 0;
  const rangeBonus = m.combat && m.combat.range > 1 ? m.combat.range * 4 : 0;
  return Math.min(220, m.hitPoints) + maxAtk * 8 + m.speed * 25 + rangeBonus;
}

function pickTrainableUnitForBuilding(
  buildingType: number,
  obs: BotObservation,
  profile: BotProfile,
  spendableBudget: Readonly<MutableBudget>,
  presence: ArmyPresence,
): { unitId: number; cost: ResourceClaim } | null {
  const check = (unitId: number): { unitId: number; cost: ResourceClaim } | null => {
    const m = isEnabledAtBuilding(obs, unitId, buildingType);
    if (!m) return null;
    const cost = getMasterCostClaim(m);
    if (!canAffordClaim(spendableBudget, cost, true)) return null;
    return { unitId, cost };
  };

  switch (buildingType) {
    case BARRACKS: {
      // Swordsman line (75: Short/Broad/Long/Legion) strictly supersedes Clubman/Axeman (73)
      const swordsman = check(SHORT_SWORDSMAN);
      if (swordsman) return swordsman;

      // In Stone/Tool Age: prefer Clubman/Axeman (73, 0 wood) when wood is scarce or Axeman is researched,
      // and use Asian Spearman (400) when anti-cavalry is needed or wood is abundant.
      const clubman = check(CLUBMAN);
      const spearman = check(ASIAN_SPEARMAN);
      if (spearman && (presence.hasEnemyCavalry || spendableBudget.wood >= 200 || !clubman)) {
        return spearman;
      }
      if (clubman) return clubman;
      if (spearman) return spearman;
      return check(SLINGER);
    }

    case ARCHERY_RANGE: {
      // Improved/Composite Bowman (5) strictly supersedes obsolete Bowman (4) when enabled & affordable
      const improved = check(IMPROVED_BOWMAN);
      const horseArcher = check(HORSE_ARCHER);
      const elephantArcher = check(ELEPHANT_ARCHER);
      const chariotArcher = check(CHARIOT_ARCHER);

      if (horseArcher && (obs.techStates[TECH_HEAVY_HORSE_ARCHER] === TECH_DONE || spendableBudget.gold >= 140 || !improved)) {
        return horseArcher;
      }
      if (elephantArcher && spendableBudget.food >= 260 && spendableBudget.gold >= 120) {
        return elephantArcher;
      }
      if (improved) return improved;
      if (chariotArcher) return chariotArcher;

      // Only fall back to obsolete Bowman (4) if Improved/Composite Bowman (5) is NOT enabled or unaffordable (e.g. Greek or 0 gold)
      const improvedMaster = isEnabledAtBuilding(obs, IMPROVED_BOWMAN, ARCHERY_RANGE);
      if (!improvedMaster || spendableBudget.gold < 20) {
        return check(BOWMAN);
      }
      return null;
    }

    case STABLE: {
      // Combat cavalry/chariot/elephant lines strictly supersede Scout (299)
      const candidates = [WAR_ELEPHANT, CAVALRY, CAMEL_RIDER, CHARIOT]
        .map((id) => {
          const res = check(id);
          if (!res) return null;
          const m = obs.enabledMasters[id]!;
          let score = getUnitCombatScore(m);
          if (id === CAVALRY) {
            if (obs.techStates[TECH_CATAPHRACT] === TECH_DONE) score += 60;
            else if (obs.techStates[TECH_HEAVY_CAVALRY] === TECH_DONE) score += 35;
          }
          if (id === WAR_ELEPHANT && obs.techStates[TECH_ARMORED_ELEPHANT] === TECH_DONE) {
            score += 60;
          }
          if (id === CHARIOT && obs.techStates[TECH_SCYTHE_CHARIOT] === TECH_DONE) {
            score += 50;
          }
          if (id === CAMEL_RIDER && presence.hasEnemyCavalry) {
            score += 45;
          }
          return { ...res, score };
        })
        .filter((x): x is { unitId: number; cost: ResourceClaim; score: number } => x !== null);

      if (candidates.length > 0) {
        candidates.sort((a, b) => b.score - a.score || a.unitId - b.unitId);
        return { unitId: candidates[0]!.unitId, cost: candidates[0]!.cost };
      }

      // Only train Scout if higher Stable lines are NOT enabled and we have < 2 Scouts
      const hasCombatStableLine =
        Boolean(isEnabledAtBuilding(obs, CAVALRY, STABLE)) ||
        Boolean(isEnabledAtBuilding(obs, CHARIOT, STABLE)) ||
        Boolean(isEnabledAtBuilding(obs, WAR_ELEPHANT, STABLE)) ||
        Boolean(isEnabledAtBuilding(obs, CAMEL_RIDER, STABLE));
      const scoutCount = obs.ownUnits.filter((u) => u.type === SCOUT).length;
      if (!hasCombatStableLine && scoutCount < 2) {
        return check(SCOUT);
      }
      return null;
    }

    case ACADEMY:
      return check(HOPLITE);

    case SIEGE_WORKSHOP: {
      const catapult = check(STONE_THROWER);
      const ballista = check(BALLISTA);
      if (catapult && ballista) {
        const catCount = obs.ownUnits.filter((u) => u.type === STONE_THROWER).length;
        const balCount = obs.ownUnits.filter((u) => u.type === BALLISTA).length;
        const catUpgraded = obs.techStates[TECH_CATAPULT] === TECH_DONE || obs.techStates[TECH_HEAVY_CATAPULT] === TECH_DONE;
        const balUpgraded = obs.techStates[TECH_HELEPOLIS] === TECH_DONE;
        if (catUpgraded !== balUpgraded) {
          return catUpgraded ? catapult : ballista;
        }
        return balCount < catCount ? ballista : catapult;
      }
      return catapult ?? ballista;
    }

    case DOCK: {
      if (!profile.allowNaval || obs.age < 2 || spendableBudget.wood < 200) return null;
      const warshipCount = obs.ownUnits.filter((u) => NAVAL_WARSHIP_IDS.has(u.type)).length;
      if (warshipCount >= 4) return null;
      return check(CATAPULT_TRIREME) ?? check(FIRE_GALLEY) ?? check(SCOUT_SHIP);
    }

    default:
      return null;
  }
}

export class ResearchPlanner implements BotPlanner {
  readonly name = 'research';

  propose(input: PlannerInput): BotIntent[] {
    const { observation: obs, profile, state, pendingActions } = input;
    const activePending = pendingActions.filter((p) => p.status === 'issued');
    const available = computeAvailableBudget(obs, activePending);

    const villagerCount = obs.ownUnits.filter((u) => u.isVillager).length;
    const presence = analyzeArmyPresence(obs);

    const ageReserve = computeAgeReserve(obs, available, villagerCount, activePending);

    // Economy / Villager reserve so military training doesn't starve early villager production
    const villagerMaster = obs.enabledMasters[VILLAGER];
    const villagerEnabled = villagerMaster ? villagerMaster.enabled : villagerCount > 0;
    const tcCanTrainVillager =
      villagerCount < profile.targetVillagers &&
      available.headroom > 0 &&
      villagerEnabled &&
      obs.ownBuildings.some(
        (b) =>
          b.type === TOWN_CENTER &&
          isBuildingAliveAndActive(b) &&
          b.researchingTech === null &&
          getQueueCount(b) < 2 &&
          !activePending.some((p) => p.buildingId === b.id),
      );

    const villagerFoodReserve = tcCanTrainVillager ? 50 : 0;
    const villagerHeadroomReserve =
      tcCanTrainVillager && villagerCount < Math.min(8, profile.targetVillagers) ? 1 : 0;
    const houseWoodReserve =
      available.headroom <= 2 && villagerCount > 0 ? Math.round(100 * profile.ecoReserveRatio) : 0;

    // Spendable budget for Research (respects Age-Up reserve; also keeps villager reserve if food is very low & < 5 vils)
    const techBudget: MutableBudget = {
      food: Math.max(0, available.food - (ageReserve.food ?? 0)),
      wood: Math.max(0, available.wood - (ageReserve.wood ?? 0)),
      stone: Math.max(0, available.stone - (ageReserve.stone ?? 0)),
      gold: Math.max(0, available.gold - (ageReserve.gold ?? 0)),
      headroom: available.headroom,
    };

    const activeTechs = new Set<number>();
    const claimedBuildings = new Set<number>();

    for (let t = 0; t < obs.techStates.length; t++) {
      if ((obs.techStates[t] ?? TECH_LOCKED) >= 2) {
        activeTechs.add(t);
      }
    }
    for (const b of obs.ownBuildings) {
      if (isBuildingAliveAndActive(b) && b.researchingTech !== null) {
        activeTechs.add(b.researchingTech);
      }
    }
    for (const p of activePending) {
      if (p.techId !== undefined) activeTechs.add(p.techId);
      if (p.buildingId !== undefined) claimedBuildings.add(p.buildingId);
    }

    const intents: BotIntent[] = [];

    // 1. Technology Research & Unit Upgrades
    const sortedBuildings = [...obs.ownBuildings].sort((a, b) => a.id - b.id);
    const researchProposals: {
      building: ObservedOwnBuilding;
      techId: number;
      cost: ResourceClaim;
      priority: number;
    }[] = [];

    for (const b of sortedBuildings) {
      if (!isBuildingAvailableForResearch(b, obs.turn, state, claimedBuildings)) continue;
      const eligible = getEligibleTechsForBuilding(b, obs, profile, techBudget, activeTechs, presence);
      for (const candidate of eligible) {
        researchProposals.push({ building: b, ...candidate });
      }
    }

    // Sort globally across buildings by priority desc so higher-priority research claims shared tech/budget first
    researchProposals.sort((a, b) => b.priority - a.priority || a.techId - b.techId || a.building.id - b.building.id);

    for (const prop of researchProposals) {
      if (activeTechs.has(prop.techId) || claimedBuildings.has(prop.building.id)) continue;
      if (!canAffordClaim(techBudget, prop.cost, false)) continue;

      activeTechs.add(prop.techId);
      claimedBuildings.add(prop.building.id);
      spendClaim(techBudget, prop.cost);

      intents.push({
        key: `${KEY_RESEARCH_PREFIX}${prop.techId}:${prop.building.id}`,
        priority: prop.priority,
        reason: `Research tech ${prop.techId} at building ${prop.building.type}`,
        cost: prop.cost,
        buildingId: prop.building.id,
        command: { type: 'research', building: prop.building.id, tech: prop.techId },
      });
    }

    // 2. Military Unit Training (respecting post-upgrade masters, reserves, and maxMilitaryTrainPerTick)
    const trainBudget: MutableBudget = {
      food: Math.max(0, techBudget.food - villagerFoodReserve),
      wood: Math.max(0, techBudget.wood - houseWoodReserve),
      stone: techBudget.stone,
      gold: techBudget.gold,
      headroom: Math.max(0, techBudget.headroom - villagerHeadroomReserve),
    };

    const currentMilitary = countMilitaryAndQueued(obs, activePending);
    const desiredMilitary = getDesiredMilitaryCount(obs, profile);
    let remainingToTrain = Math.max(0, desiredMilitary - currentMilitary);
    let trainIntentsIssued = 0;

    if (remainingToTrain > 0 && trainBudget.headroom > 0 && profile.maxMilitaryTrainPerTick > 0) {
      for (const bType of MILITARY_TRAINING_BUILDINGS) {
        if (trainIntentsIssued >= profile.maxMilitaryTrainPerTick || remainingToTrain <= 0 || trainBudget.headroom <= 0) {
          break;
        }
        const buildingsOfType = sortedBuildings.filter((b) => b.type === bType);
        for (const b of buildingsOfType) {
          if (trainIntentsIssued >= profile.maxMilitaryTrainPerTick || remainingToTrain <= 0 || trainBudget.headroom <= 0) {
            break;
          }
          if (!isBuildingAvailableForQueue(b, obs.turn, state, claimedBuildings)) continue;

          // Avoid permanently starving an affordable key unit upgrade at this building unless emergency defense is needed
          const urgentDefense = presence.enemyNearBase && currentMilitary < 2;
          if (
            !urgentDefense &&
            getQueueCount(b) >= 1 &&
            hasPendingOrAffordableUpgradeForBuilding(b, obs, profile, techBudget, activeTechs)
          ) {
            continue;
          }

          const pick = pickTrainableUnitForBuilding(bType, obs, profile, trainBudget, presence);
          if (!pick) continue;

          claimedBuildings.add(b.id);
          spendClaim(trainBudget, pick.cost);
          trainIntentsIssued++;
          remainingToTrain--;

          const priority = urgentDefense ? 68 : currentMilitary < profile.minAttackSquadSize ? 60 : 52;
          intents.push({
            key: `${KEY_QUEUE_MIL_PREFIX}${b.id}:${pick.unitId}`,
            priority,
            reason: `Train military unit ${pick.unitId} at building ${bType}`,
            cost: pick.cost,
            buildingId: b.id,
            command: { type: 'queue', building: b.id, unit: pick.unitId, count: 1 },
          });
        }
      }
    }

    return intents;
  }

  commit(outcomes: Readonly<Record<string, IntentOutcome>>, input: PlannerInput): void {
    const turn = input.observation.turn;
    for (const outcome of Object.values(outcomes)) {
      if (!outcome.accepted || !outcome.command) continue;
      if (outcome.key.startsWith(KEY_RESEARCH_PREFIX) && outcome.command.type === 'research') {
        input.state.buildingCooldownUntil[outcome.command.building] = turn + BUILDING_COOLDOWN_TURNS;
      } else if (outcome.key.startsWith(KEY_QUEUE_MIL_PREFIX) && outcome.command.type === 'queue') {
        input.state.buildingCooldownUntil[outcome.command.building] = turn + BUILDING_COOLDOWN_TURNS;
      }
    }
  }
}

export function createResearchPlanner(): ResearchPlanner {
  return new ResearchPlanner();
}
