import {
  ALLIGATOR,
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
  BUILDER,
  checkPlacement,
  ELEPHANT,
  FORAGER,
  GAZELLE,
  hasMaster,
  HUNTER,
  isBuilding,
  isEnemy,
  LION,
  LUMBERJACK,
  master,
  MINER_GOLD,
  MINER_STONE,
  MOVE_DONE,
  MOVE_FAILED,
  ObjectState,
  REPAIR_MAN,
  TILE_BLACK,
  TILE_FOGGED,
  TILE_VISIBLE,
  toInt,
  typeOf,
  VILLAGER,
  WORK_DONE,
  WORK_FAILED,
  WORK_IDLE,
  WORK_WAITING,
  type Entity,
  type UnitType,
  type World,
} from '@aoe/sim';
import {
  BOT_CONTRACT_VERSION,
  type BotObservation,
  type BotPlannerMemory,
  type ObservedEnemy,
  type ObservedMaster,
  type ObservedOwnBuilding,
  type ObservedOwnUnit,
  type ObservedResource,
  type RememberedEntity,
} from './types';

const ATTR_AGE = 6;
const DOCK = 45;
const FISHERMAN = 119;
const FARMER = 259;
const MASTER_TYPE_MISSILE = 60;
const MASTER_TYPE_UNIT = 70;
const GROUP_BUILDING = 3;
const GROUP_CIVILIAN = 4;
const GROUP_HUNTED_ANIMAL = 9;
const GROUP_PREDATOR = 10;
const GROUP_MISSILE = 11;
const GROUP_TRADE_BOAT = 2;
const GROUP_TRANSPORT_BOAT = 20;
const GROUP_FISHING_BOAT = 21;
const GROUP_WAR_BOAT = 22;
const GROUP_WALL = 27;
const TERRAIN_RESTRICTION_WATER = 3;
const UNIT_LEVEL_MILITARY = 4;

const ALL_FISH = new Set<number>([53, 260, 263, 370]);
const HARMLESS_PREDATOR_ID = 157;

const VILLAGER_TYPES = new Set<number>([
  VILLAGER,
  BUILDER,
  FISHERMAN,
  FORAGER,
  LUMBERJACK,
  HUNTER,
  MINER_STONE,
  MINER_GOLD,
  FARMER,
  REPAIR_MAN,
]);

const NAVAL_GROUPS = new Set<number>([
  GROUP_TRADE_BOAT,
  GROUP_TRANSPORT_BOAT,
  GROUP_FISHING_BOAT,
  GROUP_WAR_BOAT,
]);

export function createEmptyBotMemory(): BotPlannerMemory {
  return {
    enemiesById: {},
    resourcesById: {},
  };
}

export function cloneBotMemory(memory?: BotPlannerMemory): BotPlannerMemory {
  if (!memory) return createEmptyBotMemory();
  const enemiesById: Record<number, RememberedEntity> = {};
  for (const [id, entry] of Object.entries(memory.enemiesById)) {
    enemiesById[Number(id)] = { ...entry };
  }
  const resourcesById: Record<number, RememberedEntity> = {};
  for (const [id, entry] of Object.entries(memory.resourcesById)) {
    resourcesById[Number(id)] = { ...entry };
  }
  return { enemiesById, resourcesById };
}

function projectMaster(m: UnitType): ObservedMaster {
  return {
    id: m.id,
    name: m.name,
    masterType: m.masterType,
    group: m.group,
    hitPoints: m.hitPoints,
    los: m.los,
    fogFlag: m.fogFlag,
    speed: m.speed,
    radiusX: m.radiusX,
    radiusY: m.radiusY,
    clearanceX: m.clearanceX,
    clearanceY: m.clearanceY,
    terrainRestriction: m.terrainRestriction,
    unitLevel: m.unitLevel,
    trackAsResource: m.trackAsResource,
    resourceGroup: m.resourceGroup,
    enabled: m.enabled,
    costs: m.creatable ? m.creatable.costs.map((c) => ({ type: c.type, amount: c.amount, flag: c.flag })) : [],
    trainTime: m.creatable?.trainTime ?? 0,
    trainLocationId: m.creatable?.trainLocationId ?? -1,
    combat: m.combat
      ? {
          range: m.combat.range,
          minRange: m.combat.minRange,
          baseArmour: m.combat.baseArmour,
          attacks: m.combat.attacks.map((a) => ({ group: a.group, amount: a.amount })),
        }
      : null,
  };
}

