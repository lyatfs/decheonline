import {
  ARCHERY_RANGE,
  ASIAN_SPEARMAN,
  ATTR_FOOD,
  ATTR_GOLD,
  ATTR_HEADROOM,
  ATTR_POPULATION,
  ATTR_POPULATION_LIMIT,
  ATTR_STONE,
  ATTR_WOOD,
  ATTACK_ATTACKING,
  ATTACK_MOVING,
  ATTACK_WAITING,
  BARRACKS,
  BOWMAN,
  BRONZE_AGE,
  BUILDER,
  checkObjCost,
  checkPlacement,
  checkTechCost,
  CLUBMAN,
  COMMAND_DELAY_TURNS,
  type Command,
  ELEPHANT,
  type Entity,
  FARM,
  FORAGE,
  FORAGER,
  GAZELLE,
  GRANARY,
  HOUSE,
  HUNTER,
  IRON_AGE,
  isBuilding,
  isEnabled,
  isEnemy,
  LUMBERJACK,
  MARKET,
  master,
  MINE_GOLD,
  MINE_STONE,
  MINER_GOLD,
  MINER_STONE,
  ObjectState,
  SCOUT,
  SLINGER,
  STABLE,
  STORAGE_PIT,
  TECH_AVAILABLE,
  TECHS,
  TILE_BLACK,
  TILE_VISIBLE,
  toInt,
  TOOL_AGE,
  TOWN_CENTER,
  TREES,
  VILLAGER,
  type World,
} from '@aoe/sim';

type ZoneMap = ReturnType<World['pathing']['zones']['of']>;
import type { ServerMessage } from '@aoe/protocol';
import { Lockstep } from '../lockstep';
import { connect, type Link } from '../net/link';

const ATTR_AGE = 6;
const GROUP_BUILDING = 3;
const GROUP_WALL = 27;

const ACADEMY = 0;
const DOCK = 45;
const SIEGE_WORKSHOP = 49;
const GOVERNMENT_CENTER = 82;
const TEMPLE = 104;

const FISHING_BOAT = 13;
const FISHERMAN = 119;
const REPAIRMAN = 156;
const FARMER = 259;

const SHORE_FISH: readonly number[] = [260, 263];
const ALL_FISH: readonly number[] = [53, 260, 263, 370];

const VILLAGERS: readonly number[] = [
  VILLAGER,
  BUILDER,
  FISHERMAN,
  FORAGER,
  LUMBERJACK,
  HUNTER,
  MINER_STONE,
  MINER_GOLD,
  FARMER,
  REPAIRMAN,
];
const TREE_TYPES: readonly number[] = TREES;

// Military training priority per building (highest tier enabled & affordable wins)
const BARRACKS_UNITS: readonly number[] = [75 /* Short Swordsman+ */, ASIAN_SPEARMAN, SLINGER, CLUBMAN];
const RANGE_UNITS: readonly number[] = [39 /* Horse Archer */, 25 /* Elephant Archer */, 41 /* Chariot Archer */, 5 /* Improved Bowman+ */, BOWMAN];
const STABLE_UNITS: readonly number[] = [46 /* War Elephant */, 37 /* Cavalry+ */, 338 /* Camel */, 40 /* Chariot */, SCOUT];
const ACADEMY_UNITS: readonly number[] = [93 /* Hoplite+ */];
const SIEGE_UNITS: readonly number[] = [11 /* Ballista+ */, 35 /* Stone Thrower+ */];

// Priority tech upgrades per building
const PRIORITY_TECHS: Readonly<Record<number, readonly number[]>> = {
  [MARKET]: [107, 81, 28, 31, 80, 108, 109, 110, 32],
  [BARRACKS]: [63, 64, 65, 66, 77],
  [ARCHERY_RANGE]: [56, 57, 59, 60, 61],
  [STABLE]: [69, 68, 70, 71, 78, 125, 126],
  [STORAGE_PIT]: [40, 41, 42, 46, 43, 44, 45, 47, 51, 48, 49, 50, 52, 117, 122],
  [GOVERNMENT_CENTER]: [34, 112, 121, 37, 106],
  [ACADEMY]: [73, 79],
  [SIEGE_WORKSHOP]: [54, 36, 27, 58],
  [DOCK]: [4, 3, 5, 6, 7],
};

const COOLDOWN_TURNS = COMMAND_DELAY_TURNS + 2; // Covers lockstep onTurn + command delay
const PENDING_BUILD_TTL = COMMAND_DELAY_TURNS + 6;

interface PendingSpot {
  type: number;
  x: number;
  y: number;
  until: number;
}

interface ResourceBudget {
  food: number;
  wood: number;
  stone: number;
  gold: number;
  headroom: number;
}

export class AiBot {
  private link: Link | null = null;
  private lockstep: Lockstep | null = null;
  private turns = 0;
  private active = true;
  private isReady = false;
  private readonly pendingBuildSpots: PendingSpot[] = [];
  private readonly unitCooldownUntil = new Map<number, number>();
  private readonly buildingCooldownUntil = new Map<number, number>();

  constructor(
    private readonly roomCode: string = '',
    private readonly name: string = 'Computer (Hard)',
    private readonly preferredCiv: number = 2, // Greek by default
    private player: number = 2, // Slot 1 is player 2
  ) {}

  /** Create and connect a new bot to a room code. */
  static async spawn(roomCode: string, name = 'Computer (Hard)', civ = 2): Promise<AiBot> {
    const bot = new AiBot(roomCode, name, civ);
    await bot.connect();
    return bot;
  }

  async connect(): Promise<void> {
    const link = await connect();
    if (!this.active) {
      link.close();
      return;
    }
    this.link = link;
    this.link.send({ t: 'join', code: this.roomCode, name: this.name });

    this.link.onMessage((m: ServerMessage) => {
      if (!this.active) return;

      if (m.t === 'lobby') {
        this.player = m.you + 1;
        if (!this.isReady) {
          this.isReady = true;
          this.link?.send({ t: 'civ', civ: this.preferredCiv });
          this.link?.send({ t: 'ready', ready: true });
        }
      } else if (m.t === 'start') {
        this.onGameStart(m);
      }
    });

    this.link.onClose(() => {
      this.destroy();
    });
  }

