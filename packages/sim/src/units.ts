import { CIV_RECORDS, EFFECT_RECORDS, TECH_RECORDS, TERRAIN_ROWS, UNIT_RECORDS } from './unit-data';
import type { SimSprite, SimUnitRecord } from './unit-record';

/**
 * A dat sprite (graphic) as the sim reads it (docs/spec/sprites.md §1): frame count and timing for the animation
 * state the sim keeps (sprites.md §3), facets and base speed for movement (movement.md §2), and the flag bits.
 */
export interface SpriteInfo {
  /** Dat graphic id. */
  graphic: number;
  /** `frame_num`: frames per facet. */
  frames: number;
  /** Facets (angles) of the sprite: the graphic's angle count. */
  facets: number;
  /** Speed multiplier (`base_speed`); 0 means "use the unit's speed as is". */
  baseSpeed: number;
  /** Seconds per frame. */
  duration: number;
  /** `pause_between_loops`: seconds held on the last frame before looping. */
  pause: number;
  /** `flags` (the graphic's sequence type): 1 animated, 2 has facings, 4 random start frame, 8 play once. */
  flags: number;
  /** The sprite has facings (`flags & 2`). */
  hasFacings: boolean;
  /** Animated with a random start frame (`flags & 1` and `& 4`): each new active sprite of it draws one `rand()`. */
  randomStart: boolean;
}

/** One carried or owner-given amount (`attribute_type_held` / storage slots, economy.md §2.1). */
export interface Storage {
  type: number;
  amount: number;
  /** 0 the object's own starting load, 1/2 given to the owner on creation (2: taken back on removal), 4 when built. */
  flag: number;
}

/** `RGE_Task` (economy.md §2.1); sprites resolved from their graphic ids. */
export interface Task {
  actionType: number;
  /** `object_group`: target class, -1 none. */
  group: number;
  /** `object_id`: target master id, -1 none. */
  unitId: number;
  terrainId: number;
  /** `attribute_type`: type carried while doing the task. */
  resourceIn: number;
  /** `attribute_type2`: owner attribute that multiplies the take, -1 none. */
  resourceMultiplier: number;
  /** `attribute_type3`: owner attribute credited on drop-off, -1 the carried type. */
  resourceOut: number;
  workValue1: number;
  /** `work_val2`: the convert's seconds per attempt (support-actions.md §4.3). */
  workValue2: number;
  workRange: number;
  /** `combat_level` (the reader's `enableTargeting`). */
  combatLevel: number;
  /** `owner_type` (the reader's `targetDiplomacy`). */
  diplomacy: number;
  /** `holding_attr` (the reader's `carryCheck`): the target must hold something. */
  carryCheck: number;
  /** `state_building` (the reader's `pickForConstruction`). */
  building: number;
  moving: SpriteInfo | null;
  /** `work_sprite`. */
  proceeding: SpriteInfo | null;
  /** `work_sprite2`. */
  working: SpriteInfo | null;
  carrying: SpriteInfo | null;
  /** `is_default`: the task an idle, active object starts by itself (`default_task`, the first such). */
  isDefault: number;
  /** `work_flag` (the reader's `gatherType`); for a make task, 0 puts the work into the object itself. */
  workFlag: number;
}

export interface ActionInfo {
  workRate: number;
  /** `drop_site`, `backup_drop_site`. */
  dropSites: readonly [number, number];
  /** `task_by_group`; 0 none. */
  taskSwapGroup: number;
  tasks: readonly Task[];
}

export interface WeaponEntry {
  group: number;
  amount: number;
}

export interface CombatInfo {
  attacks: readonly WeaponEntry[];
  armours: readonly WeaponEntry[];
  baseArmour: number;
  /** `speed_of_attack`. */
  reloadTime: number;
  /** `weapon_range`. */
  range: number;
  minRange: number;
  /** `missile_id`, -1 melee. */
  projectileUnitId: number;
  /** `fire_missile_at_frame`. */
  frameDelay: number;
  /** `base_hit_chance`. */
  accuracy: number;
  /** `area_effect_range`. */
  blastWidth: number;
  /** `area_effect_level`: the least `area_effect_object_level` a blast victim needs. */
  blastLevel: number;
  /** `fight_sprite`. */
  attackSprite: SpriteInfo | null;
  /** Missile spawn offset (x, y, z). */
  displacement: readonly [number, number, number];
}