function buildEnabledMasters(world: World, player: number): Readonly<Record<number, ObservedMaster>> {
  const playerMasters = world.masters[player];
  if (!playerMasters) return {};
  const projected: Record<number, ObservedMaster> = {};
  for (const [rawId, m] of Object.entries(playerMasters)) {
    projected[Number(rawId)] = projectMaster(m);
  }
  return projected;
}

function isVillagerMaster(m: UnitType, typeId: number): boolean {
  return m.group === GROUP_CIVILIAN || VILLAGER_TYPES.has(typeId);
}

function isMilitaryMaster(m: UnitType): boolean {
  return m.masterType === MASTER_TYPE_UNIT && m.unitLevel === UNIT_LEVEL_MILITARY;
}

function isNavalMaster(m: UnitType): boolean {
  return m.terrainRestriction === TERRAIN_RESTRICTION_WATER || NAVAL_GROUPS.has(m.group);
}

function isBuildingEntity(m: UnitType): boolean {
  return isBuilding(m) || m.group === GROUP_BUILDING || m.group === GROUP_WALL;
}

function isMobileFauna(m: UnitType, typeId: number): boolean {
  if (m.masterType !== MASTER_TYPE_UNIT) return false;
  if (m.group === GROUP_HUNTED_ANIMAL || m.group === GROUP_PREDATOR) return true;
  return typeId === GAZELLE || typeId === ELEPHANT || typeId === LION || typeId === ALLIGATOR;
}

function isDangerousFauna(m: UnitType, typeId: number, state: number): boolean {
  if (state !== ObjectState.Active) return false;
  if (typeId === HARMLESS_PREDATOR_ID) return false;
  return m.group === GROUP_PREDATOR || typeId === ELEPHANT || typeId === LION || typeId === ALLIGATOR;
}

function isStaticEnemyMaster(m: UnitType): boolean {
  return isBuildingEntity(m) || m.speed === 0;
}

function enemyReachRange(m: UnitType): number {
  return isBuildingEntity(m) ? Math.max(1.5, m.radiusX + 1.2) : 1.5;
}

function isWorkActionActive(e: Entity): boolean {
  const w = e.work;
  if (!w) return false;
  return w.state !== WORK_DONE && w.state !== WORK_IDLE && w.state !== WORK_WAITING && w.state !== WORK_FAILED;
}

function isMovingActive(e: Entity): boolean {
  const a = e.mover?.action;
  if (!a) return false;
  return a.state !== MOVE_DONE && a.state !== MOVE_FAILED;
}

function lookupStaticResourceMaster(world: World, player: number, typeId: number): UnitType | null {
  const m = world.masters[0]?.[typeId] ?? world.masters[player]?.[typeId];
  return m && m.trackAsResource === 1 ? m : null;
}

