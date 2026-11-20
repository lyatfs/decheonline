import {
  ARCHERY_RANGE,
  ATTR_FOOD,
  ATTR_HEADROOM,
  ATTR_POPULATION,
  ATTR_POPULATION_LIMIT,
  ATTR_WOOD,
  BARRACKS,
  BOWMAN,
  BRONZE_AGE,
  BUILDER,
  checkPlacement,
  CLUBMAN,
  type Command,
  FORAGE,
  FORAGER,
  GAZELLE,
  GRANARY,
  HOUSE,
  HUNTER,
  isBuilding,
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
  TOOL_AGE,
  TOWN_CENTER,
  TREES,
  VILLAGER,
  type Entity,
  type World,
} from '@aoe/sim';
import { Lockstep } from '../lockstep';
import { connect, type Link } from '../net/link';
import type { ServerMessage } from '@aoe/protocol';

const VILLAGERS: number[] = [VILLAGER, BUILDER, FORAGER, LUMBERJACK, HUNTER, MINER_STONE, MINER_GOLD, 259 /* Farmer */, 156 /* Repairman */];
const MILITARY: number[] = [CLUBMAN, BOWMAN, SCOUT, SLINGER];
const TREE_TYPES: readonly number[] = TREES;

export class AiBot {
  private link: Link | null = null;
  private lockstep: Lockstep | null = null;
  private player = 2; // Slot 1 is player 2
  private turns = 0;
  private active = true;
  private isReady = false;
  private readonly pendingBuildings = new Map<number, number>();

  constructor(
    private readonly roomCode: string,
    private readonly name: string = 'Computer (Hard)',
    private readonly preferredCiv: number = 2, // Assyrian
  ) {}

  /** Create and connect a new bot to a room code */
  static async spawn(roomCode: string, name = 'Computer (Hard)', civ = 2): Promise<AiBot> {
    const bot = new AiBot(roomCode, name, civ);
    await bot.connect();
    return bot;
  }