  private onGameStart(start: Extract<ServerMessage, { t: 'start' }>): void {
    if (!this.link) return;

    this.lockstep = new Lockstep({
      link: this.link,
      speed: 1,
      start: {
        seed: start.seed,
        commandDelay: start.commandDelay,
        playerCount: start.players.length,
        settings: start.settings,
        civs: start.players.map((p) => p.civ),
        rejoin: { code: this.roomCode, slot: this.player - 1, token: start.token },
      },
    });

    this.lockstep.onTurn = () => {
      if (!this.active || !this.lockstep) return;
      this.turns++;
      // Think every 2 turns (~1.5-2 seconds of game time)
      if (this.turns % 2 === 0) {
        this.think();
      }
    };
  }

  private think(): void {
    if (!this.lockstep) return;
    const commands = this.step(this.lockstep.world);
    for (const cmd of commands) {
      this.issue(cmd);
    }
  }

  /**
   * Evaluate `world` for this bot's player and return commands to issue.
   * Exposed publicly so unit/integration tests can drive `AiBot` against a real `@aoe/sim` `World`.
   */
  step(world: World): Command[] {
    const commands: Command[] = [];
    const emit = (cmd: Command) => {
      commands.push(cmd);
    };

    const botPlayer = this.player;
    const turn = world.turn;

    // Expire stale pending build reservations & clean ones whose entity is now on map
    const myUnits = [...world.entities.ofPlayer(botPlayer)].filter(
      (e) => e.state === ObjectState.Active || e.state === ObjectState.Unbuilt,
    );
    for (let i = this.pendingBuildSpots.length - 1; i >= 0; i--) {
      const p = this.pendingBuildSpots[i]!;
      const materialized = myUnits.some((e) => e.type === p.type && Math.hypot(e.x - p.x, e.y - p.y) < 1);
      if (materialized || p.until <= turn) {
        this.pendingBuildSpots.splice(i, 1);
      }
    }

    const tc = myUnits.find((e) => e.type === TOWN_CENTER && e.state === ObjectState.Active);
    const villagers = myUnits.filter((e) => VILLAGERS.includes(e.type) && e.state === ObjectState.Active);
    const military = myUnits.filter((e) => e.state === ObjectState.Active && this.isLandSoldier(world, botPlayer, e));
    const fishingBoats = myUnits.filter((e) => e.type === FISHING_BOAT && e.state === ObjectState.Active);

    const attrs = world.attributes[botPlayer];
    const budget: ResourceBudget = {
      food: attrs?.[ATTR_FOOD] ?? 0,
      wood: attrs?.[ATTR_WOOD] ?? 0,
      stone: attrs?.[ATTR_STONE] ?? 0,
      gold: attrs?.[ATTR_GOLD] ?? 0,
      headroom: attrs?.[ATTR_HEADROOM] ?? 0,
    };
    const pop = attrs?.[ATTR_POPULATION] ?? 0;
    const popLimit = attrs?.[ATTR_POPULATION_LIMIT] ?? 50;
    const age = attrs?.[ATTR_AGE] ?? 1;

    const landZones = world.pathing.zones.of(master(world, botPlayer, VILLAGER));
    const seaZones = world.pathing.zones.of(master(world, botPlayer, FISHING_BOAT));

    const anchorX = tc ? tc.x : (villagers[0]?.x ?? military[0]?.x ?? 30);
    const anchorY = tc ? tc.y : (villagers[0]?.y ?? military[0]?.y ?? 30);

    // 1 & 2. Military Defense, Attack Waves, and Reachable-Zone Scouting (3.6.1 & 3.6.2)
    this.updateMilitary(world, botPlayer, turn, military, anchorX, anchorY, landZones, emit);

    // Count existing (active + unbuilt) and pending buildings of each type
    const buildingCount = (type: number): number =>
      myUnits.filter((e) => e.type === type).length + this.pendingBuildSpots.filter((p) => p.type === type).length;
    const activeBuildingsOf = (type: number): Entity[] =>
      myUnits.filter((e) => e.type === type && e.state === ObjectState.Active);
    const pendingCount = (type: number): number =>
      this.pendingBuildSpots.filter((p) => p.type === type).length;

    // 3. Age Advancement (3.6.3)
    const nextAgeTech = age === 1 ? TOOL_AGE : age === 2 ? BRONZE_AGE : age === 3 ? IRON_AGE : -1;
    const nextAgeAvailable = nextAgeTech !== -1 && world.techs[botPlayer]?.[nextAgeTech] === TECH_AVAILABLE;
    const canAffordNextAge = nextAgeAvailable && checkTechCost(world, botPlayer, nextAgeTech);
    const holdTcForAge =
      nextAgeAvailable &&
      !tc?.research &&
      ((age === 1 && budget.food >= 450 && villagers.length >= 5) ||
        (age === 2 && budget.food >= 700 && villagers.length >= 7) ||
        (age === 3 && budget.food >= 850 && budget.gold >= 600));
    const savingForAge =
      (nextAgeAvailable &&
        !canAffordNextAge &&
        ((age === 1 && villagers.length >= 10) ||
          (age === 1 && budget.food >= 350 && villagers.length >= 5) ||
          (age === 2 && budget.food >= 500 && villagers.length >= 7) ||
          (age === 3 && budget.food >= 600 && budget.gold >= 300))) ||
      (!tc?.research &&
        age === 2 &&
        budget.food < 950 &&
        villagers.length >= 7 &&
        myUnits.some((e) => e.type === MARKET && e.state === ObjectState.Active)) ||
      (!tc?.research && age === 3 && (budget.food < 1200 || budget.gold < 950) && villagers.length >= 8);

    if (tc && !this.isBuildingBusy(tc, turn) && canAffordNextAge) {
      this.spendTech(world, botPlayer, nextAgeTech, budget);
      this.buildingCooldownUntil.set(tc.id, turn + COOLDOWN_TURNS);
      emit({ type: 'research', building: tc.id, tech: nextAgeTech });
    }

    // Track villagers available for building/gathering so we don't double-command in the same turn
    // Note: finished/waiting builders and gatherers retain v.work with state 1 (DONE), 2 (IDLE), 3 (WAITING), or 13 (FAILED).
    const isWorkActive = (u: Entity): boolean =>
      Boolean(u.work && u.work.state !== 1 && u.work.state !== 2 && u.work.state !== 3 && u.work.state !== 13);
    const assignedVillagers = new Set<number>();
    const isUnitReady = (u: Entity): boolean =>
      !assignedVillagers.has(u.id) && (this.unitCooldownUntil.get(u.id) ?? 0) <= turn;
    const isIdleVillager = (v: Entity): boolean =>
      isUnitReady(v) && !isWorkActive(v) && !v.attack && !v.mover?.action;

    const pickBuilder = (preferredX: number, preferredY: number): Entity | undefined => {
      const idle = villagers.filter(isIdleVillager);
      if (idle.length > 0) return this.nearest(idle, preferredX, preferredY);
      const nonBuilder = villagers.filter(
        (v) => isUnitReady(v) && !(v.type === BUILDER && isWorkActive(v)) && v.type !== HUNTER,
      );
      return this.nearest(nonBuilder, preferredX, preferredY);
    };

    const tryBuild = (unitType: number, minDist: number, maxDist: number): boolean => {
      if (!isEnabled(world, botPlayer, unitType)) return false;
      if (!this.canAffordUnit(world, botPlayer, unitType, budget, true)) return false;
      const builder = pickBuilder(anchorX, anchorY);
      if (!builder) return false;
      const spot = this.findPlacement(world, unitType, anchorX, anchorY, minDist, maxDist, landZones, builder.x, builder.y);
      if (!spot) return false;
      this.spendUnit(world, botPlayer, unitType, budget, true);
      this.pendingBuildSpots.push({ type: unitType, x: spot.x, y: spot.y, until: turn + PENDING_BUILD_TTL });
      this.unitCooldownUntil.set(builder.id, turn + COOLDOWN_TURNS);
      assignedVillagers.add(builder.id);
      emit({ type: 'build', units: [builder.id], unitType, x: spot.x, y: spot.y });
      return true;
    };

    // Visible & reachable Gaia resources (needed for Dock/Farm decisions as well as gathering)
    // Note: Fish (53, 260, 263, 370) have 0 HP and enter ObjectState.Dead (5) on turn 1 while holding 250 food.
    const knownResources = [...world.entities.all()].filter(
      (e) =>
        e.owner === 0 &&
        (e.state === ObjectState.Active ||
          (e.state === ObjectState.Dead && ALL_FISH.includes(e.type) && e.heldAmount > 0)) &&
        this.isResourceKnown(world, e),
    );
    const berries = knownResources.filter((e) => e.type === FORAGE);
    const trees = knownResources.filter((e) => TREE_TYPES.includes(e.type));
    const goldMines = knownResources.filter((e) => e.type === MINE_GOLD);
    const stoneMines = knownResources.filter((e) => e.type === MINE_STONE);
    const gazelles = knownResources.filter((e) => e.type === GAZELLE && e.state === ObjectState.Active);
    const elephants = knownResources.filter((e) => e.type === ELEPHANT && e.state === ObjectState.Active);
    const shoreFish = knownResources.filter((e) => SHORE_FISH.includes(e.type));
    const allFish = knownResources.filter((e) => ALL_FISH.includes(e.type));
    const activeFarms = activeBuildingsOf(FARM).filter((f) => f.heldAmount > 0);

    // 4. Population & Housing (3.6.3 & 3.6.4)
    const unbuiltHouses = myUnits.filter((e) => e.type === HOUSE && e.state === ObjectState.Unbuilt).length;
    const pendingHouses = pendingCount(HOUSE);
    const plannedHouseHeadroom = (unbuiltHouses + pendingHouses) * 4;
    if (
      budget.headroom + plannedHouseHeadroom <= 4 &&
      pop + plannedHouseHeadroom < popLimit &&
      unbuiltHouses + pendingHouses < 2 &&
      villagers.length > 0
    ) {
      tryBuild(HOUSE, 4, 14);
    }

    // 5. Economic & Military Buildings Progression (3.6.3)
    const hasGranary = buildingCount(GRANARY) > 0;
    const hasStorage = buildingCount(STORAGE_PIT) > 0;
    const barracksCount = buildingCount(BARRACKS);
    const marketCount = buildingCount(MARKET);
    const rangeCount = buildingCount(ARCHERY_RANGE);
    const stableCount = buildingCount(STABLE);
    const dockCount = buildingCount(DOCK);
    const farmCount = buildingCount(FARM);

    const bronzeBuildingsCount =
      buildingCount(GOVERNMENT_CENTER) +
      buildingCount(TEMPLE) +
      buildingCount(SIEGE_WORKSHOP) +
      buildingCount(ACADEMY);

    const targetFarms = Math.min(8, Math.max(2, Math.floor(villagers.length / 2)));
    const naturalFoodExhausted =
      berries.filter((r) => this.canLandReach(landZones, anchorX, anchorY, r.x, r.y, 1.5)).length === 0 &&
      gazelles.filter((r) => this.canLandReach(landZones, anchorX, anchorY, r.x, r.y, 1.5)).length === 0 &&
      shoreFish.filter((r) => this.canLandReach(landZones, anchorX, anchorY, r.x, r.y, 1.5)).length === 0;

    let builtThisTurn = false;
    if (!builtThisTurn && !hasGranary && villagers.length >= 3) {
      builtThisTurn = tryBuild(GRANARY, 4, 14);
    }
    if (!builtThisTurn && !hasStorage && villagers.length >= 3) {
      builtThisTurn = tryBuild(STORAGE_PIT, 4, 14);
    }
    if (!builtThisTurn && barracksCount === 0 && villagers.length >= 4) {
      builtThisTurn = tryBuild(BARRACKS, 5, 16);
    }
    if (!builtThisTurn && age >= 2 && marketCount === 0 && villagers.length >= 5) {
      builtThisTurn = tryBuild(MARKET, 5, 16);
    }
    if (!builtThisTurn && age >= 2 && rangeCount === 0 && villagers.length >= 5) {
      builtThisTurn = tryBuild(ARCHERY_RANGE, 5, 16);
    }
    if (!builtThisTurn && age >= 2 && stableCount === 0 && villagers.length >= 6) {
      builtThisTurn = tryBuild(STABLE, 5, 16);
    }
    if (
      !builtThisTurn &&
      dockCount === 0 &&
      isEnabled(world, botPlayer, DOCK) &&
      villagers.length >= 6 &&
      allFish.length > 0 &&
      this.canAffordUnit(world, botPlayer, DOCK, budget, true)
    ) {
      const builder = pickBuilder(anchorX, anchorY);
      if (builder) {
        const dockSpot = this.findDockPlacement(world, landZones, seaZones, allFish, anchorX, anchorY, builder.x, builder.y);
        if (dockSpot) {
          this.spendUnit(world, botPlayer, DOCK, budget, true);
          this.pendingBuildSpots.push({ type: DOCK, x: dockSpot.x, y: dockSpot.y, until: turn + PENDING_BUILD_TTL });
          this.unitCooldownUntil.set(builder.id, turn + COOLDOWN_TURNS);
          assignedVillagers.add(builder.id);
          emit({ type: 'build', units: [builder.id], unitType: DOCK, x: dockSpot.x, y: dockSpot.y });
          builtThisTurn = true;
        }
      }
    }
    if (!builtThisTurn && barracksCount === 1 && activeBuildingsOf(BARRACKS).length >= 1 && villagers.length >= 6) {
      builtThisTurn = tryBuild(BARRACKS, 6, 18);
    }
    if (!builtThisTurn && age >= 3 && bronzeBuildingsCount < 2 && villagers.length >= 7) {
      // Build at least 2 Bronze Age buildings to unlock Iron Age (Tech 76)
      if (buildingCount(GOVERNMENT_CENTER) === 0 && isEnabled(world, botPlayer, GOVERNMENT_CENTER)) {
        builtThisTurn = tryBuild(GOVERNMENT_CENTER, 6, 20);
      }
      if (!builtThisTurn && buildingCount(SIEGE_WORKSHOP) === 0 && isEnabled(world, botPlayer, SIEGE_WORKSHOP)) {
        builtThisTurn = tryBuild(SIEGE_WORKSHOP, 6, 20);
      }
      if (!builtThisTurn && buildingCount(ACADEMY) === 0 && isEnabled(world, botPlayer, ACADEMY)) {
        builtThisTurn = tryBuild(ACADEMY, 6, 20);
      }
      if (!builtThisTurn && buildingCount(TEMPLE) === 0 && isEnabled(world, botPlayer, TEMPLE)) {
        builtThisTurn = tryBuild(TEMPLE, 6, 20);
      }
    }
    if (
      !builtThisTurn &&
      isEnabled(world, botPlayer, FARM) &&
      farmCount < targetFarms &&
      villagers.length >= 5 &&
      (naturalFoodExhausted || budget.food < 600 || (age >= 2 && farmCount < 3))
    ) {
      builtThisTurn = tryBuild(FARM, 2, 16);
    }
    if (!builtThisTurn && age >= 3 && villagers.length >= 12 && budget.wood >= 350) {
      if (rangeCount < 2 && isEnabled(world, botPlayer, ARCHERY_RANGE)) builtThisTurn = tryBuild(ARCHERY_RANGE, 6, 20);
      if (!builtThisTurn && stableCount < 2 && isEnabled(world, botPlayer, STABLE)) builtThisTurn = tryBuild(STABLE, 6, 20);
      if (!builtThisTurn && buildingCount(SIEGE_WORKSHOP) === 0 && isEnabled(world, botPlayer, SIEGE_WORKSHOP)) {
        builtThisTurn = tryBuild(SIEGE_WORKSHOP, 6, 20);
      }
      if (!builtThisTurn && buildingCount(ACADEMY) === 0 && isEnabled(world, botPlayer, ACADEMY)) {
        tryBuild(ACADEMY, 6, 20);
      }
    }

    // 6. Technology Upgrades (3.6.3 — ONLY when building has no research, no train, and empty queue!)
    if (!savingForAge) {
      const startedTechs = new Set<number>();
      for (const b of myUnits) {
        if (b.state !== ObjectState.Active || !isBuilding(master(world, botPlayer, b.type))) continue;
        if (this.isBuildingBusy(b, turn)) continue;
        const techId = this.pickAvailableTech(world, botPlayer, b.type, budget, startedTechs);
        if (techId !== -1) {
          startedTechs.add(techId);
          this.spendTech(world, botPlayer, techId, budget);
          this.buildingCooldownUntil.set(b.id, turn + COOLDOWN_TURNS);
          emit({ type: 'research', building: b.id, tech: techId });
        }
      }
    }

    // 7. Unit Training across ALL active production buildings (3.6.3)
    if (
      tc &&
      !this.isBuildingResearchingOrCooldown(tc, turn) &&
      this.queueCount(tc) < 2 &&
      !holdTcForAge &&
      !savingForAge &&
      villagers.length < 26 &&
      budget.headroom > 0 &&
      this.canAffordUnit(world, botPlayer, VILLAGER, budget, false)
    ) {
      this.spendUnit(world, botPlayer, VILLAGER, budget, false);
      this.buildingCooldownUntil.set(tc.id, turn + COOLDOWN_TURNS);
      emit({ type: 'queue', building: tc.id, unit: VILLAGER, count: 1 });
    }

    const desiredMilitary = age === 1 ? (nextAgeAvailable ? 0 : 2) : age === 2 ? 6 : 25;
    if (!savingForAge && military.length < desiredMilitary && budget.headroom > 0) {
      const trainGroups: readonly [number, readonly number[]][] = [
        [BARRACKS, BARRACKS_UNITS],
        [ARCHERY_RANGE, RANGE_UNITS],
        [STABLE, STABLE_UNITS],
        [ACADEMY, ACADEMY_UNITS],
        [SIEGE_WORKSHOP, SIEGE_UNITS],
      ];
      for (const [bType, candidates] of trainGroups) {
        for (const b of activeBuildingsOf(bType)) {
          if (budget.headroom <= 0) break;
          if (this.isBuildingResearchingOrCooldown(b, turn) || this.queueCount(b) >= 2) continue;
          const unitId = this.pickTrainableUnit(world, botPlayer, candidates, budget);
          if (unitId !== -1) {
            this.spendUnit(world, botPlayer, unitId, budget, false);
            this.buildingCooldownUntil.set(b.id, turn + COOLDOWN_TURNS);
            emit({ type: 'queue', building: b.id, unit: unitId, count: 1 });
          }
        }
      }
    }

    // Train Fishing Boats at Docks when fish exist in that Dock's sea zone
    if (fishingBoats.length < 3 && budget.headroom > 0) {
      for (const dock of activeBuildingsOf(DOCK)) {
        if (budget.headroom <= 0 || fishingBoats.length >= 3) break;
        if (this.isBuildingResearchingOrCooldown(dock, turn) || this.queueCount(dock) >= 2) continue;
        const hasSeaFish = allFish.some((f) => seaZones.withinRange(toInt(dock.x), toInt(dock.y), toInt(f.x), toInt(f.y), 2.5));
        if (hasSeaFish && this.canAffordUnit(world, botPlayer, FISHING_BOAT, budget, false)) {
          this.spendUnit(world, botPlayer, FISHING_BOAT, budget, false);
          this.buildingCooldownUntil.set(dock.id, turn + COOLDOWN_TURNS);
          emit({ type: 'queue', building: dock.id, unit: FISHING_BOAT, count: 1 });
        }
      }
    }

    // 8. Fishing Boat Gathering (3.6.3)
    for (const boat of fishingBoats) {
      if (isWorkActive(boat) || boat.mover?.action || (this.unitCooldownUntil.get(boat.id) ?? 0) > turn) continue;
      const reachableFish = allFish.filter((f) =>
        seaZones.withinRange(toInt(boat.x), toInt(boat.y), toInt(f.x), toInt(f.y), 2.5),
      );
      const fish = this.nearest(reachableFish, boat.x, boat.y);
      if (fish) {
        this.unitCooldownUntil.set(boat.id, turn + COOLDOWN_TURNS);
        emit({ type: 'work', units: [boat.id], target: fish.id, x: fish.x, y: fish.y });
      }
    }

    // 9. Villager Tasks & Resource Gathering (3.6.1 & 3.6.3)
    const unbuiltBuildings = myUnits.filter(
      (e) => isBuilding(master(world, botPlayer, e.type)) && e.state === ObjectState.Unbuilt,
    );
    for (const b of unbuiltBuildings) {
      const currentBuilders = villagers.filter((v) => isWorkActive(v) && v.work?.target === b.id).length;
      if (currentBuilders >= 2) continue;
      const idleForBuild = villagers.filter(
        (v) => isIdleVillager(v) && this.canLandReach(landZones, v.x, v.y, b.x, b.y, 2.5),
      );
      const v = this.nearest(idleForBuild, b.x, b.y);
      if (v) {
        assignedVillagers.add(v.id);
        this.unitCooldownUntil.set(v.id, turn + COOLDOWN_TURNS);
        emit({ type: 'work', units: [v.id], target: b.id, x: b.x, y: b.y });
      }
    }

    // Assign remaining idle villagers
    const remainingIdle = villagers.filter(isIdleVillager);
    if (remainingIdle.length > 0) {
      const workedTargets = new Set<number>();
      let foodWorkers = 0;
      let woodWorkers = 0;
      let goldWorkers = 0;
      let stoneWorkers = 0;

      for (const v of villagers) {
        if (isWorkActive(v) && v.work && v.work.target >= 0) workedTargets.add(v.work.target);
        if (!isWorkActive(v)) continue;
        if (v.type === FORAGER || v.type === HUNTER || v.type === FISHERMAN || v.type === FARMER) foodWorkers++;
        else if (v.type === LUMBERJACK) woodWorkers++;
        else if (v.type === MINER_GOLD) goldWorkers++;
        else if (v.type === MINER_STONE) stoneWorkers++;
      }

      // 9a. Unworked active Farms first
      const unworkedFarms = activeFarms.filter((f) => !workedTargets.has(f.id));
      for (const farm of unworkedFarms) {
        const candidates = remainingIdle.filter(
          (v) => !assignedVillagers.has(v.id) && this.canLandReach(landZones, v.x, v.y, farm.x, farm.y, 2.5),
        );
        const v = this.nearest(candidates, farm.x, farm.y);
        if (!v) continue;
        assignedVillagers.add(v.id);
        this.unitCooldownUntil.set(v.id, turn + COOLDOWN_TURNS);
        foodWorkers++;
        emit({ type: 'work', units: [v.id], target: farm.id, x: farm.x, y: farm.y });
      }

      // 9b. Elephant Group Hunting (>= 2-3 villagers in a single work command!)
      const idleAfterFarms = remainingIdle.filter((v) => !assignedVillagers.has(v.id));
      if (idleAfterFarms.length > 0 && elephants.length > 0 && (foodWorkers < Math.max(2, Math.ceil(villagers.length * 0.55)) || budget.food < 500)) {
        const ref = idleAfterFarms[0]!;
        const reachableElephants = elephants.filter((el) => this.canLandReach(landZones, ref.x, ref.y, el.x, el.y, 1.5));
        const targetEl = this.nearest(reachableElephants, ref.x, ref.y);
        const safeEasyFood =
          berries.some((r) => this.canLandReach(landZones, ref.x, ref.y, r.x, r.y, 1.5)) ||
          gazelles.some((r) => this.canLandReach(landZones, ref.x, ref.y, r.x, r.y, 1.5)) ||
          shoreFish.some((r) => this.canLandReach(landZones, ref.x, ref.y, r.x, r.y, 1.5));

        if (targetEl && !safeEasyFood) {
          const activeHunters = villagers.filter((v) => isWorkActive(v) && v.work?.target === targetEl.id).length;
          if (activeHunters >= 1) {
            assignedVillagers.add(ref.id);
            this.unitCooldownUntil.set(ref.id, turn + COOLDOWN_TURNS);
            foodWorkers++;
            emit({ type: 'work', units: [ref.id], target: targetEl.id, x: targetEl.x, y: targetEl.y });
          } else {
            const minHunters = villagers.length >= 3 ? 3 : 2;
            const group: Entity[] = idleAfterFarms.filter((v) =>
              this.canLandReach(landZones, v.x, v.y, targetEl.x, targetEl.y, 1.5),
            ).slice(0, 3);
            if (group.length < minHunters) {
              const extras = villagers.filter(
                (v) =>
                  !group.some((g) => g.id === v.id) &&
                  isUnitReady(v) &&
                  !(v.type === BUILDER && isWorkActive(v)) &&
                  v.type !== HUNTER &&
                  this.canLandReach(landZones, v.x, v.y, targetEl.x, targetEl.y, 1.5),
              );
              while (group.length < minHunters && extras.length > 0) {
                group.push(extras.shift()!);
              }
            }
            if (group.length >= minHunters) {
              for (const g of group) {
                assignedVillagers.add(g.id);
                this.unitCooldownUntil.set(g.id, turn + COOLDOWN_TURNS);
                foodWorkers++;
              }
              emit({
                type: 'work',
                units: group.map((g) => g.id),
                target: targetEl.id,
                x: targetEl.x,
                y: targetEl.y,
              });
            }
          }
        }
      }

      // 9c. Individual Idle Villager Resource Assignment
      for (const v of remainingIdle) {
        if (assignedVillagers.has(v.id)) continue;

        const rBerries = berries.filter((r) => this.canLandReach(landZones, v.x, v.y, r.x, r.y, 1.5));
        const rGazelles = gazelles.filter((r) => this.canLandReach(landZones, v.x, v.y, r.x, r.y, 1.5));
        const rShoreFish = shoreFish.filter((r) => this.canLandReach(landZones, v.x, v.y, r.x, r.y, 1.5));
        const rTrees = trees.filter((r) => this.canLandReach(landZones, v.x, v.y, r.x, r.y, 1.5));
        const rGold = goldMines.filter((r) => this.canLandReach(landZones, v.x, v.y, r.x, r.y, 1.5));
        const rStone = stoneMines.filter((r) => this.canLandReach(landZones, v.x, v.y, r.x, r.y, 1.5));

        const hasSafeFood = rBerries.length > 0 || rGazelles.length > 0 || rShoreFish.length > 0;
        const needFood =
          hasSafeFood &&
          (foodWorkers < Math.max(2, Math.ceil(villagers.length * 0.45)) ||
            (budget.food < 500 && foodWorkers <= woodWorkers + 1));
        const needGold = rGold.length > 0 && ((age >= 2 && goldWorkers < 3) || (budget.gold < 800 && age >= 3 && goldWorkers < 4));
        const needWood = rTrees.length > 0 && (woodWorkers < Math.max(2, Math.ceil(villagers.length * 0.3)) || budget.wood < 200);
        const needStone = rStone.length > 0 && stoneWorkers < 2;

        let target: Entity | undefined;
        if (needFood) {
          target =
            this.nearest(rBerries, v.x, v.y) ??
            this.nearest(rShoreFish, v.x, v.y) ??
            this.nearest(rGazelles, v.x, v.y);
          if (target) foodWorkers++;
        } else if (needGold) {
          target = this.nearest(rGold, v.x, v.y);
          if (target) goldWorkers++;
        } else if (needWood) {
          target = this.nearest(rTrees, v.x, v.y);
          if (target) woodWorkers++;
        } else if (hasSafeFood) {
          target =
            this.nearest(rBerries, v.x, v.y) ??
            this.nearest(rShoreFish, v.x, v.y) ??
            this.nearest(rGazelles, v.x, v.y);
          if (target) foodWorkers++;
        } else if (rTrees.length > 0) {
          target = this.nearest(rTrees, v.x, v.y);
          if (target) woodWorkers++;
        } else if (rGold.length > 0 && age >= 2) {
          target = this.nearest(rGold, v.x, v.y);
          if (target) goldWorkers++;
        } else if (needStone || rStone.length > 0) {
          target = this.nearest(rStone, v.x, v.y);
          if (target) stoneWorkers++;
        }

        if (target) {
          assignedVillagers.add(v.id);
          this.unitCooldownUntil.set(v.id, turn + COOLDOWN_TURNS);
          emit({ type: 'work', units: [v.id], target: target.id, x: target.x, y: target.y });
        }
      }
    }

    return commands;
  }