export interface MissileInfo {
  /** `missile_type`. */
  type: number;
  /** `targetting_type`: 1 leads a moving target. */
  targetting: number;
  /** `missile_hit_info`. */
  hitInfo: number;
  /** `ballistics_ratio`. */
  ballistics: number;
}

/**
 * The master-object fields the sim reads (docs/spec/movement.md §2, economy.md §2, combat.md §1). Values are generated
 * from the original `empires.dat` into `unit-data.ts` by tools/gen-sim-tables.mjs (civ 1's record, Gaia's for units
 * civ 1 lacks, and each civ's own fields) and checked against it by packages/data `units.golden.test.ts`. Each player
 * owns a copy of its civ's records (`civUnitTypes`), which techs change (techs.md §4). Float fields hold float32 values.
 */
export interface UnitType {
  id: number;
  name: string;
  /** Dat object type: 10 static, 30 moving, 60 missile, 70 combat unit, 80 building, 90 tree. */
  masterType: number;
  /** Dat class (`object_group`). */
  group: number;
  hitPoints: number;
  /** `line_of_sight`, tiles: the unit AI's search radius. */
  los: number;
  /** `fog_flag`: an attacker may still hit it while its tile is only fogged (combat.md §3.4). */
  fogFlag: number;
  /** Tiles per second. */
  speed: number;
  radiusX: number;
  radiusY: number;
  /** <= 0: never collides, straight-line path. */
  radiusZ: number;
  /** Seconds per facet; 0 turns instantly. */
  turnSpeed: number;
  /** `movement_type` 1: z only rises to the ground (missiles). */
  flying: boolean;
  /** Terrain restriction table index. */
  terrainRestriction: number;
  /** The restriction row: per terrain id, > 0 passable (and the speed multiplier). */
  terrainTable: readonly number[];
  combatLevel: number;
  /** `area_effect_object_level`: a blast hits this object when it is at least the blast's level (combat.md §4.4). */
  blastDefense: number;
  standing: SpriteInfo;
  /** `move_sprite`; null means the standing sprite is used for walking too. */
  walking: SpriteInfo | null;
  /** `death_sprite`. */
  dying: SpriteInfo | null;
  /** Object spawned when this one is removed (`spawn_death_obj`), -1 none. */
  deadUnitId: number;
  /** `damage_sprites`, in dat order: what `check_damage_sprites` shows past each damage percent (stat_obj.ts). */
  damageSprites: readonly DamageSprite[];
  /** Storage slots with a type. */
  storages: readonly Storage[];
  /** `attribute_max_amount`: carry limit, and the clamp on a resource object. */
  resourceCapacity: number;
  /** `attribute_rot`: held amount lost per second while dying or dead. */
  resourceDecay: number;
  action: ActionInfo | null;
  combat: CombatInfo | null;
  missile: MissileInfo | null;
  /** Construction radius (`construction_radius_x/y`, the dat's clearance size): a building's placement footprint. */
  clearanceX: number;
  clearanceY: number;
  /** `can_be_built_on`: a foundation removes objects with this set (`check_destructables`). */
  canBeBuiltOn: number;
  /** `obj_max` (the dat's garrison capacity, a byte): how many objects fit inside (`more_room`, naval.md §8). */
  objMax: number;
  /** `unit_level` (the dat's interface kind): 7 marks a transport, the target of the enter task (naval.md §8). */
  unitLevel: number;
  /** `track_as_resource`: an explored one joins the player's visible resources (`resources.ts`, economy.md §10). */
  trackAsResource: number;
  /** `resource_group`: which of the five visible-resource lists (0 wood, 1 forage, 2 fish, 3 stone, 4 gold). */
  resourceGroup: number;
  /** `elevation_flag` (the dat's hill mode): 1 allows flat and some slope tiles, 2 flat tiles only. */
  elevationMode: number;
  /** `center_tile_req1/2` (the dat's placement terrain), -1 none. */
  placementTerrain: readonly [number, number];
  /** `tile_req1/2` (the dat's placement side terrain), -1 none. */
  placementSideTerrain: readonly [number, number];
  /** `available` at game start; techs enable or disable it per player. */
  enabled: boolean;
  creatable: CreatableInfo | null;
  building: BuildingInfo | null;
}