export function createBotObservation(
  world: World,
  player: number,
  memory?: BotPlannerMemory,
): { observation: BotObservation; memory: BotPlannerMemory } {
  const nextMemory = cloneBotMemory(memory);
  const ctx = world.gameContext();
  const turn = world.turn;
  const worldTime = world.worldTime;

  const tileVis = (col: number, row: number): number => {
    if (!world.map.inBounds(col, row)) return TILE_BLACK;
    return world.tileVisibility(player, col, row);
  };

  // Tracked static resources known by sim Visibility (plus unflushed initial exploreAll tiles on turn 0)
  const trackedResourceIds = new Set<number>();
  const playerResLists = world.visibility.resources[player];
  if (playerResLists) {
    for (const list of playerResLists) {
      for (const r of list) trackedResourceIds.add(r.id);
    }
  }
  const hasUnflushedNewTiles = (world.visibility.newTiles[player]?.length ?? 0) > 0;

  const ownUnitEntities: Entity[] = [];
  const ownBuildings: ObservedOwnBuilding[] = [];
  const knownEnemies: ObservedEnemy[] = [];
  const knownResources: ObservedResource[] = [];

  const visibleEnemyIds = new Set<number>();
  const visibleResourceIds = new Set<number>();

  for (const e of world.entities.all()) {
    if (!hasMaster(world, e.owner, e.type)) continue;
    const m = typeOf(world, e);
    if (m.masterType === MASTER_TYPE_MISSILE || m.group === GROUP_MISSILE) continue;

    if (e.owner === player) {
      if (e.state !== ObjectState.Active && e.state !== ObjectState.Unbuilt) continue;
      if (isBuilding(m)) {
        const queuedUnits = (e.queue ?? []).map((q) => ({ unit: q.unit, count: q.count }));
        const queueCount = queuedUnits.reduce((sum, q) => sum + q.count, 0);
        ownBuildings.push({
          id: e.id,
          type: e.type,
          x: e.x,
          y: e.y,
          hp: e.hp,
          maxHp: m.hitPoints,
          state: e.state,
          isUnbuilt: e.state === ObjectState.Unbuilt,
          buildPoints: e.buildPoints ?? 0,
          requiredBuildPoints: m.creatable?.trainTime ?? 0,
          heldType: e.heldType,
          heldAmount: e.heldAmount,
          makeTimer: e.make ? e.make.timer : null,
          trainingUnit: e.train ? e.train.unit : null,
          queueLength: e.train ? Math.max(queueCount, 1) : queueCount,
          queuedUnits,
          researchingTech: e.research ? e.research.tech : null,
          isBusy: Boolean(e.research || e.train || queuedUnits.length > 0),
        });
      } else if (m.masterType === MASTER_TYPE_UNIT && e.state === ObjectState.Active) {
        ownUnitEntities.push(e);
      }
      continue;
    }

    // Passengers aboard transports are never directly visible on map tiles
    if (e.inside != null) continue;

    const col = toInt(e.x);
    const row = toInt(e.y);
    const vis = tileVis(col, row);
    if (vis === TILE_BLACK) continue;

    if (isEnemy(ctx, player, e.owner)) {
      if (vis === TILE_VISIBLE) {
        if (e.state !== ObjectState.Active && e.state !== ObjectState.Unbuilt) continue;
        const isBldg = isBuildingEntity(m);
        const isStatic = isStaticEnemyMaster(m);
        visibleEnemyIds.add(e.id);
        knownEnemies.push({
          id: e.id,
          owner: e.owner,
          type: e.type,
          x: e.x,
          y: e.y,
          hp: e.hp,
          maxHp: m.hitPoints,
          state: e.state,
          isBuilding: isBldg,
          isStatic,
          isVillager: isVillagerMaster(m, e.type),
          isMilitary: !isBldg && isMilitaryMaster(m),
          visibleNow: true,
          lastSeenTurn: turn,
          reachRange: enemyReachRange(m),
        });
        if (isStatic) {
          nextMemory.enemiesById[e.id] = {
            id: e.id,
            owner: e.owner,
            type: e.type,
            x: e.x,
            y: e.y,
            kind: 'enemy-building',
            lastSeenTurn: turn,
            lastSeenTime: worldTime,
            isBuilding: isBldg,
          };
        } else {
          delete nextMemory.enemiesById[e.id];
        }
      }
      continue;
    }

    if (e.owner === 0) {
      if (m.trackAsResource === 1) {
        if (e.state >= ObjectState.PendingRemoval || e.state === ObjectState.Unbuilt || e.heldAmount <= 0) continue;
        if (vis === TILE_VISIBLE) {
          visibleResourceIds.add(e.id);
          knownResources.push({
            id: e.id,
            type: e.type,
            x: e.x,
            y: e.y,
            state: e.state,
            heldType: e.heldType,
            heldAmount: e.heldAmount,
            resourceGroup: m.resourceGroup,
            visibleNow: true,
            lastSeenTurn: turn,
            isDangerous: false,
          });
          nextMemory.resourcesById[e.id] = {
            id: e.id,
            owner: 0,
            type: e.type,
            x: e.x,
            y: e.y,
            kind: 'resource',
            lastSeenTurn: turn,
            lastSeenTime: worldTime,
            heldAmount: e.heldAmount,
          };
        } else if (
          vis === TILE_FOGGED &&
          !nextMemory.resourcesById[e.id] &&
          (trackedResourceIds.has(e.id) || hasUnflushedNewTiles)
        ) {
          // Reveal Map / explored static resource discovered under initial fog
          nextMemory.resourcesById[e.id] = {
            id: e.id,
            owner: 0,
            type: e.type,
            x: e.x,
            y: e.y,
            kind: 'resource',
            lastSeenTurn: turn,
            lastSeenTime: worldTime,
            heldAmount: e.heldAmount,
          };
        }
      } else if (isMobileFauna(m, e.type)) {
        // Mobile fauna (Gazelle, Elephant, Lion, Alligator): strictly TILE_VISIBLE & Active only
        if (vis === TILE_VISIBLE && e.state === ObjectState.Active) {
          knownResources.push({
            id: e.id,
            type: e.type,
            x: e.x,
            y: e.y,
            state: e.state,
            heldType: e.heldType,
            heldAmount: e.heldAmount,
            resourceGroup: m.resourceGroup,
            visibleNow: true,
            lastSeenTurn: turn,
            isDangerous: isDangerousFauna(m, e.type, e.state),
          });
        }
        delete nextMemory.resourcesById[e.id];
      }
    }
  }

  // Reconcile remembered static enemy buildings (NEVER peek live World while TILE_FOGGED)
  for (const [rawId, mem] of Object.entries(nextMemory.enemiesById)) {
    const id = Number(rawId);
    if (visibleEnemyIds.has(id)) continue;
    if (mem.kind !== 'enemy-building') {
      delete nextMemory.enemiesById[id];
      continue;
    }
    const vis = tileVis(toInt(mem.x), toInt(mem.y));
    if (vis !== TILE_FOGGED || !isEnemy(ctx, player, mem.owner)) {
      delete nextMemory.enemiesById[id];
      continue;
    }
    if (!hasMaster(world, mem.owner, mem.type)) {
      delete nextMemory.enemiesById[id];
      continue;
    }
    const m = master(world, mem.owner, mem.type);
    if (!isStaticEnemyMaster(m)) {
      delete nextMemory.enemiesById[id];
      continue;
    }
    const isBldg = mem.isBuilding ?? isBuildingEntity(m);
    knownEnemies.push({
      id: mem.id,
      owner: mem.owner,
      type: mem.type,
      x: mem.x,
      y: mem.y,
      hp: m.hitPoints,
      maxHp: m.hitPoints,
      state: ObjectState.Active,
      isBuilding: isBldg,
      isStatic: true,
      isVillager: isVillagerMaster(m, mem.type),
      isMilitary: !isBldg && isMilitaryMaster(m),
      visibleNow: false,
      lastSeenTurn: mem.lastSeenTurn,
      reachRange: enemyReachRange(m),
    });
  }

  // Reconcile remembered static resources (NEVER peek live World while TILE_FOGGED)
  for (const [rawId, mem] of Object.entries(nextMemory.resourcesById)) {
    const id = Number(rawId);
    if (visibleResourceIds.has(id)) continue;
    if (mem.kind !== 'resource') {
      delete nextMemory.resourcesById[id];
      continue;
    }
    const vis = tileVis(toInt(mem.x), toInt(mem.y));
    if (vis !== TILE_FOGGED) {
      delete nextMemory.resourcesById[id];
      continue;
    }
    const m = lookupStaticResourceMaster(world, player, mem.type);
    if (!m) {
      delete nextMemory.resourcesById[id];
      continue;
    }
    const heldType = m.storages.find((s) => s.flag === 0)?.type ?? -1;
    knownResources.push({
      id: mem.id,
      type: mem.type,
      x: mem.x,
      y: mem.y,
      state: ObjectState.Active,
      heldType,
      heldAmount: mem.heldAmount ?? m.resourceCapacity,
      resourceGroup: m.resourceGroup,
      visibleNow: false,
      lastSeenTurn: mem.lastSeenTurn,
      isDangerous: false,
    });
  }

  knownEnemies.sort((a, b) => a.id - b.id);
  knownResources.sort((a, b) => a.id - b.id);

  const knownEnemyById = new Map<number, ObservedEnemy>(knownEnemies.map((e) => [e.id, e]));

  const ownUnits: ObservedOwnUnit[] = ownUnitEntities.map((e) => {
    const m = typeOf(world, e);
    const a = e.attack;
    const attackTarget = a && a.target >= 0 ? a.target : null;
    const targetInfo = attackTarget !== null ? knownEnemyById.get(attackTarget) : undefined;
    const isActivelyEngaged = Boolean(
      a &&
        (a.state === ATTACK_MOVING || a.state === ATTACK_WAITING || a.state === ATTACK_ATTACKING) &&
        targetInfo &&
        (targetInfo.isStatic || targetInfo.visibleNow),
    );
    return {
      id: e.id,
      type: e.type,
      x: e.x,
      y: e.y,
      hp: e.hp,
      maxHp: m.hitPoints,
      state: e.state,
      heldType: e.heldType,
      heldAmount: e.heldAmount,
      isVillager: isVillagerMaster(m, e.type),
      isMilitary: isMilitaryMaster(m),
      isNaval: isNavalMaster(m),
      isMoving: isMovingActive(e),
      workTarget: e.work && e.work.target >= 0 ? e.work.target : null,
      workState: e.work ? e.work.state : null,
      isWorkActive: isWorkActionActive(e),
      attackTarget,
      attackState: a ? a.state : null,
      isActivelyEngaged,
      inside: e.inside ?? null,
      cargoCount: e.cargo?.length ?? 0,
    };
  });

  const attrs = world.attributes[player];

  const isTileExplored = (col: number, row: number): boolean => tileVis(col, row) !== TILE_BLACK;
  const isTileVisible = (col: number, row: number): boolean => tileVis(col, row) === TILE_VISIBLE;

  const canReach = (
    actorId: number,
    targetX: number,
    targetY: number,
    range = 0,
    checkDynamicPath = false,
  ): boolean => {
    if (!Number.isFinite(targetX) || !Number.isFinite(targetY)) return false;
    const actor = world.entities.get(actorId);
    if (!actor || actor.owner !== player || actor.state !== ObjectState.Active || actor.inside != null) {
      return false;
    }
    const sx = toInt(actor.x);
    const sy = toInt(actor.y);
    const gx = toInt(targetX);
    const gy = toInt(targetY);
    if (!world.map.inBounds(sx, sy) || !world.map.inBounds(gx, gy)) return false;
    const safeRange = Number.isFinite(range) && range > 0 ? range : 0;
    const actorMaster = typeOf(world, actor);
    const zones = world.pathing.zones.of(actorMaster);
    if (!zones.withinRange(sx, sy, gx, gy, safeRange)) return false;
    if (!checkDynamicPath) return true;
    return world.pathing.findTilePath(actor, actorMaster, sx, sy, gx, gy, safeRange).found;
  };

  const canPlaceBuilding = (masterId: number, x: number, y: number): boolean => {
    if (!Number.isFinite(x) || !Number.isFinite(y)) return false;
    if (!hasMaster(world, player, masterId)) return false;
    const m = master(world, player, masterId);
    if (!isBuilding(m)) return false;
    return checkPlacement(ctx, m, x, y, true, true, player) === 0;
  };

  const canPointLandReach = (fromX: number, fromY: number, toX: number, toY: number, range: number): boolean => {
    if (!hasMaster(world, player, VILLAGER)) return true;
    const sx = toInt(fromX);
    const sy = toInt(fromY);
    const gx = toInt(toX);
    const gy = toInt(toY);
    if (!world.map.inBounds(sx, sy) || !world.map.inBounds(gx, gy)) return true;
    const vm = master(world, player, VILLAGER);
    if ((vm.terrainTable[world.map.terrainAt(sx, sy) & 0x1f] ?? 0) <= 0) return true;
    return world.pathing.zones.of(vm).withinRange(sx, sy, gx, gy, range);
  };

  const findBuildPlacement = (
    masterId: number,
    nearX: number,
    nearY: number,
    maxRadius = 36,
    actorId?: number,
  ): { x: number; y: number } | null => {
    if (!Number.isFinite(nearX) || !Number.isFinite(nearY)) return null;
    if (!hasMaster(world, player, masterId)) return null;
    const m = master(world, player, masterId);
    if (!isBuilding(m)) return null;
    const maxR = Math.max(1, Math.trunc(Number.isFinite(maxRadius) ? maxRadius : 36));
    const halfX = m.clearanceX - Math.trunc(m.clearanceX) > 0 ? 0.5 : 0;
    const halfY = m.clearanceY - Math.trunc(m.clearanceY) > 0 ? 0.5 : 0;
    const baseX = Math.floor(nearX) + halfX;
    const baseY = Math.floor(nearY) + halfY;
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
            if (!canPlaceBuilding(masterId, x, y)) continue;
            if (actorId !== undefined) {
              if (!canReach(actorId, x, y, reachRange, true)) continue;
            } else if (!canPointLandReach(nearX, nearY, x, y, reachRange)) {
              continue;
            }
            return { x, y };
          }
        }
      }
      return null;
    };

    const fast = searchPass(Math.min(4, maxR), Math.min(16, maxR), 2);
    if (fast) return fast;
    return searchPass(1, maxR, 1);
  };

  const findDockPlacement = (
    nearX: number,
    nearY: number,
    actorId?: number,
  ): { x: number; y: number } | null => {
    if (!Number.isFinite(nearX) || !Number.isFinite(nearY)) return null;
    if (!hasMaster(world, player, DOCK)) return null;
    const m = master(world, player, DOCK);
    if (!isBuilding(m)) return null;
    const baseCol = Math.floor(nearX);
    const baseRow = Math.floor(nearY);

    const knownFish = knownResources.filter((r) => ALL_FISH.has(r.type));
    const seaZones = hasMaster(world, player, 13)
      ? world.pathing.zones.of(master(world, player, 13))
      : null;

    let fallback: { x: number; y: number } | null = null;
    for (let dist = 1; dist <= 40; dist++) {
      for (let dx = -dist; dx <= dist; dx++) {
        for (let dy = -dist; dy <= dist; dy++) {
          if (Math.abs(dx) !== dist && Math.abs(dy) !== dist) continue;
          const col = baseCol + dx;
          const row = baseRow + dy;
          const x = col + 0.5;
          const y = row + 0.5;
          if (!world.map.inBounds(col, row)) continue;
          if (!canPlaceBuilding(DOCK, x, y)) continue;
          if (actorId !== undefined) {
            if (!canReach(actorId, x, y, 2.5, true)) continue;
          } else if (!canPointLandReach(nearX, nearY, x, y, 2.5)) {
            continue;
          }
          if (!fallback) fallback = { x, y };
          if (
            seaZones &&
            knownFish.length > 0 &&
            knownFish.some((f) => seaZones.withinRange(col, row, toInt(f.x), toInt(f.y), 2.5))
          ) {
            return { x, y };
          }
        }
      }
    }
    return fallback;
  };

  const findNearestExploreTarget = (actorId: number, seed: number): { x: number; y: number } | null => {
    const actor = world.entities.get(actorId);
    if (!actor || actor.owner !== player || actor.state !== ObjectState.Active || actor.inside != null) {
      return null;
    }
    const w = world.map.width;
    const h = world.map.height;
    const ux = toInt(actor.x);
    const uy = toInt(actor.y);
    if (!world.map.inBounds(ux, uy)) return null;

    const actorMaster = typeOf(world, actor);
    const zones = world.pathing.zones.of(actorMaster);

    const scan = (step: number, margin: number): { x: number; y: number } | null => {
      const candidates: { col: number; row: number; distSq: number }[] = [];
      const minX = margin;
      const minY = margin;
      const maxX = w - 1 - margin;
      const maxY = h - 1 - margin;
      for (let col = minX; col <= maxX; col += step) {
        for (let row = minY; row <= maxY; row += step) {
          if (world.tileVisibility(player, col, row) !== TILE_BLACK) continue;
          if (!zones.withinRange(ux, uy, col, row, 0)) continue;
          const dx = col - ux;
          const dy = row - uy;
          candidates.push({ col, row, distSq: dx * dx + dy * dy });
        }
      }
      if (candidates.length === 0) return null;
      candidates.sort((a, b) => a.distSq - b.distSq || a.row * w + a.col - (b.row * w + b.col));

      const reachable: { col: number; row: number }[] = [];
      const maxChecks = Math.min(candidates.length, 24);
      for (let i = 0; i < maxChecks && reachable.length < 4; i++) {
        const c = candidates[i]!;
        if (world.pathing.findTilePath(actor, actorMaster, ux, uy, c.col, c.row, 0).found) {
          reachable.push(c);
        }
      }
      if (reachable.length === 0) return null;
      const safeSeed = Number.isFinite(seed) ? Math.abs(Math.trunc(seed)) : 0;
      const chosen = reachable[safeSeed % reachable.length]!;
      return { x: chosen.col + 0.5, y: chosen.row + 0.5 };
    };

    const coarseStep = Math.max(4, Math.floor(Math.min(w, h) / 8));
    return scan(coarseStep, 2) ?? scan(2, 1) ?? scan(1, 0);
  };

  const observation: BotObservation = {
    contractVersion: BOT_CONTRACT_VERSION,
    player,
    turn,
    worldTime,
    age: attrs?.[ATTR_AGE] ?? 1,
    civ: world.civs[player] ?? 1,
    mapWidth: world.map.width,
    mapHeight: world.map.height,
    resources: {
      food: attrs?.[ATTR_FOOD] ?? 0,
      wood: attrs?.[ATTR_WOOD] ?? 0,
      stone: attrs?.[ATTR_STONE] ?? 0,
      gold: attrs?.[ATTR_GOLD] ?? 0,
    },
    population: {
      current: attrs?.[ATTR_POPULATION] ?? 0,
      limit: attrs?.[ATTR_POPULATION_LIMIT] ?? 50,
      headroom: attrs?.[ATTR_HEADROOM] ?? 0,
    },
    ownUnits,
    ownBuildings,
    knownEnemies,
    knownResources,
    techStates: [...(world.techs[player] ?? [])],
    enabledMasters: buildEnabledMasters(world, player),
    canReach,
    isTileExplored,
    isTileVisible,
    findNearestExploreTarget,
    canPlaceBuilding,
    findBuildPlacement,
    findDockPlacement,
  };

  return { observation, memory: nextMemory };
}