  private updateMilitary(
    world: World,
    botPlayer: number,
    turn: number,
    military: Entity[],
    anchorX: number,
    anchorY: number,
    landZones: ZoneMap,
    emit: (cmd: Command) => void,
  ): void {
    if (military.length === 0) return;

    const ctx = world.gameContext();
    const visibleEnemies = [...world.entities.all()].filter(
      (e) =>
        isEnemy(ctx, botPlayer, e.owner) &&
        (e.state === ObjectState.Active || e.state === ObjectState.Unbuilt) &&
        this.isEnemyVisible(world, e),
    );

    const anchorReachableEnemies = visibleEnemies.filter((e) => {
      const range = this.targetReachRange(world, e);
      return this.canLandReach(landZones, anchorX, anchorY, e.x, e.y, range);
    });

    const closeEnemies = anchorReachableEnemies
      .filter((e) => Math.hypot(e.x - anchorX, e.y - anchorY) < 22)
      .sort((a, b) => Math.hypot(a.x - anchorX, a.y - anchorY) - Math.hypot(b.x - anchorX, b.y - anchorY));

    const isActivelyEngaged = (u: Entity): boolean => {
      const a = u.attack;
      if (!a) return false;
      if (a.state !== ATTACK_MOVING && a.state !== ATTACK_WAITING && a.state !== ATTACK_ATTACKING) return false;
      if (a.target < 0) return false;
      const t = world.entities.get(a.target);
      if (!t || !isEnemy(ctx, botPlayer, t.owner)) return false;
      if (t.state !== ObjectState.Active && t.state !== ObjectState.Unbuilt) return false;
      if (!this.isEnemyVisible(world, t)) return false;
      const range = this.targetReachRange(world, t);
      return this.canLandReach(landZones, u.x, u.y, t.x, t.y, range);
    };

    const eligibleMilitary = military.filter(
      (u) => (this.unitCooldownUntil.get(u.id) ?? 0) <= turn && !isActivelyEngaged(u),
    );

    const attackedUnits = new Set<number>();

    if (closeEnemies.length > 0 && eligibleMilitary.length > 0) {
      const target = closeEnemies[0]!;
      const range = this.targetReachRange(world, target);
      const reachableGroup = eligibleMilitary.filter((u) =>
        this.canLandReach(landZones, u.x, u.y, target.x, target.y, range),
      );
      if (reachableGroup.length > 0) {
        for (const u of reachableGroup) {
          attackedUnits.add(u.id);
          this.unitCooldownUntil.set(u.id, turn + COOLDOWN_TURNS);
        }
        emit({ type: 'attack', units: reachableGroup.map((u) => u.id), target: target.id });
      }
    } else if (military.length >= 4 && visibleEnemies.length > 0 && eligibleMilitary.length > 0) {
      const pool = anchorReachableEnemies.length > 0 ? anchorReachableEnemies : visibleEnemies;
      const enemyTC = pool.find((e) => e.type === TOWN_CENTER);
      const enemyUnits = pool.filter((e) => {
        const m = master(world, e.owner, e.type);
        return (m.masterType === 70 && m.unitLevel === 4) || VILLAGERS.includes(e.type);
      });
      const target =
        enemyTC ??
        this.nearest(enemyUnits, anchorX, anchorY) ??
        this.nearest(pool, anchorX, anchorY);

      if (target) {
        const range = this.targetReachRange(world, target);
        const reachableGroup = eligibleMilitary.filter((u) =>
          this.canLandReach(landZones, u.x, u.y, target.x, target.y, range),
        );
        if (reachableGroup.length > 0) {
          for (const u of reachableGroup) {
            attackedUnits.add(u.id);
            this.unitCooldownUntil.set(u.id, turn + COOLDOWN_TURNS);
          }
          emit({ type: 'attack', units: reachableGroup.map((u) => u.id), target: target.id });
        }
      }
    }

    // Reachable-zone scouting for idle military / scouts so fog-of-war is explored legitimately
    const scouts = eligibleMilitary.filter(
      (u) => !attackedUnits.has(u.id) && !u.attack && !u.mover?.action,
    );
    for (let i = 0; i < scouts.length && i < 2; i++) {
      const scout = scouts[i]!;
      const dest = this.findScoutTarget(world, botPlayer, landZones, scout, turn + i * 7);
      if (dest) {
        this.unitCooldownUntil.set(scout.id, turn + COOLDOWN_TURNS);
        emit({ type: 'move', units: [scout.id], x: dest.x, y: dest.y });
      }
    }
  }