/** `RGE_Damage_Sprite_Info`: past `percent` damage, `flag` 0 overlays `sprite`, 1 overlays it at a random point, 2 makes it the object's sprite. */
export interface DamageSprite {
  sprite: SpriteInfo | null;
  percent: number;
  flag: number;
}

/** `TRIBE_Master_Combat_Object` creation fields (economy.md §2.1). */
export interface CreatableInfo {
  /** `build_inventory`: slots with a type, in slot order. Flag 0 is checked but not paid. */
  costs: readonly Storage[];
  /** `build_pts_required`: build points of a building, seconds of training at work rate 1 for a unit. */
  trainTime: number;
  /** `id_of_building_obj`. */
  trainLocationId: number;
}

/** `TRIBE_Master_Building_Object` fields (economy.md §4). */
export interface BuildingInfo {
  /** `construction_sprite`, shown while unbuilt. */
  construction: SpriteInfo | null;
  /** `building_facet`. */
  facet: number;
  /** `building_connect_flag` (the dat's `adjacentMode`): a wall that joins its neighbours when built (economy.md §4.8). */
  connect: boolean;
  /** `build_and_go_away`. */
  disappearsWhenBuilt: boolean;
  /** `on_build_make_obj`, -1 none. */
  makeObject: number;
  /** `on_build_make_tile`, -1 none. */
  makeTile: number;
  /** `on_build_make_tech`, -1 none. */
  techId: number;
}

export const VILLAGER = 83;
export const MARKET = 84;
export const ARCHERY_RANGE = 87;
export const STABLE = 101;
export const SMALL_WALL = 72;
export const WATCH_TOWER = 79;
export const SLINGER = 347;
export const ASIAN_SPEARMAN = 400;
export const FARM = 50;
export const BUILDER = 118;
export const LUMBERJACK = 123;
export const HUNTER = 122;
export const FORAGER = 120;
export const MINER_STONE = 124;
export const MINER_GOLD = 251;
export const TOWN_CENTER = 109;
export const BARRACKS = 12;
export const HOUSE = 70;
export const GRANARY = 68;
export const STORAGE_PIT = 103;
export const CLUBMAN = 73;
export const BOWMAN = 4;
export const SCOUT = 299;
export const FLARE = 112;
export const GAZELLE = 65;
export const ELEPHANT = 48;
export const LION = 126;
export const ALLIGATOR = 1;
export const MINE_GOLD = 66;
export const MINE_STONE = 102;
export const FORAGE = 59;
/** Tree01 and Tree08 hold 75 wood (cap 75); Tree10 holds 40 (cap 75). */
export const TREES = [134, 141, 143] as const;

function sprite(s: SimSprite | null): SpriteInfo | null {
  if (!s) return null;
  const [graphic, frames, facets, baseSpeed, duration, pause, flags] = s;
  return { graphic, frames, facets, baseSpeed, duration, pause, flags, hasFacings: (flags & 2) !== 0, randomStart: (flags & 5) === 5 };
}

function task(k: readonly (number | SimSprite | null)[]): Task {
  const n = (i: number) => k[i] as number;
  const s = (i: number) => sprite(k[i] as SimSprite | null);
  return {
    actionType: n(0),
    group: n(1),
    unitId: n(2),
    terrainId: n(3),
    resourceIn: n(4),
    resourceMultiplier: n(5),
    resourceOut: n(6),
    workValue1: n(7),
    workRange: n(8),
    combatLevel: n(9),
    diplomacy: n(10),
    carryCheck: n(11),
    building: n(12),
    moving: s(13),
    proceeding: s(14),
    working: s(15),
    carrying: s(16),
    isDefault: n(17),
    workFlag: n(18),
    workValue2: n(19),
  };
}