  async connect(): Promise<void> {
    this.link = await connect();
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
    const world = this.lockstep.world;
    const botPlayer = this.player;

    const myUnits = [...world.entities.ofPlayer(botPlayer)].filter((e) => e.state === ObjectState.Active || e.state === ObjectState.Unbuilt);
    const tc = myUnits.find((e) => e.type === TOWN_CENTER && e.state === ObjectState.Active);

    const villagers = myUnits.filter((e) => VILLAGERS.includes(e.type) && e.state === ObjectState.Active);
    const military = myUnits.filter((e) => MILITARY.includes(e.type) && e.state === ObjectState.Active);

    const food = world.attributes[botPlayer]?.[ATTR_FOOD] ?? 0;
    const wood = world.attributes[botPlayer]?.[ATTR_WOOD] ?? 0;
    const headroom = world.attributes[botPlayer]?.[ATTR_HEADROOM] ?? 0;
    const pop = world.attributes[botPlayer]?.[ATTR_POPULATION] ?? 0;
    const popLimit = world.attributes[botPlayer]?.[ATTR_POPULATION_LIMIT] ?? 50;
    const age = world.attributes[botPlayer]?.[6] ?? 1; // 1 Stone, 2 Tool, 3 Bronze, 4 Iron

    // 1. Defend if enemy is near Town Center or villagers
    const enemyEntities = [...world.entities.all()].filter(
      (e) => e.owner !== 0 && e.owner !== botPlayer && (e.state === ObjectState.Active || e.state === ObjectState.Unbuilt),
    );

    const anchorX = tc ? tc.x : (villagers[0]?.x ?? 30);
    const anchorY = tc ? tc.y : (villagers[0]?.y ?? 30);

    const closeEnemies = enemyEntities.filter((e) => Math.hypot(e.x - anchorX, e.y - anchorY) < 22);

    if (closeEnemies.length > 0 && military.length > 0) {
      const target = closeEnemies[0]!;
      this.issue({ type: 'attack', units: military.map((u) => u.id), target: target.id });
    } else if (military.length >= 4 && enemyEntities.length > 0) {
      // 2. Launch attack wave when military force is ready!
      // Priority: Enemy TC -> Enemy Military -> Enemy Villagers -> Any Enemy building
      const enemyTC = enemyEntities.find((e) => e.type === TOWN_CENTER);
      const enemyUnits = enemyEntities.filter((e) => MILITARY.includes(e.type) || VILLAGERS.includes(e.type));
      const target = enemyTC ?? enemyUnits[0] ?? enemyEntities[0]!;
      this.issue({ type: 'attack', units: military.map((u) => u.id), target: target.id });
    }

    // Helper to check if a building exists or is currently being walked to/constructed
    const hasBuilding = (type: number) => {
      if (myUnits.some((e) => e.type === type)) {
        this.pendingBuildings.delete(type);
        return true;
      }
      const until = this.pendingBuildings.get(type);
      if (until !== undefined) {
        if (this.turns < until) return true;
        this.pendingBuildings.delete(type);
      }
      return false;
    };

    // 3. Population & Housing
    const hasUnbuiltHouse = myUnits.some((e) => e.type === HOUSE && e.state === ObjectState.Unbuilt);
    const housePending = (this.pendingBuildings.get(HOUSE) ?? 0) > this.turns;
    if (headroom <= 2 && pop < popLimit && !hasUnbuiltHouse && !housePending && wood >= 30 && villagers.length > 0) {
      const spot = this.findPlacement(world, HOUSE, anchorX, anchorY, 4, 12);
      if (spot) {
        const builder = villagers[villagers.length - 1]!;
        this.pendingBuildings.set(HOUSE, this.turns + 20);
        this.issue({ type: 'build', units: [builder.id], unitType: HOUSE, x: spot.x, y: spot.y });
      }
    }

    // 4. Age Advancement
    const tcResearching = tc ? Boolean(tc.research) : false;
    if (age === 1 && food >= 500 && tc && !tcResearching) {
      const hasGranary = myUnits.some((e) => e.type === GRANARY && e.state === ObjectState.Active);
      const hasStorage = myUnits.some((e) => e.type === STORAGE_PIT && e.state === ObjectState.Active);
      if (hasGranary && hasStorage) {
        this.issue({ type: 'research', building: tc.id, tech: TOOL_AGE });
      }
    } else if (age === 2 && food >= 800 && tc && !tcResearching) {
      const toolBuildings = myUnits.filter((e) => 
        (e.type === ARCHERY_RANGE || e.type === STABLE || e.type === MARKET) && 
        e.state === ObjectState.Active
      );
      if (toolBuildings.length >= 2) {
        this.issue({ type: 'research', building: tc.id, tech: BRONZE_AGE });
      }
    }

    // 5. Economic & Military Buildings
    const hasGranary = hasBuilding(GRANARY);
    const hasStorage = hasBuilding(STORAGE_PIT);
    const hasBarracks = hasBuilding(BARRACKS);
    const hasArchery = hasBuilding(ARCHERY_RANGE);
    const hasStable = hasBuilding(STABLE);

    if (!hasGranary && wood >= 120 && villagers.length > 2) {
      const spot = this.findPlacement(world, GRANARY, anchorX, anchorY, 4, 14);
      if (spot) {
        this.pendingBuildings.set(GRANARY, this.turns + 30);
        this.issue({ type: 'build', units: [villagers[0]!.id], unitType: GRANARY, x: spot.x, y: spot.y });
      }
    } else if (!hasStorage && wood >= 120 && villagers.length > 3) {
      const spot = this.findPlacement(world, STORAGE_PIT, anchorX, anchorY, 4, 14);
      if (spot) {
        this.pendingBuildings.set(STORAGE_PIT, this.turns + 30);
        this.issue({ type: 'build', units: [villagers[1]!.id], unitType: STORAGE_PIT, x: spot.x, y: spot.y });
      }
    } else if (!hasBarracks && wood >= 150 && villagers.length > 4) {
      const spot = this.findPlacement(world, BARRACKS, anchorX, anchorY, 6, 16);
      if (spot) {
        this.pendingBuildings.set(BARRACKS, this.turns + 30);
        this.issue({ type: 'build', units: [villagers[2]!.id], unitType: BARRACKS, x: spot.x, y: spot.y });
      }
    } else if (age >= 2 && !hasArchery && wood >= 150 && villagers.length > 5) {
      const spot = this.findPlacement(world, ARCHERY_RANGE, anchorX, anchorY, 6, 16);
      if (spot) {
        this.pendingBuildings.set(ARCHERY_RANGE, this.turns + 30);
        this.issue({ type: 'build', units: [villagers[3]!.id], unitType: ARCHERY_RANGE, x: spot.x, y: spot.y });
      }
    } else if (age >= 2 && !hasStable && wood >= 150 && villagers.length > 6) {
      const spot = this.findPlacement(world, STABLE, anchorX, anchorY, 6, 16);
      if (spot) {
        this.pendingBuildings.set(STABLE, this.turns + 30);
        this.issue({ type: 'build', units: [villagers[4]!.id], unitType: STABLE, x: spot.x, y: spot.y });
      }
    }

    // 6. Unit Training
    // Train villagers at Town Center
    const tcQueueCount = (tc?.queue?.length ?? 0) + (tc?.train ? 1 : 0);
    if (tc && !tcResearching && tcQueueCount < 2 && food >= 50 && villagers.length < 24 && headroom > 0) {
      this.issue({ type: 'queue', building: tc.id, unit: VILLAGER, count: 1 });
    }

    // Train military at Barracks
    const barracks = myUnits.find((e) => e.type === BARRACKS && e.state === ObjectState.Active);
    const barracksQueueCount = (barracks?.queue?.length ?? 0) + (barracks?.train ? 1 : 0);
    if (barracks && barracksQueueCount < 2 && food >= 50 && headroom > 0 && military.length < 15) {
      this.issue({ type: 'queue', building: barracks.id, unit: CLUBMAN, count: 1 });
    }

    // Train Bowman at Archery Range
    const range = myUnits.find((e) => e.type === ARCHERY_RANGE && e.state === ObjectState.Active);
    const rangeQueueCount = (range?.queue?.length ?? 0) + (range?.train ? 1 : 0);
    if (range && rangeQueueCount < 2 && wood >= 40 && food >= 20 && headroom > 0 && military.length < 15) {
      this.issue({ type: 'queue', building: range.id, unit: BOWMAN, count: 1 });
    }

    // Train Scout at Stable
    const stable = myUnits.find((e) => e.type === STABLE && e.state === ObjectState.Active);
    const stableQueueCount = (stable?.queue?.length ?? 0) + (stable?.train ? 1 : 0);
    if (stable && stableQueueCount < 2 && food >= 70 && headroom > 0 && military.length < 15) {
      this.issue({ type: 'queue', building: stable.id, unit: SCOUT, count: 1 });
    }

    // 7. Villager Tasks & Resource Gathering
    // Find unbuilt foundations to construct
    const unbuiltBuildings = myUnits.filter((e) => isBuilding(master(world, botPlayer, e.type)) && e.state === ObjectState.Unbuilt);
    if (unbuiltBuildings.length > 0 && villagers.length > 0) {
      const b = unbuiltBuildings[0]!;
      // Assign an idle villager to assist building
      const idleVillager = villagers.find((v) => !v.work && !v.attack && (v.mover?.path?.length ?? 0) === 0);
      if (idleVillager) {
        this.issue({ type: 'work', units: [idleVillager.id], target: b.id, x: b.x, y: b.y });
      }
    }

    // Assign idle villagers to food, wood, gold, stone
    const idleVillagers = villagers.filter((v) => !v.work && !v.attack && (v.mover?.path?.length ?? 0) === 0);
    if (idleVillagers.length > 0) {
      const allObjects = [...world.entities.all()].filter((e) => e.state === ObjectState.Active);
      const berries = allObjects.filter((e) => e.owner === 0 && e.type === FORAGE);
      const trees = allObjects.filter((e) => e.owner === 0 && TREE_TYPES.includes(e.type));
      const goldMines = allObjects.filter((e) => e.owner === 0 && e.type === MINE_GOLD);
      const stoneMines = allObjects.filter((e) => e.owner === 0 && e.type === MINE_STONE);
      const gazelles = allObjects.filter((e) => e.owner === 0 && e.type === GAZELLE);

      for (const v of idleVillagers) {
        // Prioritize: Berries / Gazelle if food < 200, else Trees for wood, else Gold/Stone
        let target: Entity | undefined;
        if (food < 250 && berries.length > 0) {
          target = this.nearest(berries, v.x, v.y);
        } else if (food < 250 && gazelles.length > 0) {
          target = this.nearest(gazelles, v.x, v.y);
        } else if (trees.length > 0) {
          target = this.nearest(trees, v.x, v.y);
        } else if (goldMines.length > 0 && age >= 2) {
          target = this.nearest(goldMines, v.x, v.y);
        } else if (stoneMines.length > 0) {
          target = this.nearest(stoneMines, v.x, v.y);
        }

        if (target) {
          this.issue({ type: 'work', units: [v.id], target: target.id, x: target.x, y: target.y });
        }
      }
    }
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

  private findPlacement(world: World, unitType: number, cx: number, cy: number, minDist: number, maxDist: number): { x: number; y: number } | null {
    const ctx = world.gameContext();
    const m = master(world, this.player, unitType);

    for (let dist = minDist; dist <= maxDist; dist += 2) {
      for (let dx = -dist; dx <= dist; dx += 2) {
        for (let dy = -dist; dy <= dist; dy += 2) {
          if (Math.abs(dx) !== dist && Math.abs(dy) !== dist) continue;
          const x = Math.round(cx + dx);
          const y = Math.round(cy + dy);
          if (x < 3 || x >= world.map.width - 3 || y < 3 || y >= world.map.height - 3) continue;
          if (checkPlacement(ctx, m, x, y, true, true, -1) === 0) {
            return { x, y };
          }
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