  private findScoutTarget(
    world: World,
    botPlayer: number,
    landZones: ZoneMap,
    unit: Entity,
    salt: number,
  ): { x: number; y: number } | null {
    const w = world.map.width;
    const h = world.map.height;
    const ux = toInt(unit.x);
    const uy = toInt(unit.y);
    if (!world.map.inBounds(ux, uy)) return null;
    const unitZone = landZones.at(w, ux, uy);

    const step = Math.max(4, Math.floor(Math.min(w, h) / 8));
    const candidates: { x: number; y: number; dist: number }[] = [];
    for (let col = 2; col < w - 2; col += step) {
      for (let row = 2; row < h - 2; row += step) {
        if (!world.map.inBounds(col, row)) continue;
        if (world.tileVisibility(botPlayer, col, row) !== TILE_BLACK) continue;
        if (landZones.at(w, col, row) !== unitZone) continue;
        candidates.push({ x: col + 0.5, y: row + 0.5, dist: Math.hypot(col - ux, row - uy) });
      }
    }
    if (candidates.length === 0) return null;
    candidates.sort((a, b) => a.dist - b.dist);
    const window = Math.min(candidates.length, 4);
    const pick = candidates[salt % window]!;
    return { x: pick.x, y: pick.y };
  }

  private isLandSoldier(world: World, player: number, e: Entity): boolean {
    const m = world.masters[player]?.[e.type];
    if (!m) return false;
    return m.masterType === 70 && m.unitLevel === 4 && m.terrainRestriction !== 3;
  }