const storage = ([type, amount, flag]: readonly number[]): Storage => ({ type: type!, amount: amount!, flag: flag! });

/** A generated record (`unit-data.ts`) as the sim's `UnitType`. */
export function toUnitType(r: SimUnitRecord): UnitType {
  const c = r.combat;
  const b = r.building;
  return {
    id: r.id,
    name: r.name,
    masterType: r.masterType,
    group: r.group,
    hitPoints: r.hitPoints,
    los: r.los,
    fogFlag: r.fogFlag,
    speed: r.speed,
    radiusX: r.radius[0],
    radiusY: r.radius[1],
    radiusZ: r.radius[2],
    turnSpeed: r.turnSpeed,
    flying: r.flying,
    terrainRestriction: r.terrainRestriction,
    terrainTable: TERRAIN_ROWS[r.terrainRestriction]!,
    combatLevel: r.combatLevel,
    blastDefense: r.blastDefense,
    standing: sprite(r.standing)!,
    walking: sprite(r.walking),
    dying: sprite(r.dying),
    deadUnitId: r.deadUnitId,
    damageSprites: r.damage.map(([s, percent, flag]) => ({ sprite: sprite(s), percent, flag })),
    storages: r.storages.map(storage),
    resourceCapacity: r.resourceCapacity,
    resourceDecay: r.resourceDecay,
    action: r.action && { workRate: r.action.workRate, dropSites: r.action.dropSites, taskSwapGroup: r.action.taskSwapGroup, tasks: r.action.tasks.map(task) },
    combat: c && {
      attacks: c.attacks.map(([group, amount]) => ({ group, amount })),
      armours: c.armours.map(([group, amount]) => ({ group, amount })),
      baseArmour: c.baseArmour,
      reloadTime: c.reloadTime,
      range: c.range,
      minRange: c.minRange,
      projectileUnitId: c.projectileUnitId,
      frameDelay: c.frameDelay,
      accuracy: c.accuracy,
      blastWidth: c.blastWidth,
      blastLevel: c.blastLevel,
      attackSprite: sprite(c.attackSprite),
      displacement: c.displacement,
    },
    missile: r.missile,
    clearanceX: r.clearance[0],
    clearanceY: r.clearance[1],
    canBeBuiltOn: r.canBeBuiltOn,
    objMax: r.objMax,
    unitLevel: r.unitLevel,
    trackAsResource: r.trackAsResource,
    resourceGroup: r.resourceGroup,
    elevationMode: r.elevationMode,
    placementTerrain: r.placementTerrain,
    placementSideTerrain: r.placementSideTerrain,
    enabled: r.enabled,
    creatable: r.creatable && { costs: r.creatable.costs.map(storage), trainTime: r.creatable.trainTime, trainLocationId: r.creatable.trainLocationId },
    building: b && {
      construction: sprite(b.construction),
      facet: b.facet,
      connect: b.connect,
      disappearsWhenBuilt: b.disappearsWhenBuilt,
      makeObject: b.makeObject,
      makeTile: b.makeTile,
      techId: b.techId,
    },
  };
}

const TYPES = UNIT_RECORDS.map(toUnitType);

/** The table's records (civ 1's, or Gaia's for units civ 1 lacks), by id; per-player masters start from `civUnitTypes`. */
export const UNIT_TYPES: ReadonlyMap<number, UnitType> = new Map(TYPES.map((t) => [t.id, t]));

/** A civilization (`RGE_Civilization`): name, tech-tree effect and starting attributes. */
export interface CivInfo {
  name: string;
  /** `tribe_effect`, run for the player at game start; -1 none. */
  effect: number;
  /** Starting player attributes (float32). */
  resources: readonly number[];
}

/** Every civ of the dat; 0 is Gaia, 1 Egyptian, ... 16 Macedonian. */
export const CIVS: readonly CivInfo[] = CIV_RECORDS.map(({ name, effect, resources }) => ({ name, effect, resources }));
export const CIV_GAIA = 0;
export const CIV_EGYPTIAN = 1;
export const CIV_GREEK = 2;