  private isTileKnown(world: World, col: number, row: number, requireVisible: boolean): boolean {
    if (!world.map.inBounds(col, row)) return false;
    const vis = world.tileVisibility(this.player, col, row);
    return requireVisible ? vis === TILE_VISIBLE : vis !== TILE_BLACK;
  }

  private isEnemyVisible(world: World, e: Entity): boolean {
    const m = world.masters[e.owner]?.[e.type] ?? master(world, e.owner, e.type);
    const staticOrBuilding = isBuilding(m) || m.group === GROUP_BUILDING || m.group === GROUP_WALL || m.fogFlag > 0;
    return this.isTileKnown(world, toInt(e.x), toInt(e.y), !staticOrBuilding);
  }

  private isResourceKnown(world: World, e: Entity): boolean {
    const requireVisible = e.type === GAZELLE || e.type === ELEPHANT;
    return this.isTileKnown(world, toInt(e.x), toInt(e.y), requireVisible);
  }

  private targetReachRange(world: World, e: Entity): number {
    const m = world.masters[e.owner]?.[e.type] ?? master(world, e.owner, e.type);
    return isBuilding(m) ? Math.max(1.5, m.radiusX + 1.2) : 1.5;
  }

  private canLandReach(
    landZones: ZoneMap,
    fromX: number,
    fromY: number,
    targetX: number,
    targetY: number,
    range = 1.5,
  ): boolean {
    const sx = toInt(fromX);
    const sy = toInt(fromY);
    const gx = toInt(targetX);
    const gy = toInt(targetY);
    if (sx < 0 || sy < 0 || sx >= landZones.w || sy >= landZones.h) return false;
    if (gx < 0 || gy < 0 || gx >= landZones.w || gy >= landZones.h) return false;
    return landZones.withinRange(sx, sy, gx, gy, range);
  }

  private isBuildingBusy(b: Entity, turn: number): boolean {
    return (
      Boolean(b.research) ||
      Boolean(b.train) ||
      (b.queue?.length ?? 0) > 0 ||
      (this.buildingCooldownUntil.get(b.id) ?? 0) > turn
    );
  }

  private isBuildingResearchingOrCooldown(b: Entity, turn: number): boolean {
    return Boolean(b.research) || (this.buildingCooldownUntil.get(b.id) ?? 0) > turn;
  }

  private queueCount(b: Entity): number {
    return (b.queue?.length ?? 0) + (b.train ? 1 : 0);
  }

  private canAffordUnit(world: World, player: number, unitType: number, budget: ResourceBudget, ignorePop: boolean): boolean {
    const m = world.masters[player]?.[unitType];
    if (!m?.creatable) return false;
    if (!ignorePop && budget.headroom <= 0) return false;
    if (!checkObjCost(world.gameContext(), player, unitType, 1, ignorePop)) return false;
    for (const c of m.creatable.costs) {
      if (c.flag === 0) continue;
      if (c.type === ATTR_FOOD && budget.food < c.amount) return false;
      if (c.type === ATTR_WOOD && budget.wood < c.amount) return false;
      if (c.type === ATTR_STONE && budget.stone < c.amount) return false;
      if (c.type === ATTR_GOLD && budget.gold < c.amount) return false;
    }
    return true;
  }