const CIV_TYPES = CIV_RECORDS.map((c) =>
  Object.fromEntries(UNIT_RECORDS.map((r) => [r.id, c.diffs[r.id] ? toUnitType({ ...r, ...c.diffs[r.id] }) : UNIT_TYPES.get(r.id)!])),
);

/**
 * Civ `civ`'s master records by id: its own record of every table type, the table's where the civ has none (Gaia has no
 * Villager tasks, players no trees). Shared and never changed: a player's masters are `copyUnitType` copies.
 */
export function civUnitTypes(civ: number): Readonly<Record<number, UnitType>> {
  const types = CIV_TYPES[civ];
  if (!types) throw new Error(`civ ${civ} is not in the sim's table`);
  return types;
}

/** A copy of `t` an effect may change without touching `t` (sprites are shared, they are never changed). */
export function copyUnitType(t: UnitType): UnitType {
  const weapons = (list: readonly WeaponEntry[]) => list.map((w) => ({ ...w }));
  const storages = (list: readonly Storage[]) => list.map((s) => ({ ...s }));
  return {
    ...t,
    storages: storages(t.storages),
    action: t.action && { ...t.action, tasks: t.action.tasks.map((k) => ({ ...k })) },
    combat: t.combat && { ...t.combat, attacks: weapons(t.combat.attacks), armours: weapons(t.combat.armours) },
    missile: t.missile && { ...t.missile },
    creatable: t.creatable && { ...t.creatable, costs: storages(t.creatable.costs) },
    building: t.building && { ...t.building },
  };
}

/** Every sprite the types above use, by graphic id. */
const SPRITES = new Map<number, SpriteInfo>();
for (const t of CIV_TYPES.flatMap((types) => Object.values(types))) {
  const tasks = t.action?.tasks.flatMap((k) => [k.moving, k.proceeding, k.working, k.carrying]) ?? [];
  const damage = t.damageSprites.map((d) => d.sprite);
  const sprites = [t.standing, t.walking, t.dying, t.combat?.attackSprite ?? null, t.building?.construction ?? null, ...tasks, ...damage];
  for (const s of sprites) if (s) SPRITES.set(s.graphic, s);
}

export function spriteInfo(graphic: number): SpriteInfo {
  const s = SPRITES.get(graphic);
  if (!s) throw new Error(`graphic ${graphic} is not in the sim's table`);
  return s;
}

/** The table's record of `id` (civ 1's): what the client shows. The simulation reads each player's own masters. */
export function unitType(id: number): UnitType {
  const t = UNIT_TYPES.get(id);
  if (!t) throw new Error(`unit type ${id} is not in the sim's table`);
  return t;
}

/** A tech record (`Tech_Tree`, techs.md §2.1). */
export interface TechInfo {
  /** `pre_reqs`: tech ids, -1 none (0 is tech 0, not "none"). */
  requires: readonly number[];
  /** `pre_reqs_required`. */
  required: number;
  /** `research` time in seconds. */
  researchTime: number;
  /** Effect run on completion, -1 none. */
  effect: number;
  /** Cost slots with a type (`attribute`, `attribute_cost`, `attribute_used`), in slot order. */
  costs: readonly Storage[];
  /** `build_obj_id`: the building whose button offers it, -1 none. */
  location: number;
}

/** Every tech of the dat, by id. */
export const TECHS: readonly TechInfo[] = TECH_RECORDS.map(([requires, required, researchTime, effect, costs, location]) => ({
  requires,
  required,
  researchTime,
  effect,
  costs: costs.map(storage),
  location,
}));

/** One effect command (techs.md §2.2). */
export interface EffectCommand {
  type: number;
  a: number;
  b: number;
  c: number;
  d: number;
}

/** Every effect of the dat, by id: its commands in list order. */
export const EFFECTS: readonly (readonly EffectCommand[])[] = EFFECT_RECORDS.map((e) => e.map(([type, a, b, c, d]) => ({ type: type!, a: a!, b: b!, c: c!, d: d! })));