  private spendUnit(world: World, player: number, unitType: number, budget: ResourceBudget, ignorePop: boolean): void {
    const m = world.masters[player]?.[unitType];
    if (!m?.creatable) return;
    for (const c of m.creatable.costs) {
      if (c.flag === 0) continue;
      if (c.type === ATTR_FOOD) budget.food -= c.amount;
      else if (c.type === ATTR_WOOD) budget.wood -= c.amount;
      else if (c.type === ATTR_STONE) budget.stone -= c.amount;
      else if (c.type === ATTR_GOLD) budget.gold -= c.amount;
    }
    if (!ignorePop) budget.headroom -= 1;
  }

  private canAffordTech(world: World, player: number, techId: number, budget: ResourceBudget): boolean {
    if (world.techs[player]?.[techId] !== TECH_AVAILABLE) return false;
    if (!checkTechCost(world, player, techId)) return false;
    const t = TECHS[techId];
    if (!t) return false;
    for (const c of t.costs) {
      if (c.flag === 0) continue;
      if (c.type === ATTR_FOOD && budget.food < c.amount) return false;
      if (c.type === ATTR_WOOD && budget.wood < c.amount) return false;
      if (c.type === ATTR_STONE && budget.stone < c.amount) return false;
      if (c.type === ATTR_GOLD && budget.gold < c.amount) return false;
    }
    return true;
  }

  private spendTech(world: World, player: number, techId: number, budget: ResourceBudget): void {
    const t = TECHS[techId];
    if (!t) return;
    for (const c of t.costs) {
      if (c.flag === 0) continue;
      if (c.type === ATTR_FOOD) budget.food -= c.amount;
      else if (c.type === ATTR_WOOD) budget.wood -= c.amount;
      else if (c.type === ATTR_STONE) budget.stone -= c.amount;
      else if (c.type === ATTR_GOLD) budget.gold -= c.amount;
    }
  }

  private pickTrainableUnit(world: World, player: number, candidates: readonly number[], budget: ResourceBudget): number {
    for (const id of candidates) {
      if (isEnabled(world, player, id) && this.canAffordUnit(world, player, id, budget, false)) {
        return id;
      }
    }
    return -1;
  }

  private pickAvailableTech(
    world: World,
    player: number,
    buildingType: number,
    budget: ResourceBudget,
    exclude: ReadonlySet<number>,
  ): number {
    const list = PRIORITY_TECHS[buildingType];
    if (!list) return -1;
    for (const techId of list) {
      if (exclude.has(techId)) continue;
      const info = TECHS[techId];
      if (!info || info.location !== buildingType) continue;
      if (this.canAffordTech(world, player, techId, budget)) return techId;
    }
    return -1;
  }

  private nearest(list: Entity[], x: number, y: number): Entity | undefined {
    let best: Entity | undefined;
    let bestDist = Infinity;
    for (const item of list) {
      const d = (item.x - x) ** 2 + (item.y - y) ** 2;
      if (d < bestDist) {
        bestDist = d;
        best = item;
      }
    }
    return best;
  }

  private overlapsPending(world: World, x: number, y: number, cx: number, cy: number): boolean {
    for (const p of this.pendingBuildSpots) {
      const pm = master(world, this.player, p.type);
      if (Math.abs(p.x - x) < pm.clearanceX + cx && Math.abs(p.y - y) < pm.clearanceY + cy) {
        return true;
      }
    }
    return false;
  }

  private findPlacement(
    world: World,
    unitType: number,
    cx: number,
    cy: number,
    minDist: number,
    maxDist: number,
    landZones: ZoneMap,
    reachX: number,
    reachY: number,
  ): { x: number; y: number } | null {
    const ctx = world.gameContext();
    const m = master(world, this.player, unitType);
    const halfX = m.clearanceX - Math.trunc(m.clearanceX) > 0 ? 0.5 : 0;
    const halfY = m.clearanceY - Math.trunc(m.clearanceY) > 0 ? 0.5 : 0;
    const baseX = Math.floor(cx) + halfX;
    const baseY = Math.floor(cy) + halfY;
    const reachRange = Math.max(m.clearanceX, m.clearanceY) + 1.5;

    const searchPass = (startDist: number, endDist: number, step: number): { x: number; y: number } | null => {
      for (let dist = startDist; dist <= endDist; dist += step) {
        for (let dx = -dist; dx <= dist; dx += step) {
          for (let dy = -dist; dy <= dist; dy += step) {
            if (Math.abs(dx) !== dist && Math.abs(dy) !== dist) continue;
            const x = baseX + dx;
            const y = baseY + dy;
            if (x - m.clearanceX < 1 || x + m.clearanceX >= world.map.width - 1) continue;
            if (y - m.clearanceY < 1 || y + m.clearanceY >= world.map.height - 1) continue;
            if (this.overlapsPending(world, x, y, m.clearanceX, m.clearanceY)) continue;
            if (checkPlacement(ctx, m, x, y, true, true, this.player) !== 0) continue;
            if (!this.canLandReach(landZones, reachX, reachY, x, y, reachRange)) continue;
            return { x, y };
          }
        }
      }
      return null;
    };

    // Pass 1: spaced scan within preferred radius
    const fast = searchPass(minDist, maxDist, 2);
    if (fast) return fast;

    // Pass 2: dense step-1 fallback up to radius >= 36 so congested bases never pop-cap
    return searchPass(2, Math.max(maxDist, 36), 1);
  }

  private findDockPlacement(
    world: World,
    landZones: ZoneMap,
    seaZones: ZoneMap,
    allFish: Entity[],
    cx: number,
    cy: number,
    reachX: number,
    reachY: number,
  ): { x: number; y: number } | null {
    const ctx = world.gameContext();
    const m = master(world, this.player, DOCK);
    const baseCol = Math.floor(cx);
    const baseRow = Math.floor(cy);

    for (let dist = 3; dist <= 40; dist++) {
      for (let dx = -dist; dx <= dist; dx++) {
        for (let dy = -dist; dy <= dist; dy++) {
          if (Math.abs(dx) !== dist && Math.abs(dy) !== dist) continue;
          const col = baseCol + dx;
          const row = baseRow + dy;
          const x = col + 0.5;
          const y = row + 0.5;
          if (!world.map.inBounds(col, row)) continue;
          if (this.overlapsPending(world, x, y, m.clearanceX, m.clearanceY)) continue;
          if (checkPlacement(ctx, m, x, y, true, true, this.player) !== 0) continue;
          if (!this.canLandReach(landZones, reachX, reachY, x, y, 2.5)) continue;
          const hasFish = allFish.some((f) => seaZones.withinRange(col, row, toInt(f.x), toInt(f.y), 2.5));
          if (!hasFish) continue;
          return { x, y };
        }
      }
    }
    return null;
  }

  private issue(command: Command): void {
    if (this.lockstep && this.active) {
      this.lockstep.issue(command);
    }
  }

  destroy(): void {
    this.active = false;
    if (this.lockstep) {
      this.lockstep.stop();
      this.lockstep = null;
    }
    if (this.link) {
      this.link.close();
      this.link = null;
    }
  }
}
