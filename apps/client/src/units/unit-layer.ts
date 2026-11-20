import { Assets, Container, Graphics, Rectangle, Sprite, Texture, type Application, type Ticker } from 'pixi.js';
import {
  ACTION_CONVERT,
  ACTION_ENTER,
  ACTION_HEAL,
  ACTION_TRADE,
  buildingFacet,
  checkPlacement,
  master,
  ObjectState,
  RESOURCE_FAITH,
  spriteInfo,
  targetActionType,
  TILE_FOGGED,
  TILE_VISIBLE,
  typeOf,
  UNIT_TYPES,
  unitDiplomacy,
  UNIT_LEVEL_TRANSPORT,
  unitType,
  type Command,
  type Entity,
  type World,
} from '@aoe/sim';
import { DebugProvider } from '../assets/debug-provider';
import type { AssetProvider, FramePart, GraphicInfo, SpriteFrame } from '../assets';
import type { GameSounds } from '../audio/game-sounds';
import { canBuild, levelOf } from '../hud/commands';
import { frameCursor } from '../hud/frame-image';
import { HOTKEY_STRING, hotkeyLetter, pressedLetter } from '../hud/hotkeys';
import { BOTTOM_HEIGHT, SLP, TOP_HEIGHT } from '../hud/layout';
import { attackRollover } from '../hud/text';
import { ELEV_H } from '../map/elevation';
import { mapPixelSize, TILE_H, TILE_W, visibleRange, type TileRange } from '../map/iso';
import type { MapView } from '../map/map-view';
import { composeGraphic, GROUND_LAYER, splitsShadow, splitsTerrain, type PartSet } from './composite';
import { facingFrame } from './facing';
import { Doppelgangers, fogDraw, TERRAIN_LAYER, type Doppelganger } from './fog-objects';
import { FIRST_GROUP, GroupIds } from './group-ids';
import { ObjectGrid } from './object-grid';
import { groupKey } from './group-keys';
import { GROUND_INTERVAL_MS, MOVE_INTERVAL_MS, MoveMarkers } from './move-marker';
import { SELECT_BUILDING_MASTERS, selectKey, tabTarget, type SelectLetters } from './select-keys';
import { ATTACK_CURSOR_FRAME, boardCursor, canAttack, canBoard, isAttackable, priestCursor, type PriestSelection, type Stance } from './mouse-actions';
import { partConfidence, pickWeight, PICK_MAX_LEVEL, PICK_MIN_LEVEL } from './pick';
import { alignBuilding, wallOutline } from './placement';

/** Pointer travel (CSS px) after which a left press becomes a selection box instead of a click. */
const BOX_THRESHOLD = 4;
const SELECTION_COLOUR = 0xffffff;
/** The hit point bar over a selected object: width in pixels, and palette indices 0x4a (green) and 0x97 (red). */
const BAR_WIDTH = 24;
const BAR_FILLED = 0x00ff00;
const BAR_EMPTY = 0xff0101;
/** `display_object_selection(target, 1500, 2, 2)`: an ordered target's outline flashes green (palette 0x4a) this long. */
const FLASH_MS = 1500;
/** `update_display_selected_objects`: the flash is on while bit 8 of the elapsed milliseconds is clear. */
const FLASH_BIT = 0x100;
/**
 * An order mode waiting for its click on the map (`game_mode`): the Move key's (`RGE_GAME_MODE_COMMAND_MOVE`), and the
 * Repair, Attack Ground, Heal, Convert and Unload buttons' (`TRIBE_GAME_MODE_COMMAND_*`).
 */
export type ClickMode = 'move' | 'repair' | 'attack-ground' | 'heal' | 'convert' | 'unload';
/**
 * `STRING_ID_MESSAGE_*`, shown when a mode is armed: "Click an area to move there.", "... to repair.", "Click the unit to
 * heal.", "... to convert.", "Click an area to attack ground.", the unload's (scr_game.cpp:3840-4370).
 */
const MODE_MESSAGE: Record<ClickMode, number> = { move: 0x0be0, repair: 0x0bec, heal: 0x0be3, convert: 0x0be4, 'attack-ground': 0x0be5, unload: 0x0bed };
/** `unit_level` of the units `command_attack_ground` sends (`get_selected_objects_to_command(.., 4, -1, -1, 4)`). */
const LEVEL_SOLDIER = 4;
/** `OBJECT_GROUP_PRIEST`: a selected own priest gives `sel_object_properties` 0x16, and 0x80 with full faith. */
const GROUP_PRIEST = 18;
const FAITH_FULL = 100;
/** The player's attributes 27 and 28 (Monotheism): converting priests and buildings. */
const ATTR_PRIEST_CONVERSION = 27;
const ATTR_BUILDING_CONVERSION = 28;
/** `RGE_MASTER_TYPE_ACTION`, `TRIBE_MASTER_TYPE_BUILDING` and `_TREE`. */
const MASTER_TYPE_ACTION = 40;
const MASTER_TYPE_BUILDING = 80;
const MASTER_TYPE_TREE = 90;
/** `OBJECT_GROUP_CIVILIAN`: the Villagers, the only ones the Repair command sends. */
const GROUP_CIVILIAN = 4;
/** `sel_list` holds 25 objects (`select_one_object`). */
const MAX_SELECTED = 25;
/** `select_level`s: a left click picks from 2 up, a selection box picks 4 (`pick_multi(4, ...)`). */
const SELECT_CLICK = 2;
const SELECT_BUILDING = 3;
const SELECT_BOX = 4;
/** Object group 11: missiles, dead units, the Flare. Without a pack nothing of it can be selected. */
const GROUP_NONE = 11;
/**
 * The building being placed is drawn see-through (`fog_next_shape` 5 where it fits); where it does not, also shaded
 * with a red that pulses (palette 0x24-0x28, stepping every 128 ms of world time).
 */
const GHOST_ALPHA = 0.6;
const GHOST_BLOCKED = [0xff2f2f, 0xe30b00, 0xc71700, 0x8f1f00, 0x6f0b07] as const;

interface Art {
  frames: SpriteFrame[];
  info: GraphicInfo | null;
  /** From the pack (false: debug shapes). */
  pack: boolean;
}

/** Where a unit is drawn: sim positions only change once per step, so the drawing slides between them. */
interface Track {
  sprite: Sprite;
  fromX: number;
  fromY: number;
  toX: number;
  toY: number;
  start: number;
  duration: number;
  /** Graphic being drawn, and when (and from which sim frame) its animation started. */
  graphic: number;
  animStart: number;
  startFrame: number;
  /** Animation frame drawn last, for the sprite's frame sounds; -1 after the graphic changed or went undrawn. */
  lastFrame: number;
  pack: boolean;
  /** The parts of a flying object's graphic drawn on the ground under it (its shadow), when it has any. */
  shadow: Sprite | null;
  /** The parts of the graphic clipped to the terrain (`draw_level` 5 or less) when it has others too: a tree's shadow. */
  under: Sprite | null;
  /** The frame drawn and its graphic's `draw_level`, for picking. */
  frame: SpriteFrame | null;
  layer: number;
  /** The object's damage sprites drawn over it (`Entity.overlays`), by graphic, with when each first showed. */
  overlays: Map<number, { sprite: Sprite; start: number }>;
  /** What a still object was drawn from at its last full draw, or null: while none of it changes it stays as drawn. */
  still: Still | null;
}

/**
 * A still object (no mover, a graphic of one frame, no damage sprites, art loaded; trees, mines, bushes): its look
 * depends only on these, and on the camera's parity while it is drawn fogged (-1: not fogged).
 */
interface Still {
  type: number;
  graphic: number;
  frame: number;
  flag: number;
  state: number;
  owner: number;
  facet: number | undefined;
  tile: number;
  parity: number;
  /** The fog lets the player see it (`shownObjects`). */
  shown: boolean;
}

/**
 * `RGE_Map::get_point` (src/map.cpp:2584) from an object at map pixel `o`: tile offset (x, y, z) lands at
 * `(int)((y + x) * 32)`, `(int)((y + 1 - x - z) * 16) - 16` from the object's whole pixel, each term truncated.
 */
export function outlinePoint(o: { x: number; y: number }, x: number, y: number, z: number): { x: number; y: number } {
  return { x: Math.floor(o.x) + Math.trunc((y + x) * 32), y: Math.floor(o.y) + Math.trunc((y + 1 - x - z) * 16) - 16 };
}

/**
 * A unit that can be selected and ordered (`master_type` 70). Buildings (80), missiles (60) and dead units (30) carry a
 * mover in the sim too but are not.
 */
export function isUnit(e: Entity): boolean {
  return e.mover !== undefined && unitType(e.type).masterType === 70;
}

/** A building (foundations too) of the sim's table. */
export function isBuildingObject(e: Entity): boolean {
  return UNIT_TYPES.get(e.type)?.masterType === 80;
}

/**
 * Facet to draw: a building's `facet` (its construction stage while unbuilt), a mover's heading. A still object with facings (the mines' pile variants) gets one by id, as the
 * sim keeps none (the original takes it from the scenario or map data, `make_scenario_obj`); others use facet 0.
 */
function facetOf(e: Entity, angles: number): number {
  if (e.facet !== undefined) return e.facet;
  if (e.mover) return e.mover.facet;
  return e.sprite && spriteInfo(e.sprite.graphic).hasFacings ? e.id % angles : 0;
}

/** The facet a doppelganger copied (`facet`), picked as `facetOf` picks its object's. */
function copyFacet(c: Doppelganger, angles: number): number {
  if (c.facet !== undefined) return c.facet;
  return spriteInfo(c.graphic).hasFacings ? c.id % angles : 0;
}

export interface UnitLayerOptions {
  app: Application;
  view: MapView;
  world: World;
  provider: AssetProvider;
  /** Sim player number of this client. */
  player: number;
  /** Send a command through the lockstep. */
  issue: (command: Command) => void;
  /** Wall-clock time from the step just run to the next one, to spread its movement over. */
  stepMs: () => number;
  /** Placing a building started (its master id) or ended (null). */
  onPlacement?: (unit: number | null) => void;
  /** The rollover text for the object under the pointer (the attack cursor's), or null when it goes. */
  onRollover?: (text: string | null) => void;
  /** Selection and sprite sounds; none without. */
  sounds?: GameSounds;
  /** Is the grid showing the build menu? The Move and Ungroup keys do nothing there (`scr_game.cpp:1757`). */
  inBuildMenu?: () => boolean;
  /** A message for the message line (a language string id, `show_message`): the Move key's. */
  onMessage?: (stringId: number) => void;
}

/** The building following the pointer while placing: the aligned map point and whether it fits there. */
export interface Ghost {
  unit: number;
  x: number;
  y: number;
  fits: boolean;
  /** A wall's outline: each segment's tile centre, facet and whether it fits; (x, y) is then the tile under the pointer. */
  segments?: WallGhostTile[];
}

export interface WallGhostTile {
  x: number;
  y: number;
  facet: number;
  fits: boolean;
}

/** Alpha of a pixel of `sprite`'s texture under canvas point (x, y) is above this to count as a hit. */
const HIT_ALPHA = 8;
/** Pixels a tile of height (`world_z`) raises a drawn object: `tile_half_height` (src/stat_obj.cpp:1637). */
const Z_PIXELS = 16;
/** `draw_level` of a graphic without pack data: above the low layers an unexplored tile still draws. */
const DEFAULT_LAYER = 20;
/**
 * How far (map pixels) outside the view an object's point may stand and still be drawn: its sprite can reach into the
 * view from there. The pack's widest frames reach 320-350 px sideways of their hotspot (Dock, Tree07), the tallest 441 px
 * above it (cliffs) and 240 px below; a raised tile adds its height below (`objectArea`).
 */
const MARGIN_SIDE = 352;
const MARGIN_ABOVE = 256;
const MARGIN_BELOW = 480;
/** Sprites in the same screen row draw by object id, the later object over the earlier: well under 1 / 1000 (overlays). */
const ID_ORDER = 1e-9;

/** A sim step's number: `turn` and `turn_step` together. */
function stepOf(world: World): number {
  return world.turn * 0x10000 + world.turnStep;
}

/**
 * Draws every sim object near the view on the map layer (units, buildings, trees, mines, animals, carcasses) with its real sprite
 * as the sim reports it (owner colour, facing, task animation) and handles the original's mouse scheme: left click or
 * drag a box to select own units, or click any object to see it, right click to order the selected units to attack the
 * enemy object under the pointer (an `attack` command), to work on any other object there (a `work` command) or, over
 * bare ground, to move there. While a building is being placed its
 * ghost follows the pointer; a left click issues `build`, a right click stops placing. A wall is placed by dragging a
 * line (`TRIBE_GAME_MODE_PLACE_CONNECTED`): its outline follows the drag, and the release issues `build-wall`.
 */
export class UnitLayer {
  readonly selected = new Set<number>();
  /** `selected_obj`: the object the panel shows. */
  private primaryId: number | null = null;
  /** `selected_group` of own objects put in a group, by id; the client's own, as in the original. */
  private readonly groups = new Map<number, number>();
  /** `groups_used`: the ids the Group button has given out. */
  private readonly groupIds = new GroupIds();
  /** The order mode waiting for its click on the map, or null (the normal mode). */
  private clickMode: ClickMode | null = null;
  /** The digits of groupnum.shp (frame = group number 1-9), once loaded, and the sprites over the selected objects. */
  private readonly groupDigits: (Texture | null)[] = [];
  private readonly groupMarks = new Container();
  private readonly groupSprites = new Map<number, Sprite>();
  /** The red X an order on open ground leaves (moveto.shp overlay sprites). */
  private readonly moveMarkers: MoveMarkers;
  /** Ordered targets flashing (`DispSel_List`, select type 2): when each started. */
  private readonly flashes = new Map<number, number>();
  /** The canvas point of the last click that selected something, to pick the next object under it on a second click. */
  private lastClick: { x: number; y: number } | null = null;
  /** The object whose rollover text shows, or null. */
  private rolloverId: number | null = null;
  /** The objects drawn at the last frame (those near the view, `objectArea`); an object leaving it loses its track. */
  private readonly tracks = new Map<number, Track>();
  /** Every object by chunk of tiles, for the walk over the view's. */
  private readonly grid: ObjectGrid;
  private readonly art = new Map<string, Art | null>();
  /** Selection diamonds, at the original's draw level 10: over the terrain, under every object. */
  private readonly outlines = new Graphics();
  /** Hit point bars, at draw level 30: over every object. */
  private readonly highlight = new Graphics();
  private readonly box = new Graphics();
  private readonly fallback = new DebugProvider();
  private readonly tick: (ticker: Ticker) => void;
  private readonly cleanup: (() => void)[] = [];
  private readonly alpha = new WeakMap<Texture, { pixels: Uint8ClampedArray; width: number } | null>();
  private seenStep: number;
  private shown = 0;
  /** The player's remembered trees, mines and bushes, and their sprites. */
  readonly doppelgangers: Doppelgangers;
  private readonly copySprites = new Map<number, Sprite>();
  /** The copies' parts clipped to the terrain, for a copy whose graphic has others too. */
  private readonly copyUnder = new Map<number, Sprite>();
  /** Each texture with every other pixel black, by the parity of its top-left screen pixel. */
  private readonly foggedTextures = new WeakMap<Texture, (Texture | null | undefined)[]>();
  private press: { x: number; y: number; boxing: boolean } | null = null;
  private rightDown: { x: number; y: number; clientX: number; clientY: number; lastClientX: number; lastClientY: number; dragged: boolean } | null = null;
  /** Master id of the building being placed (`TRIBE_GAME_MODE_PLACE_BUILDING`), or null. */
  private placing: number | null = null;
  private readonly ghostSprite = new Sprite();
  private ghostAt: Ghost | null = null;
  /** The wall outline's segments (`draw_wall_outline`), drawn by screen row like any object, and their sprites. */
  private readonly wallGhost = new Container();
  private readonly wallSprites: Sprite[] = [];
  /** `sel_col1`..`sel_row2` while a wall line is dragged: the tile pressed and the tile under the pointer. */
  private wallDrag: { col1: number; row1: number; col2: number; row2: number } | null = null;
  /** Canvas pixel of the pointer while it is over the canvas. */
  private pointer: { x: number; y: number } | null = null;
  /** CSS cursor over an attack target: the original's sword, or the browser's crosshair without art. */
  private attackCursor = 'crosshair';
  /** The owner whose colour each object is drawn in (its art's), by id: for the tests. */
  private readonly drawnOwners = new Map<number, number>();
  /** Each selected, grouped or flashing object's owner at the last frame: an own object that changed hands leaves the selection and its group. */
  private readonly owners = new Map<number, number>();
  private revealedMap = false;

  constructor(private readonly o: UnitLayerOptions) {
    this.seenStep = stepOf(o.world);
    this.grid = new ObjectGrid(o.world, (x, y) => o.view.ground.pixel(x, y));
    this.doppelgangers = new Doppelgangers(o.player, (type) => o.provider.mapArt()?.doppelganger(type) ?? 0);
    // Each player sees the map through its own fog (`RGE_Player::visible`), in every mode.
    // After a multiplayer game ends the whole map shows without fog (`set_map_visible(1)`, `set_map_fog(0)`).
    o.view.setFog({
      state: (col, row) => (this.revealed ? TILE_VISIBLE : o.world.tileVisibility(o.player, col, row)),
      version: () => (this.revealed ? -1 : stepOf(o.world)),
      // A tile is explored only with one more in a player's count; the mask follows shared sight (diplomacy.md §3).
      explored: () => {
        const { visibility } = o.world;
        let count = 0;
        for (const n of visibility.explored) count += n;
        return this.revealed ? 'revealed' : `${visibility.mutualExplored[o.player]}:${count}`;
      },
    });
    // Objects start at the tile count (`t.sprite.zIndex`), the fog just under it (map-view.ts).
    this.outlines.zIndex = o.world.map.width * o.world.map.height - 0.25;
    o.view.layer.addChild(this.outlines);
    this.highlight.zIndex = Number.MAX_SAFE_INTEGER;
    o.view.layer.addChild(this.highlight);
    this.groupMarks.zIndex = Number.MAX_SAFE_INTEGER;
    o.view.layer.addChild(this.groupMarks);
    this.loadGroupDigits();
    this.moveMarkers = new MoveMarkers(o.provider);
    this.moveMarkers.container.zIndex = o.world.map.width * o.world.map.height - 0.2;
    o.view.layer.addChild(this.moveMarkers.container);
    this.ghostSprite.zIndex = Number.MAX_SAFE_INTEGER - 1;
    this.ghostSprite.visible = false;
    o.view.layer.addChild(this.ghostSprite);
    this.wallGhost.zIndex = Number.MAX_SAFE_INTEGER - 1;
    this.wallGhost.sortableChildren = true;
    o.view.layer.addChild(this.wallGhost);
    o.app.stage.addChild(this.box);
    this.tick = () => this.draw();
    o.app.ticker.add(this.tick);
    this.listen(o.app.canvas);
    this.draw();
    const sword = o.provider.interfaceFrame(SLP.cursors, ATTACK_CURSOR_FRAME);
    if (sword) void frameCursor(sword, 'crosshair').then((c) => (this.attackCursor = c)).catch(() => undefined);
  }

  /** Loads groupnum.shp's digits 1-9 (frames 0-8) from the pack (`get_shape(0)`); without them no number is drawn. */
  private loadGroupDigits(): void {
    for (let n = 1; n <= 9; n++) {
      const frame = this.o.provider.interfaceFrame(SLP.groupNumbers, n - 1);
      if (!frame) continue;
      void Assets.load<Texture>(frame.url)
        .then((atlas) => {
          this.groupDigits[n] = new Texture({ source: atlas.source, frame: new Rectangle(frame.x, frame.y, frame.w, frame.h) });
        })
        .catch(() => undefined);
    }
  }

  /** The group numbers drawn over selected own objects now: object id and group (1-9), for the tests. */
  get groupNumbers(): { id: number; group: number }[] {
    return [...this.groupSprites].flatMap(([id, sprite]) => (sprite.visible ? [{ id, group: this.groups.get(id)! }] : []));
  }

  /** `selected_obj`: the last object selected, or after it left the selection the first one left; null for none. */
  get primary(): number | null {
    if (this.primaryId !== null && this.selected.has(this.primaryId)) return this.primaryId;
    this.primaryId = this.selected.values().next().value ?? null;
    return this.primaryId;
  }

  /** Is the whole map shown without fog (`revealMap`)? */
  get revealed(): boolean {
    return this.revealedMap;
  }

  /** The game over screen's `set_map_visible(1)` and `set_map_fog(0)`: every tile visible from now on. */
  revealMap(): void {
    this.revealedMap = true;
  }

  /** `unselect_object`. */
  unselect(): void {
    this.selected.clear();
    this.primaryId = null;
    this.setClickMode(null);
  }

  /**
   * `unselect_one_object`: the last object of `sel_list` takes the leaver's slot, so the order of the rest changes (Tab
   * walks it); `selected_obj` goes to the first one when it was the leaver.
   */
  private deselect(id: number): void {
    if (!this.selected.has(id)) return;
    const order = [...this.selected];
    const at = order.indexOf(id);
    if (at < order.length - 1) order[at] = order[order.length - 1]!;
    order.pop();
    this.selected.clear();
    for (const o of order) this.selected.add(o);
  }

  /** Is object `id` in a group? */
  isGrouped(id: number): boolean {
    return this.groups.has(id);
  }

  /** `group_objects(-1)`: the selected own objects form a new group, which a click on any of them selects whole. */
  group(): void {
    if (this.selected.size === 0) return;
    const group = this.groupIds.next(this.groups.values());
    if (group === null) return;
    for (const id of this.selected) if (this.o.world.entities.get(id)?.owner === this.o.player) this.groups.set(id, group);
  }

  /** `ungroup_objects`: the selected objects leave their groups. */
  ungroup(): void {
    for (const id of this.selected) this.groups.delete(id);
  }

  /**
   * `group_objects(id)` for a numbered group (Ctrl+digit): the group's old members leave it, and the selected own
   * objects join it, leaving any group they were in (an object has one `selected_group`). Nothing selected: nothing happens.
   */
  assignGroup(id: number): void {
    if (this.selected.size === 0) return;
    for (const [obj, g] of this.groups) if (g === id) this.groups.delete(obj);
    for (const obj of this.selected) if (this.o.world.entities.get(obj)?.owner === this.o.player) this.groups.set(obj, id);
  }

  /**
   * `select_group(id)` (digit; `command_select_group`): the objects of group `id` join the selection, `selected_obj`
   * being the last of them, and the first one plays its selection sound. Without `add` the selection is emptied first
   * (even when the group is empty); with `centre` the view then scrolls to `selected_obj` (Alt+digit).
   */
  recallGroup(id: number, add: boolean, centre: boolean): void {
    if (!add) this.unselect();
    let first = true;
    for (const e of this.o.world.entities.ofPlayer(this.o.player)) {
      if (this.groups.get(e.id) !== id || e.state > ObjectState.Active || this.selected.has(e.id)) continue;
      if (!this.selectOne(e.id)) break;
      if (first) this.o.sounds?.selected(e);
      first = false;
    }
    if (centre) this.viewSelected();
  }

  /** `command_view_selected` (Space, src/scr_game.cpp:4298): the view scrolls to `selected_obj`; nothing selected, nothing happens. */
  viewSelected(): void {
    const at = this.primary === null ? undefined : this.o.world.entities.get(this.primary);
    if (at) this.o.view.lookAt(at.x, at.y);
  }

  /** Own units, for centring the view at the start. */
  ownUnits(): Entity[] {
    return [...this.o.world.entities.ofPlayer(this.o.player)].filter(isUnit);
  }

  /** Canvas pixel where unit `id` is drawn (its map position; off the view, where it would be), or null. */
  screenPos(id: number): { x: number; y: number } | null {
    const t = this.tracks.get(id);
    const e = t ? undefined : this.o.world.entities.get(id);
    if (!t && !e?.sprite) return null;
    const { x, y } = t ? this.drawnAt(t, performance.now()) : e!;
    const p = this.o.view.ground.pixel(x, y);
    return { x: p.x - this.o.view.camera.x, y: p.y - this.o.view.camera.y };
  }

  /**
   * Canvas pixel at the middle of object `id`'s drawn sprite, or the drawn pixel nearest it when the middle is see-through
   * (where a click lands on its body), or null.
   */
  objectCentre(id: number): { x: number; y: number } | null {
    const t = this.tracks.get(id);
    if (!t?.sprite.visible) return null;
    const b = t.sprite.getBounds();
    const cx = b.x + b.width / 2;
    const cy = b.y + b.height / 2;
    let best: { x: number; y: number; d: number } | null = null;
    for (let y = Math.floor(b.y) + 1; y < b.y + b.height; y += 2) {
      for (let x = Math.floor(b.x) + 1; x < b.x + b.width; x += 2) {
        const d = (x - cx) ** 2 + (y - cy) ** 2;
        if ((!best || d < best.d) && this.opaque(t.sprite, x, y)) best = { x, y, d };
      }
    }
    return this.opaque(t.sprite, cx, cy) || !best ? { x: cx, y: cy } : { x: best.x, y: best.y };
  }

  /** The player whose colour object `id` is drawn in now (its art's owner); null when it is not drawn. */
  drawnOwner(id: number): number | null {
    return this.tracks.get(id)?.sprite.visible ? (this.drawnOwners.get(id) ?? null) : null;
  }

  /** How many drawn objects (near the view) show pack art (not debug shapes). */
  get packSprites(): number {
    let n = 0;
    for (const t of this.tracks.values()) if (t.sprite.visible && t.pack) n++;
    return n;
  }

  /** How many objects near the view the player's fog lets it see (drawn plain or fogged) at the last frame, art loaded or not. */
  get shownObjects(): number {
    return this.shown;
  }

  /** The building being placed and where it would go, while its ghost is shown. */
  get ghost(): Ghost | null {
    return this.placing === null ? null : this.ghostAt;
  }

  /** Start placing building `unit` (`command_building`): its ghost follows the pointer until a click. */
  startPlacement(unit: number): void {
    this.placing = unit;
    this.press = null;
    this.box.clear();
    this.o.onPlacement?.(unit);
  }

  /** Stop placing (right click, Esc, the cancel button). */
  cancelPlacement(): void {
    if (this.placing === null) return;
    this.placing = null;
    this.ghostAt = null;
    this.wallDrag = null;
    this.ghostSprite.visible = false;
    this.wallGhost.visible = false;
    this.o.onPlacement?.(null);
  }

  destroy(): void {
    this.o.app.ticker.remove(this.tick);
    this.o.app.canvas.style.cursor = '';
    for (const fn of this.cleanup) fn();
    for (const t of this.tracks.values()) {
      t.sprite.destroy();
      t.shadow?.destroy();
      t.under?.destroy();
      for (const o of t.overlays.values()) o.sprite.destroy();
    }
    for (const s of this.copySprites.values()) s.destroy();
    for (const s of this.copyUnder.values()) s.destroy();
    this.moveMarkers.container.destroy({ children: true });
    this.outlines.destroy();
    this.highlight.destroy();
    this.ghostSprite.destroy();
    this.wallGhost.destroy({ children: true });
    this.box.destroy();
  }

  private loadArt(graphic: number, owner: number, parts: PartSet = 'all'): Art | null {
    // Gaia's objects have no player colour; any owner image will do.
    if (owner === 0) owner = 1;
    const key = `${graphic}:${owner}:${parts}`;
    if (this.art.has(key)) return this.art.get(key)!;
    this.art.set(key, null);
    const { provider, app } = this.o;
    const info = provider.graphicInfo(graphic);
    const composite = info !== null && info.deltas.length > 0;
    const frames = composite ? composeGraphic(provider, app.renderer, graphic, info, owner, parts) : provider.graphicFrames(graphic, owner);
    void frames.then(async (frames) => {
      if (frames.length > 0) this.art.set(key, { frames, info: composite ? { ...info, mirroringMode: 0 } : info, pack: true });
      else this.art.set(key, { frames: await this.fallback.graphicFrames(graphic, owner), info: null, pack: false });
    });
    return null;
  }

  private drawnAt(t: Track, now: number): { x: number; y: number } {
    const k = t.duration > 0 ? Math.min(1, (now - t.start) / t.duration) : 1;
    return { x: t.fromX + (t.toX - t.fromX) * k, y: t.fromY + (t.toY - t.fromY) * k };
  }

  private draw(): void {
    const { world, view } = this.o;
    const now = performance.now();
    this.moveMarkers.update(now);
    const step = stepOf(world);
    const newStep = step !== this.seenStep;
    const duration = newStep ? this.o.stepMs() : 0;
    this.seenStep = step;
    if (newStep) {
      this.doppelgangers.update(world);
      this.grid.update();
    }
    this.followSelection();
    const area = this.objectArea();
    const parity = (view.camera.x + view.camera.y) & 1;
    const near = new Set<number>();
    this.shown = 0;
    for (const e of area.range ? this.grid.objects(area.range, (chunk) => this.chunkNear(chunk, area)) : []) {
      // Probe entities of `test` commands have no sprite and are not drawn.
      if (!e.sprite) continue;
      // Only what stands near the view is drawn (`RGE_View::draw`): the rest has no sprite on the stage.
      const p = this.grid.at(e);
      if (p.x < area.x0 || p.x > area.x1 || p.y < area.y0 || p.y > area.y1) continue;
      near.add(e.id);
      const tile = this.tileState(e.x, e.y);
      let t = this.tracks.get(e.id);
      if (t?.still && this.isStill(t.still, e, tile, parity)) {
        if (t.still.shown) this.shown++;
        continue;
      }
      if (!t) {
        t = { sprite: new Sprite(), fromX: e.x, fromY: e.y, toX: e.x, toY: e.y, start: now, duration: 0, graphic: -1, animStart: now, startFrame: 0, lastFrame: -1, pack: false, shadow: null, under: null, frame: null, layer: DEFAULT_LAYER, overlays: new Map(), still: null };
        view.layer.addChild(t.sprite);
        this.tracks.set(e.id, t);
      } else if (newStep) {
        const at = this.drawnAt(t, now);
        Object.assign(t, { fromX: at.x, fromY: at.y, toX: e.x, toY: e.y, start: now, duration });
      }
      const type = typeOf(world, e);
      const sliding = now - t.start < t.duration && (t.fromX !== t.toX || t.fromY !== t.toY);
      // The sim names the sprite; a unit still sliding after the sim stopped it keeps walking until it arrives.
      const slide = sliding && type.walking && e.sprite.graphic === type.standing.graphic;
      const graphic = slide ? type.walking!.graphic : e.sprite.graphic;
      if (graphic !== t.graphic) {
        t.graphic = graphic;
        t.animStart = now;
        t.startFrame = slide ? 0 : e.sprite.frame;
        t.lastFrame = -1;
      }
      const at = this.drawnAt(t, now);
      // Everything stands on the ground as drawn (`world_z` is the hill's height there, `teleport`).
      const pos = view.ground.pixel(at.x, at.y);
      // Missiles fly above the ground: the sim's `world_z` over the ground's raises the sprite (a ground object's
      // `world_z` is the ground's, `TileMap.groundZ`, so it stays on it). The parts of the graphic at `draw_level` 10
      // or less stay at the shadow point on the ground (`RGE_Sprite::draw`).
      const graphicInfo = this.o.provider.graphicInfo(graphic);
      let lift = Math.round((e.z - view.ground.z(e.x, e.y)) * Z_PIXELS);
      if (graphicInfo && graphicInfo.deltas.length === 0 && graphicInfo.layer <= GROUND_LAYER) lift = 0;
      const split = lift !== 0 && graphicInfo !== null && splitsShadow(this.o.provider, graphicInfo);
      // A tree's shadow part goes through the terrain's clip masks, the tree itself over them (src/view.cpp:2335-2377).
      const clipped = !split && graphicInfo !== null && splitsTerrain(this.o.provider, graphicInfo);
      const layer = graphicInfo?.layer ?? DEFAULT_LAYER;
      const doppelganger = type.fogFlag === 4 && this.doppelgangers.onTile(Math.floor(e.x), Math.floor(e.y));
      // A passenger has left the map for its transport (`enter_obj` takes it off its tile): nothing draws or picks it.
      const aboard = e.inside !== undefined && e.inside !== null;
      const fog = aboard ? 'hidden' : fogDraw(type.fogFlag, e.state, tile, clipped ? Math.max(layer, TERRAIN_LAYER + 1) : layer, doppelganger);
      const underFog = clipped && !aboard ? fogDraw(type.fogFlag, e.state, tile, 0, doppelganger) : 'hidden';
      if (fog !== 'hidden') this.shown++;
      const art = fog === 'hidden' ? null : this.loadArt(graphic, e.owner, split ? 'air' : clipped ? 'above' : 'all');
      const shadow = split && art ? this.loadArt(graphic, e.owner, 'ground') : null;
      const under = underFog === 'hidden' ? null : this.loadArt(graphic, e.owner, 'terrain');
      if (t.shadow) t.shadow.visible = false;
      if (t.under) t.under.visible = false;
      for (const o of t.overlays.values()) o.sprite.visible = false;
      t.sprite.visible = art !== null;
      const drawn = art ?? under;
      // Unless something here changes, the next frame draws it the same (a stump's look also follows the copies).
      const still = !e.mover && !aboard && type.fogFlag !== 4 && !e.overlays?.length && !(drawn?.info && drawn.info.frameCount > 1);
      t.still = null;
      if (!drawn) {
        t.lastFrame = -1;
        if (still && fog === 'hidden' && underFog === 'hidden') t.still = this.stillOf(e, tile, -1, false);
        continue;
      }
      t.pack = drawn.pack;
      const info = drawn.info;
      let frameStep = 0;
      if (info && info.frameCount > 1) {
        const last = info.frameCount - 1;
        // A play-once sprite (the death animation) holds its last frame; the sim says when it has stopped.
        const once = (spriteInfo(e.sprite.graphic).flags & 8) !== 0 && !slide;
        frameStep = once && e.sprite.flag === 0 ? last : t.startFrame + (info.frameDuration > 0 ? Math.floor((now - t.animStart) / 1000 / info.frameDuration) : 0);
        frameStep = once ? Math.min(frameStep, last) : frameStep % info.frameCount;
      }
      const pick = info
        ? facingFrame(facetOf(e, info.angleCount), frameStep, info.angleCount, info.frameCount, info.mirroringMode)
        : { index: 0, flipped: false };
      if (under) {
        const s = (t.under ??= view.terrainLayer.addChild(new Sprite()));
        this.place(s, under.frames[pick.index] ?? under.frames[0]!, pick.flipped, pos.x, pos.y, false);
        s.zIndex = this.terrainZ(0, pos.y);
        s.visible = true;
      }
      if (!art) {
        t.lastFrame = -1;
        if (still && fog === 'hidden') t.still = this.stillOf(e, tile, -1, false);
        continue;
      }
      const frame = art.frames[pick.index] ?? art.frames[0]!;
      this.place(t.sprite, frame, pick.flipped, pos.x, pos.y - lift, fog === 'fogged');
      this.drawnOwners.set(e.id, e.owner);
      const parent = fog === 'terrain' ? view.terrainLayer : view.layer;
      if (t.sprite.parent !== parent) parent.addChild(t.sprite);
      t.frame = frame;
      t.layer = info?.layer ?? DEFAULT_LAYER;
      // Above every terrain tile; nearer the bottom of the screen draws later. Draw levels 0-5 go under the fog overlay.
      t.sprite.zIndex = fog === 'terrain' ? this.terrainZ(layer, pos.y) : world.map.width * world.map.height + Math.round(pos.y) + e.id * ID_ORDER;
      this.drawOverlays(t, e, pos.x, pos.y - lift, fog === 'fogged', now, parent);
      // `RGE_Active_Animated_Sprite::draw`: a frame change plays the sprite's sounds when it is drawn, and not fogged.
      const sounds = this.o.sounds;
      const unfogged = fog === 'plain' || (fog === 'terrain' && tile === TILE_VISIBLE);
      if (t.lastFrame !== -1 && frameStep !== t.lastFrame && unfogged && sounds?.spriteHasSounds(graphic) && this.onScreen(t.sprite)) {
        sounds.sprite(graphic, t.lastFrame, frameStep, info ? facetOf(e, info.angleCount) : 0);
      }
      t.lastFrame = frameStep;
      if (shadow) {
        const s = (t.shadow ??= view.layer.addChild(new Sprite()));
        this.place(s, shadow.frames[pick.index] ?? shadow.frames[0]!, false, pos.x, pos.y, fog === 'fogged');
        s.zIndex = t.sprite.zIndex - 1;
        s.visible = true;
      }
      if (still && !split && (underFog === 'hidden' || under)) t.still = this.stillOf(e, tile, fog === 'fogged' ? parity : -1, true);
    }
    this.drawDoppelgangers(area);
    for (const [id, t] of this.tracks) {
      if (near.has(id)) continue;
      t.sprite.destroy();
      t.shadow?.destroy();
      t.under?.destroy();
      for (const o of t.overlays.values()) o.sprite.destroy();
      this.tracks.delete(id);
      this.drawnOwners.delete(id);
    }
    this.drawHighlight();
    this.drawGhost();
  }

  private stillOf(e: Entity, tile: number, parity: number, shown: boolean): Still {
    const { graphic, frame, flag } = e.sprite!;
    return { type: e.type, graphic, frame, flag, state: e.state, owner: e.owner, facet: e.facet, tile, parity, shown };
  }

  /** Would still object `e` be drawn as `s` says it was? */
  private isStill(s: Still, e: Entity, tile: number, parity: number): boolean {
    const sprite = e.sprite!;
    return (
      s.graphic === sprite.graphic &&
      s.frame === sprite.frame &&
      s.flag === sprite.flag &&
      s.tile === tile &&
      (s.parity === -1 || s.parity === parity) &&
      s.state === e.state &&
      s.owner === e.owner &&
      s.type === e.type &&
      s.facet === e.facet &&
      !e.overlays?.length
    );
  }

  /**
   * The map pixels an object's point may stand in to be drawn: the view and the margins its sprite can reach into it
   * from, and the tiles under them (a raised tile is drawn higher than its flat place, so as far below as the highest).
   */
  private objectArea(): { x0: number; x1: number; y0: number; y1: number; range: TileRange | null } {
    const { view, world } = this.o;
    const { x, y, w, h } = view.view;
    const reach = view.ground.flat ? 0 : (view.ground.maxHeight + 1) * ELEV_H;
    const area = { x0: x - MARGIN_SIDE, x1: x + w + MARGIN_SIDE, y0: y - MARGIN_ABOVE, y1: y + h + MARGIN_BELOW };
    const range = visibleRange({ x: area.x0, y: area.y0, w: area.x1 - area.x0, h: area.y1 - area.y0 + reach }, world.map.width, world.map.height);
    return { ...area, range };
  }

  /**
   * Can an object on tiles `chunk` stand in `area`? Their flat places span the box of the chunk's corners, and a raised
   * tile draws its objects higher, up to the highest tile's height.
   */
  private chunkNear(chunk: TileRange, area: { x0: number; x1: number; y0: number; y1: number }): boolean {
    const { ground } = this.o.view;
    const width = this.o.world.map.width;
    const x0 = (chunk.col0 + chunk.row0) * (TILE_W / 2);
    const x1 = (chunk.col1 + chunk.row1 + 2) * (TILE_W / 2);
    const y0 = (chunk.row0 - chunk.col1 - 1 + width) * (TILE_H / 2) - (ground.flat ? 0 : (ground.maxHeight + 1) * ELEV_H);
    const y1 = (chunk.row1 + 1 - chunk.col0 + width) * (TILE_H / 2);
    return x1 >= area.x0 && x0 <= area.x1 && y1 >= area.y0 && y0 <= area.y1;
  }

  /**
   * The selection, the groups and the flashing targets follow their objects, drawn or not: `die_die_die` and
   * `destroy_obj` unselect the object, so a dying or removed one leaves the selection and its group; `change_ownership`
   * (a conversion, src/t_c_obj.cpp:254) is the old owner's `unselect_one_object`, and its group number goes too: the old
   * owner's group keys only ever take its own objects.
   */
  private followSelection(): void {
    const { world, player } = this.o;
    const ids = new Set([...this.selected, ...this.groups.keys(), ...this.flashes.keys()]);
    for (const id of this.owners.keys()) if (!ids.has(id)) this.owners.delete(id);
    for (const id of ids) {
      const e = world.entities.get(id);
      if (!e?.sprite) {
        this.deselect(id);
        this.groups.delete(id);
        this.flashes.delete(id);
        this.owners.delete(id);
        continue;
      }
      if (e.state >= ObjectState.Dying) {
        this.deselect(id);
        this.groups.delete(id);
      }
      const before = this.owners.get(id);
      if (before === e.owner) continue;
      this.owners.set(id, e.owner);
      if (before === player) {
        this.deselect(id);
        this.groups.delete(id);
      }
    }
  }

  /**
   * The object's damage sprites (`Entity.overlays`, sprites.md §6) over its own sprite, in the order the sim added them:
   * each at the object's point (an animated active sprite ignores its offset), animated from its start frame. The fire
   * sound they carry is not played.
   */
  private drawOverlays(t: Track, e: Entity, x: number, y: number, fogged: boolean, now: number, parent: Container): void {
    const list = e.overlays ?? [];
    for (const [graphic, o] of t.overlays) {
      if (list.some((overlay) => overlay.graphic === graphic)) continue;
      o.sprite.destroy();
      t.overlays.delete(graphic);
    }
    list.forEach((overlay, i) => {
      let o = t.overlays.get(overlay.graphic);
      if (!o) t.overlays.set(overlay.graphic, (o = { sprite: new Sprite(), start: now }));
      const art = this.loadArt(overlay.graphic, e.owner);
      if (!art) return;
      if (o.sprite.parent !== parent) parent.addChild(o.sprite);
      const info = art.info;
      const step = info && info.frameCount > 1 && info.frameDuration > 0 ? overlay.frame + Math.floor((now - o.start) / 1000 / info.frameDuration) : 0;
      const pick = info ? facingFrame(0, step % info.frameCount, info.angleCount, info.frameCount, info.mirroringMode) : { index: 0, flipped: false };
      this.place(o.sprite, art.frames[pick.index] ?? art.frames[0]!, pick.flipped, x, y, fogged);
      o.sprite.zIndex = t.sprite.zIndex + (i + 1) / 1000;
      o.sprite.visible = true;
    });
  }

  /** The damage sprites drawn over object `id` now, with pack art (for the tests). */
  drawnOverlays(id: number): number[] {
    const t = this.tracks.get(id);
    if (!t?.sprite.visible) return [];
    return [...t.overlays].filter(([graphic, o]) => o.sprite.visible && this.art.get(`${graphic}:${this.drawnOwners.get(id) || 1}:all`)?.pack).map(([graphic]) => graphic);
  }

  /** Does `sprite` show in the main view, between the HUD's top strip and bottom panel? */
  private onScreen(sprite: Sprite): boolean {
    const b = sprite.getBounds();
    const { width, height } = this.o.app.screen;
    return b.maxX > 0 && b.minX < width && b.maxY > TOP_HEIGHT && b.minY < height - BOTTOM_HEIGHT;
  }

  /**
   * `zIndex` in `MapView.terrainLayer` (over every terrain tile, under the fog overlay) of a sprite drawn through the
   * terrain's clip masks (`RGE_View::draw`, src/view.cpp:2335-2377, levels 0-5): by draw level, then nearer the bottom later.
   */
  private terrainZ(layer: number, y: number): number {
    const { width, height } = this.o.world.map;
    const level = Math.min(Math.max(layer, 0), TERRAIN_LAYER);
    const h = mapPixelSize(width, height).h;
    return level + Math.min(Math.max(y, 0), h) / (h + 1);
  }

  /** What the player knows of the tile under map point (x, y): `TILE_VISIBLE`, `TILE_FOGGED` or `TILE_BLACK`. */
  private tileState(x: number, y: number): number {
    return this.o.view.fogState(Math.floor(x), Math.floor(y));
  }

  /**
   * Puts `sprite` showing `frame` with its hotspot at map pixel (x, y), mirrored when `flipped`; `fogged` draws it with
   * every other pixel black (`fog_next_shape` 1), on whole pixels so the dots line up with the terrain's.
   */
  private place(sprite: Sprite, frame: SpriteFrame, flipped: boolean, x: number, y: number, fogged: boolean): void {
    let left = flipped ? x + frame.hotspotX : x - frame.hotspotX;
    let top = y - frame.hotspotY;
    let texture = frame.texture;
    if (fogged) {
      left = Math.round(left);
      top = Math.round(top);
      const { camera } = this.o.view;
      // A mirrored sprite's texture pixel lx lands on screen column left - lx - 1.
      texture = this.foggedTexture(texture, (left + top - camera.x - camera.y + (flipped ? 1 : 0)) & 1) ?? texture;
    }
    sprite.texture = texture;
    sprite.scale.x = flipped ? -1 : 1;
    sprite.position.set(left, top);
  }

  /**
   * `texture` drawn through the shadowing mask (`ASMSet_Shadowing`, src/drawarea.cpp:67): its pixel (x, y) black where
   * `x + y + parity` is odd, so on the screen the dots fall where the fogged terrain's do. Made once per texture and
   * parity; null when its pixels cannot be read.
   */
  private foggedTexture(texture: Texture, parity: number): Texture | null {
    let pair = this.foggedTextures.get(texture);
    if (!pair) this.foggedTextures.set(texture, (pair = []));
    const made = pair[parity];
    if (made !== undefined) return made;
    const data = this.pixelsOf(texture);
    let out: Texture | null = null;
    if (data) {
      const { width, height } = texture.frame;
      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      const g = canvas.getContext('2d')!;
      const image = g.createImageData(width, height);
      for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
          const from = (y * data.width + x) * 4;
          const to = (y * width + x) * 4;
          const black = ((x + y + parity) & 1) === 1;
          for (let c = 0; c < 3; c++) image.data[to + c] = black ? 0 : data.pixels[from + c]!;
          image.data[to + 3] = data.pixels[from + 3]!;
        }
      }
      g.putImageData(image, 0, 0);
      out = Texture.from(canvas);
      out.source.scaleMode = 'nearest';
      // A canvas texture reads back opaque (`extract.pixels`), which would make every corner of a fogged sprite a pick hit:
      // the pixels are known here.
      this.alpha.set(out, { pixels: image.data, width });
    }
    pair[parity] = out;
    return out;
  }

  /**
   * The player's doppelgangers (fog flag 3 in `RGE_Object_List::draw`): drawn fogged while their tile is fogged, in their
   * object's look and owner colour; on a visible tile the object itself shows, on an unexplored one nothing.
   */
  private drawDoppelgangers(area: { x0: number; x1: number; y0: number; y1: number }): void {
    const { world, view } = this.o;
    const copies = this.doppelgangers.copies;
    const drawn = new Set<number>();
    for (const c of copies.values()) {
      const pos = view.ground.pixel(c.x, c.y);
      if (pos.x < area.x0 || pos.x > area.x1 || pos.y < area.y0 || pos.y > area.y1) continue;
      drawn.add(c.id);
      let sprite = this.copySprites.get(c.id);
      if (!sprite) {
        sprite = view.layer.addChild(new Sprite());
        this.copySprites.set(c.id, sprite);
      }
      const graphicInfo = this.o.provider.graphicInfo(c.graphic);
      const clipped = graphicInfo !== null && splitsTerrain(this.o.provider, graphicInfo);
      const layer = graphicInfo?.layer ?? DEFAULT_LAYER;
      const fogged = this.tileState(c.x, c.y) === TILE_FOGGED;
      const art = fogged ? this.loadArt(c.graphic, c.owner, clipped ? 'above' : 'all') : null;
      const under = fogged && clipped ? this.loadArt(c.graphic, c.owner, 'terrain') : null;
      sprite.visible = art !== null;
      const underSprite = this.copyUnder.get(c.id);
      if (underSprite) underSprite.visible = false;
      const info = (art ?? under)?.info;
      const pick = info ? facingFrame(copyFacet(c, info.angleCount), c.frame % Math.max(1, info.frameCount), info.angleCount, info.frameCount, info.mirroringMode) : { index: 0, flipped: false };
      if (under) {
        const s = underSprite ?? view.terrainLayer.addChild(new Sprite());
        this.copyUnder.set(c.id, s);
        this.place(s, under.frames[pick.index] ?? under.frames[0]!, pick.flipped, pos.x, pos.y, false);
        s.zIndex = this.terrainZ(0, pos.y);
        s.visible = true;
      }
      if (!art) continue;
      // Draw levels 0-5 go plain under the fog overlay, which fogs them with the terrain.
      const low = !clipped && layer <= TERRAIN_LAYER;
      this.place(sprite, art.frames[pick.index] ?? art.frames[0]!, pick.flipped, pos.x, pos.y, !low);
      const parent = low ? view.terrainLayer : view.layer;
      if (sprite.parent !== parent) parent.addChild(sprite);
      sprite.zIndex = low ? this.terrainZ(layer, pos.y) : world.map.width * world.map.height + Math.round(pos.y);
    }
    for (const [id, s] of this.copySprites) {
      if (drawn.has(id)) continue;
      s.destroy();
      this.copySprites.delete(id);
      this.copyUnder.get(id)?.destroy();
      this.copyUnder.delete(id);
    }
  }

  /**
   * `RGE_View::draw_place_object` (src/view.cpp:1160): the building's standing sprite at the aligned map point under the
   * pointer, in the player's colour and building facet, see-through, and shaded red where `check_placement` fails.
   */
  private drawGhost(): void {
    const sprite = this.ghostSprite;
    const unit = this.placing;
    sprite.visible = false;
    this.wallGhost.visible = false;
    if (unit === null || !this.pointer) {
      this.ghostAt = null;
      return;
    }
    const { world, view, player } = this.o;
    if (this.isWall(unit)) return this.drawWallGhost(unit, this.pointer);
    // The player's own master: its sprite follows the age (the Tool Age House).
    const t = master(world, player, unit);
    const { camera } = view;
    const at = view.ground.pointAt(this.pointer.x + camera.x, this.pointer.y + camera.y);
    // `fixup_pick_info`: a point off the map is pulled onto its last tile.
    const col = Math.min(Math.max(at.col, 0), world.map.width - 1);
    const row = Math.min(Math.max(at.row, 0), world.map.height - 1);
    const { x, y } = alignBuilding(t.radiusX, t.radiusY, col, row, world.map.width, world.map.height);
    // `draw_place_object` checks with `check_vis` 1 (src/view.cpp:1195), as the `build` command does: red over unexplored tiles.
    const fits = checkPlacement(world.gameContext(), t, x, y, true, true, player) === 0;
    this.ghostAt = { unit, x, y, fits };
    const art = this.loadArt(t.standing.graphic, player);
    if (!art) return;
    const info = art.info;
    const facet = buildingFacet(world, player, unit);
    const pick = info ? facingFrame(facet, 0, info.angleCount, info.frameCount, info.mirroringMode) : { index: 0, flipped: false };
    const frame = art.frames[pick.index] ?? art.frames[0]!;
    const pos = view.ground.placePixel(x, y, t.radiusX, t.radiusY);
    sprite.texture = frame.texture;
    sprite.scale.x = pick.flipped ? -1 : 1;
    sprite.position.set(pick.flipped ? pos.x + frame.hotspotX : pos.x - frame.hotspotX, pos.y - frame.hotspotY);
    sprite.alpha = GHOST_ALPHA;
    const pulse = (world.worldTime >> 7) & 7;
    sprite.tint = fits ? 0xffffff : GHOST_BLOCKED[pulse < 4 ? pulse : 8 - pulse]!;
    sprite.visible = true;
  }

  /** Left click while placing (`command_place_object`): a `build` for the selected builders where the building fits. */
  private placeAt(keepPlacing: boolean): void {
    const ghost = this.ghostAt;
    if (!ghost?.fits) return;
    const units = this.builders();
    if (units.length === 0) return;
    if (!keepPlacing) this.cancelPlacement();
    this.o.issue({ type: 'build', units, unitType: ghost.unit, x: ghost.x, y: ghost.y });
  }

  /** The selected own objects that can build (the Villagers, `command_make_building`'s and `command_make_wall`'s). */
  private builders(): number[] {
    return this.selectedOwn().filter((id) => {
      const e = this.o.world.entities.get(id);
      return e !== undefined && isUnit(e) && canBuild(unitType(e.type));
    });
  }

  /** `building_connect_flag`: master `unit` is placed as a line (`command_building` enters `PLACE_CONNECTED`). */
  private isWall(unit: number): boolean {
    return master(this.o.world, this.o.player, unit).building?.connect ?? false;
  }

  /**
   * The map tile under canvas point `p`: off the map, null (`pick` misses), or with `clamp` the nearest edge tile
   * (`fixup_pick_info`).
   */
  private tileAt(p: { x: number; y: number }, clamp: boolean): { col: number; row: number } | null {
    const { world, view } = this.o;
    const at = view.ground.pointAt(p.x + view.camera.x, p.y + view.camera.y);
    const col = Math.floor(at.col);
    const row = Math.floor(at.row);
    const { width, height } = world.map;
    if (col >= 0 && row >= 0 && col < width && row < height) return { col, row };
    return clamp ? { col: Math.min(Math.max(col, 0), width - 1), row: Math.min(Math.max(row, 0), height - 1) } : null;
  }

  /**
   * `TRIBE_Main_View::draw_multi_object_outline` and `draw_wall_outline` (src/tvw_main.cpp:21, :204): with no drag, one
   * segment (facet 2) on the tile under the pointer; while dragging, every segment of the line (`wallOutline`). Each is
   * the master's standing sprite at the tile's centre in the facet it would join with (the master's `draw` takes facet
   * f + 1 and shows sprite facet f, economy.md §4.8.2), see-through, and shaded red where `check_placement` fails there
   * (with `check_vis`, as the line command checks: an unexplored tile fails).
   */
  private drawWallGhost(unit: number, pointer: { x: number; y: number }): void {
    const { world, view, player } = this.o;
    const t = master(world, player, unit);
    const hover = this.tileAt(pointer, true)!;
    const d = this.wallDrag;
    const tiles = d ? wallOutline(d.col1, d.row1, d.col2, d.row2) : [{ ...hover, facet: 2 }];
    const segments = tiles.map(({ col, row, facet }) => {
      const x = col + 0.5;
      const y = row + 0.5;
      return { x, y, facet, fits: checkPlacement(world.gameContext(), t, x, y, true, true, player) === 0 };
    });
    const at = d ? { x: d.col2 + 0.5, y: d.row2 + 0.5 } : { x: hover.col + 0.5, y: hover.row + 0.5 };
    this.ghostAt = { unit, ...at, fits: segments.every((s) => s.fits), segments };
    const art = this.loadArt(t.standing.graphic, player);
    if (!art) return;
    const info = art.info;
    const pulse = (world.worldTime >> 7) & 7;
    const blocked = GHOST_BLOCKED[pulse < 4 ? pulse : 8 - pulse]!;
    segments.forEach((s, i) => {
      let sprite = this.wallSprites[i];
      if (!sprite) {
        sprite = new Sprite();
        this.wallSprites.push(sprite);
        this.wallGhost.addChild(sprite);
      }
      const pick = info ? facingFrame(s.facet, 0, info.angleCount, info.frameCount, info.mirroringMode) : { index: 0, flipped: false };
      const frame = art.frames[pick.index] ?? art.frames[0]!;
      const pos = view.ground.placePixel(s.x, s.y, t.radiusX, t.radiusY, false);
      sprite.texture = frame.texture;
      sprite.scale.x = pick.flipped ? -1 : 1;
      sprite.position.set(pick.flipped ? pos.x + frame.hotspotX : pos.x - frame.hotspotX, pos.y - frame.hotspotY);
      sprite.zIndex = pos.y;
      sprite.alpha = GHOST_ALPHA;
      sprite.tint = s.fits ? 0xffffff : blocked;
      sprite.visible = true;
    });
    for (let i = segments.length; i < this.wallSprites.length; i++) this.wallSprites[i]!.visible = false;
    this.wallGhost.visible = true;
  }

  /**
   * The release of a wall drag (`mouse_left_up_action`, src/vw_main.cpp:441; `command_place_multi_object`,
   * src/tvw_main.cpp:276): `build-wall` from the pressed tile to the released one for the selected builders, the sim
   * skipping tiles where a segment does not fit; placing ends unless Shift or Ctrl is held.
   */
  private placeWall(keepPlacing: boolean): void {
    const d = this.wallDrag;
    const unit = this.placing;
    this.wallDrag = null;
    if (!d || unit === null) return;
    const units = this.builders();
    if (!keepPlacing) this.cancelPlacement();
    if (units.length > 0) this.o.issue({ type: 'build-wall', units, unitType: unit, x1: d.col1, y1: d.row1, x2: d.col2, y2: d.row2 });
  }

  /**
   * The selection marker of the original's default outline (`outline_type` 2, RGE_Static_Object::capture_frame_3d_square):
   * a white diamond on the ground, the unit's outline radii wide, and a 24x2 hit point bar (green, red where hurt) over
   * its top corner while it has hit points left. Only selected objects show the bar (`selected & 1`, outline type 2).
   * An ordered target flashes its diamond green (`selected & 2`) for 1.5 s, on and off every 256 ms. The diamond is a
   * draw level 10 node (under every object), the bar a level 30 one (over them).
   */
  private drawHighlight(): void {
    const g = this.highlight.clear();
    const lines = this.outlines.clear();
    for (const sprite of this.groupSprites.values()) sprite.visible = false;
    const { world, provider } = this.o;
    const now = performance.now();
    const flashing = new Set<number>();
    for (const [id, start] of this.flashes) {
      const elapsed = Math.trunc(now - start);
      if (elapsed > FLASH_MS) this.flashes.delete(id);
      else if ((elapsed & FLASH_BIT) === 0) flashing.add(id);
    }
    for (const id of new Set([...this.selected, ...flashing])) {
      const t = this.tracks.get(id);
      const e = world.entities.get(id);
      if (!t?.sprite.visible || !e) continue;
      const type = typeOf(world, e);
      const [rx, ry, rz] = provider.unitInfo(e.type)?.outline ?? [type.radiusX, type.radiusY, type.radiusZ];
      const at = this.drawnAt(t, now);
      const o = this.o.view.ground.pixel(at.x, at.y);
      const corners = [outlinePoint(o, rx, -ry, 0), outlinePoint(o, rx, ry, 0), outlinePoint(o, -rx, ry, 0), outlinePoint(o, -rx, -ry, 0)];
      lines.poly(corners.flatMap((c) => [c.x + 0.5, c.y + 0.5])).stroke({ width: 1, color: flashing.has(id) ? BAR_FILLED : SELECTION_COLOUR });
      if (!this.selected.has(id)) continue;
      this.drawGroupNumber(id, e, corners[3]!);
      const hp = Math.floor(e.hp);
      if (type.hitPoints <= 0 || hp <= 0) continue;
      const bar = outlinePoint(o, rx, -ry, rz);
      const left = bar.x - 12;
      const top = bar.y - 2;
      const filled = hp >= type.hitPoints ? BAR_WIDTH : Math.min(BAR_WIDTH - 1, Math.floor((hp * BAR_WIDTH) / type.hitPoints) + 1);
      g.rect(left, top, BAR_WIDTH, 2).fill(BAR_EMPTY);
      g.rect(left, top, filled, 2).fill(BAR_FILLED);
    }
  }

  /**
   * The number of a selected own object's group 1-9, drawn over the diamond (`RGE_Static_Object::draw`,
   * src/stat_obj.cpp:707): `FShape + selected_group` read as shape infos skips the file header, so frame
   * `selected_group - 1` of groupnum.shp, at the diamond's fourth corner, 6 px left and 8 up, at draw level 30.
   */
  private drawGroupNumber(id: number, e: Entity, corner: { x: number; y: number }): void {
    const group = this.groups.get(id);
    if (group === undefined || group < 1 || group > 9 || e.owner !== this.o.player) return;
    const texture = this.groupDigits[group];
    const frame = this.o.provider.interfaceFrame(SLP.groupNumbers, group - 1);
    if (!texture || !frame) return;
    let sprite = this.groupSprites.get(id);
    if (!sprite) {
      sprite = new Sprite();
      this.groupMarks.addChild(sprite);
      this.groupSprites.set(id, sprite);
    }
    sprite.texture = texture;
    sprite.position.set(corner.x - 6 - frame.hotspotX, corner.y - 8 - frame.hotspotY);
    sprite.visible = true;
  }

  private listen(canvas: HTMLCanvasElement): void {
    const on = <K extends keyof HTMLElementEventMap>(type: K, fn: (e: HTMLElementEventMap[K]) => void) => {
      canvas.addEventListener(type, fn);
      this.cleanup.push(() => canvas.removeEventListener(type, fn));
    };
    const local = (e: MouseEvent) => {
      const r = canvas.getBoundingClientRect();
      return { x: e.clientX - r.left, y: e.clientY - r.top };
    };
    on('contextmenu', (e) => e.preventDefault());
    on('pointerleave', () => {
      this.pointer = null;
      this.rollover(undefined);
      if (this.rightDown) {
        this.rightDown = null;
        canvas.style.cursor = '';
      }
    });
    on('pointerdown', (e) => {
      const p = local(e);
      this.pointer = p;
      if (this.placing !== null) {
        if (this.isWall(this.placing)) {
          // `start_scroll_view(3)`: the press starts the line on the tile under the pointer, when that is on the map.
          if (e.button === 0) {
            const tile = this.tileAt(p, false);
            this.wallDrag = tile && { col1: tile.col, row1: tile.row, col2: tile.col, row2: tile.row };
            // `capture_mouse`: the release ends the line wherever it happens.
            if (tile) canvas.setPointerCapture(e.pointerId);
          } else if (e.button === 2) this.cancelPlacement();
          return;
        }
        // Shift (or ctrl) keeps placing more of the same, as `reset_mode` 0 in the original.
        if (e.button === 0) {
          this.drawGhost();
          this.placeAt(e.shiftKey || e.ctrlKey);
        } else if (e.button === 2) this.cancelPlacement();
        return;
      }
      // An order mode takes the next left click, or right click but in the Move mode (whose right click is a plain order).
      if (this.clickMode && (e.button === 0 || (e.button === 2 && this.clickMode !== 'move'))) return this.commandAt(this.clickMode, p.x, p.y);
      if (e.button === 0) this.press = { ...p, boxing: false };
      else if (e.button === 2) {
        this.rightDown = {
          x: p.x,
          y: p.y,
          clientX: e.clientX,
          clientY: e.clientY,
          lastClientX: e.clientX,
          lastClientY: e.clientY,
          dragged: false,
        };
      }
    });
    on('pointermove', (e) => {
      const p = local(e);
      this.pointer = p;
      if (this.rightDown) {
        if (!this.rightDown.dragged) {
          const dist = Math.hypot(e.clientX - this.rightDown.clientX, e.clientY - this.rightDown.clientY);
          if (dist >= 14) {
            this.rightDown.dragged = true;
            this.rightDown.lastClientX = e.clientX;
            this.rightDown.lastClientY = e.clientY;
            canvas.style.cursor = 'grabbing';
          }
        }
        if (this.rightDown.dragged) {
          const dx = e.clientX - this.rightDown.lastClientX;
          const dy = e.clientY - this.rightDown.lastClientY;
          this.rightDown.lastClientX = e.clientX;
          this.rightDown.lastClientY = e.clientY;
          this.o.view.camera.moveTo(this.o.view.camera.x - dx, this.o.view.camera.y - dy);
          return;
        }
      }
      if (this.placing !== null) {
        // A right press during the drag (a chorded button, which comes as a move) stops placing, as a right click does.
        if (this.wallDrag && e.buttons & 2) return this.cancelPlacement();
        // `handle_scroll_view` of the line: its end follows the pointer while it is over the map.
        const tile = this.wallDrag && this.tileAt(p, false);
        if (this.wallDrag && tile) Object.assign(this.wallDrag, { col2: tile.col, row2: tile.row });
        return;
      }
      if (!this.press) {
        const enemy = this.attackTarget(p.x, p.y);
        const work = enemy ? undefined : this.workTarget(p.x, p.y);
        const ring = enemy || work ? false : (this.priestTarget(p.x, p.y) ?? this.boardTarget(p.x, p.y)) !== undefined;
        canvas.style.cursor = enemy ? this.attackCursor : work ? 'var(--cursor-work, pointer)' : ring ? 'var(--cursor-target, crosshair)' : '';
        this.rollover(enemy);
        return;
      }
      if (!this.press.boxing && Math.hypot(p.x - this.press.x, p.y - this.press.y) < BOX_THRESHOLD) return;
      this.press.boxing = true;
      this.box.clear().rect(Math.min(p.x, this.press.x), Math.min(p.y, this.press.y), Math.abs(p.x - this.press.x), Math.abs(p.y - this.press.y));
      this.box.stroke({ width: 1, color: SELECTION_COLOUR });
    });
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (target && ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName)) return;
      const k = groupKey(e);
      if (k) {
        e.preventDefault();
        if (k.action === 'assign') this.assignGroup(k.id);
        else this.recallGroup(k.id, k.add, k.centre);
        return;
      }
      // Space (src/scr_game.cpp:1835; with Ctrl or Alt it does nothing, :1621, :1580); a focused dialog button keeps its own Space.
      if (e.code === 'Space' && !e.ctrlKey && !e.altKey && target?.tagName !== 'BUTTON') {
        e.preventDefault();
        this.viewSelected();
        return;
      }
      if (e.repeat) return;
      const s = selectKey(e, pressedLetter(e), this.selectLetters(), this.o.inBuildMenu?.() ?? false);
      if (!s) return;
      e.preventDefault();
      if (s.kind === 'building') this.selectBuilding(s.master);
      else if (s.kind === 'tab') this.tab(s.forward);
      else if (s.kind === 'ungroup') this.ungroup();
      else this.armMove();
    };
    window.addEventListener('keydown', onKey);
    this.cleanup.push(() => window.removeEventListener('keydown', onKey));
    on('pointerup', (e) => {
      if (e.button === 2 && this.rightDown) {
        const wasDragged = this.rightDown.dragged;
        const clickX = this.rightDown.x;
        const clickY = this.rightDown.y;
        this.rightDown = null;
        canvas.style.cursor = '';
        if (!wasDragged) {
          this.orderAt(clickX, clickY);
        }
        return;
      }
      if (e.button === 0 && this.wallDrag) return this.placeWall(e.shiftKey || e.ctrlKey);
      if (e.button !== 0 || !this.press) return;
      const p = local(e);
      if (this.press.boxing) {
        if (!e.shiftKey) this.unselect();
        this.selectBox(this.press.x, this.press.y, p.x, p.y);
      } else this.clickAt(p.x, p.y, e.shiftKey || e.ctrlKey);
      this.press = null;
      this.box.clear();
    });
    on('pointercancel', () => {
      if (this.rightDown) {
        this.rightDown = null;
        canvas.style.cursor = '';
      }
    });
  }

  /** The letters of the selection keys, read from the language strings each time like the original reads them at setup. */
  private selectLetters(): SelectLetters {
    const { provider } = this.o;
    return {
      townCenter: hotkeyLetter(provider, HOTKEY_STRING.viewTownCenter),
      buildings: SELECT_BUILDING_MASTERS.map((_, i) => hotkeyLetter(provider, HOTKEY_STRING.selectBuilding + i)),
      ungroup: hotkeyLetter(provider, HOTKEY_STRING.ungroup),
      move: hotkeyLetter(provider, HOTKEY_STRING.move),
    };
  }

  /**
   * `command_select_building` (scr_game.cpp:4177): selects the player's next finished building of master `unit` (after
   * the panel's object when that is one, wrapping to the first; `find_obj`, src/tplayer.cpp:627, which takes one still
   * being built after it) and scrolls the view there. Nothing changes when there is none.
   */
  selectBuilding(unit: number): void {
    const own = [...this.o.world.entities.ofPlayer(this.o.player)];
    const current = this.primary === null ? undefined : this.o.world.entities.get(this.primary);
    const after = current?.type === unit ? own.findIndex((e) => e.id === current.id) : -1;
    const next =
      (after >= 0 ? own.slice(after + 1).find((e) => e.type === unit && e.state <= ObjectState.Active) : undefined) ??
      own.find((e) => e.type === unit && e.state === ObjectState.Active);
    if (!next) return;
    this.unselect();
    this.selectObject(next);
    this.o.view.lookAt(next.x, next.y);
  }

  /** `command_tab_selected`: `selected_obj` steps through the selection. */
  tab(forward: boolean): void {
    const to = tabTarget([...this.selected], this.primary, forward);
    if (to !== null) this.primaryId = to;
  }

  /**
   * The Move key (`command_move`, scr_game.cpp:4060): with an own object selected, the next left click orders the
   * selection there (`command_make_move`), and the message line says so. Esc or unselecting leaves the mode.
   */
  private armMove(): void {
    if (this.selectedOwn().length === 0) return;
    this.armCommand('move');
  }

  /**
   * A grid button's order mode (`command_repair`, `command_attack_ground`, `command_heal`, `command_convert`,
   * `command_unload`, scr_game.cpp:3840-4370): the next left or right click on the map names its target, and the message line says so.
   */
  armCommand(mode: ClickMode): void {
    this.cancelPlacement();
    this.setClickMode(mode);
    this.o.onMessage?.(MODE_MESSAGE[mode]);
  }

  /** The order mode waiting for its click, or null. */
  get commandMode(): ClickMode | null {
    return this.clickMode;
  }

  /** `command_cancel` in an order mode (Cancel, Esc): back to the normal mode, the selection kept. */
  cancelCommand(): void {
    this.setClickMode(null);
  }

  private setClickMode(mode: ClickMode | null): void {
    this.clickMode = mode;
  }

  /** The order mode's click (`TRIBE_Main_View::mouse_left_up_action` / `_right_`, src/tvw_main.cpp:376-600); the mode ends. */
  private commandAt(mode: ClickMode, x: number, y: number): void {
    this.setClickMode(null);
    if (mode === 'move') this.moveTo(x, y);
    else if (mode === 'repair') this.repairAt(x, y);
    else if (mode === 'attack-ground') this.groundAt(x, y);
    else if (mode === 'unload') this.unloadAt(x, y);
    else this.doAt(x, y, mode === 'heal' ? ACTION_HEAL : ACTION_CONVERT);
  }

  /**
   * The click of the Repair mode (src/tvw_main.cpp:449, `command_make_repair`, src/tplayer.cpp:995): the picked object,
   * when it is an own building short of its hit points and not dying, is repaired by the selected Villagers, and flashes;
   * anything else plays cantdo.wav.
   */
  private repairAt(x: number, y: number): void {
    const { world, player } = this.o;
    const target = this.topmostAt(x, y, () => true);
    const t = target && typeOf(world, target);
    const units = this.commandObjects(SELECT_BOX, GROUP_CIVILIAN);
    if (!target || !t || target.owner !== player || t.masterType !== MASTER_TYPE_BUILDING || target.hp >= t.hitPoints || target.state >= ObjectState.Dying || units.length === 0) {
      this.o.sounds?.cantDo();
      return;
    }
    this.flashes.clear();
    this.flashes.set(target.id, performance.now());
    this.o.issue({ type: 'repair', units, target: target.id });
  }

  /**
   * The click of the Attack Ground mode: the map point under the pointer (`pick1` on the terrain, `fixup_pick_info`) goes
   * to `command_attack_ground` (src/tplayer.cpp:963), which sends `attack-ground` for the selected units of `unit_level`
   * 4. A click off the map, or no such unit, plays cantdo.wav.
   */
  private groundAt(x: number, y: number): void {
    const { camera, ground } = this.o.view;
    const { col, row } = ground.pointAt(x + camera.x, y + camera.y);
    const { width, height } = this.o.world.map;
    const units = col < 0 || row < 0 || col >= width || row >= height ? [] : this.commandObjects(SELECT_BOX, -1, LEVEL_SOLDIER);
    if (units.length === 0) {
      this.o.sounds?.cantDo();
      return;
    }
    // `reset_display_object_selection(2)`: the flashing targets stop.
    this.flashes.clear();
    this.markAt(x, y, GROUND_INTERVAL_MS);
    this.o.issue({ type: 'attack-ground', units, x: col, y: row });
  }

  /**
   * The click of the Unload mode (src/tvw_main.cpp:463): the map point under the pointer goes to `command_make_unload`
   * (src/tplayer.cpp:1017), which sends `unload` for the selected transports (`unit_level` 7): they sail there and drop
   * their passengers on that shore (naval.md §7.6). A click off the map, or no transport, plays cantdo.wav.
   */
  private unloadAt(x: number, y: number): void {
    const { camera, ground } = this.o.view;
    const { col, row } = ground.pointAt(x + camera.x, y + camera.y);
    const { width, height } = this.o.world.map;
    const units = col < 0 || row < 0 || col >= width || row >= height ? [] : this.commandObjects(SELECT_BOX, -1, UNIT_LEVEL_TRANSPORT);
    if (units.length === 0) {
      this.o.sounds?.cantDo();
      return;
    }
    this.flashes.clear();
    this.markAt(x, y, GROUND_INTERVAL_MS);
    this.o.issue({ type: 'unload', units, x: col, y: row });
  }

  /**
   * The click of the Heal and Convert modes (`command_make_do(x, y, 0, action)`, src/vw_main.cpp:935): the object under
   * the pointer that a selected unit's task list gives that action (`pick_best_target` with the action type, the
   * selection's own objects included) is ordered (`command_make_do`: a `work` order, support-actions.md §4.7) for the
   * selected units, and flashes; with none, cantdo.wav.
   */
  private doAt(x: number, y: number, action: number): void {
    const { world } = this.o;
    const units = this.orderedUnits();
    const ordered = units.flatMap((id) => world.entities.get(id) ?? []);
    const target = this.topmostAt(x, y, (e) => e.state < ObjectState.Dying && ordered.some((u) => targetActionType(world, u, e) === action), false);
    if (!target || units.length === 0) {
      this.o.sounds?.cantDo();
      return;
    }
    this.flashes.clear();
    this.flashes.set(target.id, performance.now());
    this.o.issue({ type: 'work', units, target: target.id, x: target.x, y: target.y });
  }

  /**
   * `get_selected_objects_to_command` (src/player.cpp:1648): the selected objects of the player that are active, of select
   * level `minLevel` or more, of object group `group` (-1 any), of `unit_level` `unitLevel` (-1 any), and of an action
   * master type other than a tree.
   */
  commandObjects(minLevel: number, group = -1, unitLevel = -1): number[] {
    const { world, player, provider } = this.o;
    return [...this.selected].filter((id) => {
      const e = world.entities.get(id);
      if (!e || e.owner !== player || e.state !== ObjectState.Active || this.selectLevel(e) < minLevel) return false;
      const t = typeOf(world, e);
      if (unitLevel !== -1 && levelOf(e.type, (unit) => provider.unitInfo(unit)?.level ?? null) !== unitLevel) return false;
      return (group === -1 || t.group === group) && t.masterType >= MASTER_TYPE_ACTION && t.masterType !== MASTER_TYPE_TREE;
    });
  }

  /** The left click of the Move mode: the selected units walk to the map point (a click off the map only ends the mode). */
  private moveTo(x: number, y: number): void {
    const { camera, ground } = this.o.view;
    const { col, row } = ground.pointAt(x + camera.x, y + camera.y);
    const { width, height } = this.o.world.map;
    if (col < 0 || row < 0 || col >= width || row >= height) return;
    const units = this.orderedUnits();
    if (units.length === 0) return;
    this.flashes.clear();
    this.o.issue({ type: 'move', units, x: col, y: row });
  }

  /**
   * `select_level` of an object's master (the dat's interaction mode); without a pack, guessed from the sim's table:
   * 4 for units, 3 for buildings as the dat has them, 2 for the rest (trees, mines, animals).
   */
  private selectLevel(e: Entity): number {
    const known = this.o.provider.unitInfo(e.type)?.selectLevel;
    if (known !== undefined) return known;
    const t = unitType(e.type);
    return t.group === GROUP_NONE ? 0 : isUnit(e) ? SELECT_BOX : isBuildingObject(e) ? SELECT_BUILDING : SELECT_CLICK;
  }

  /** `select_one_object`: adds `id` while the selection has room, and makes it the panel's object. False when full. */
  private selectOne(id: number): boolean {
    if (this.selected.size >= MAX_SELECTED) return false;
    this.selected.add(id);
    this.primaryId = id;
    return true;
  }

  /** `select_object`: selects `e` with its selection sound, and with it the rest of its group (Group button groups only). */
  private selectObject(e: Entity): void {
    if (this.selectOne(e.id)) this.o.sounds?.selected(e);
    const group = this.groups.get(e.id);
    if (group !== undefined && group >= FIRST_GROUP) {
      for (const [id, g] of this.groups) if (g === group && id !== e.id && this.selected.size < MAX_SELECTED) this.selected.add(id);
    }
    this.primaryId = e.id;
  }

  /**
   * A left click on the map with the two-button mouse (`RGE_Main_View::mouse_left_up_action`, `interface_style` 2,
   * src/vw_main.cpp:470-530): the topmost object of `select_level` 2 or more under the pointer, whoever owns it, on a
   * tile the player sees (objects drawn under the fog can be ordered at but not selected).
   * - A plain click selects it alone (with its group); on an object already selected among others, it alone; on nothing,
   *   it unselects. A second click on the same spot picks past the panel's object to the next one under it.
   * - Shift or Ctrl takes the object out of the selection, or adds it; it first clears the selection when the panel's
   *   object is another player's or the selection's lowest `select_level` differs from the object's.
   */
  private clickAt(x: number, y: number, toggle: boolean): void {
    const again = this.lastClick !== null && this.lastClick.x === x && this.lastClick.y === y;
    const exclude = again && !toggle ? this.primary : null;
    const hit = this.topmostAt(x, y, (e) => e.id !== exclude && this.selectLevel(e) >= SELECT_CLICK && this.tileState(e.x, e.y) === TILE_VISIBLE, false);
    this.lastClick = null;
    if (toggle) {
      if (!hit) return;
      if (this.selected.has(hit.id)) {
        this.deselect(hit.id);
        return;
      }
      const primary = this.primary === null ? undefined : this.o.world.entities.get(this.primary);
      const levels = [...this.selected].flatMap((id) => {
        const s = this.o.world.entities.get(id);
        return s ? [this.selectLevel(s)] : [];
      });
      if (primary && (primary.owner !== this.o.player || Math.min(...levels) !== this.selectLevel(hit))) this.unselect();
      this.selectObject(hit);
      return;
    }
    if (!hit) return this.unselect();
    if (this.selected.has(hit.id)) {
      if (this.selected.size < 2) return;
      this.unselect();
      this.selectOne(hit.id);
      this.o.sounds?.selected(hit);
    } else {
      this.unselect();
      this.selectObject(hit);
    }
    this.lastClick = { x, y };
  }

  /** `pick_multi(4, ...)`: own units (`select_level` 4) whose map position lies inside the box, up to 25, without a sound. */
  private selectBox(x0: number, y0: number, x1: number, y1: number): void {
    const [left, right] = [Math.min(x0, x1), Math.max(x0, x1)];
    const [top, bottom] = [Math.min(y0, y1), Math.max(y0, y1)];
    for (const e of this.o.world.entities.ofPlayer(this.o.player)) {
      if (!this.tracks.get(e.id)?.sprite.visible || this.selectLevel(e) !== SELECT_BOX) continue;
      const p = this.screenPos(e.id)!;
      if (p.x >= left && p.x <= right && p.y >= top && p.y <= bottom) this.selectOne(e.id);
    }
  }

  /** Shows the attack rollover text of `enemy` (`get_mouse_pointer_action_vars` facet 4), or takes it away. */
  private rollover(enemy: Entity | undefined): void {
    const id = enemy?.id ?? null;
    if (id === this.rolloverId) return;
    this.rolloverId = id;
    this.o.onRollover?.(enemy ? attackRollover(this.o.provider, unitType(enemy.type).group) || null : null);
  }

  /** Is the pixel of `sprite`'s texture under canvas point (x, y) opaque? Reads and caches the texture's pixels. */
  private opaque(sprite: Sprite, x: number, y: number): boolean {
    const texture = sprite.texture;
    const data = this.pixelsOf(texture);
    if (!data) return true;
    const p = sprite.toLocal({ x, y });
    const [px, py] = [Math.floor(p.x), Math.floor(p.y)];
    if (px < 0 || py < 0 || px >= texture.frame.width || py >= texture.frame.height) return false;
    return data.pixels[(py * data.width + px) * 4 + 3]! > HIT_ALPHA;
  }

  /** The pixels of `texture` (RGBA rows `width` pixels apart), read once; null when they cannot be read. */
  private pixelsOf(texture: Texture): { pixels: Uint8ClampedArray; width: number } | null {
    let data = this.alpha.get(texture);
    if (data === undefined) {
      try {
        const { pixels, width } = this.o.app.renderer.extract.pixels(texture);
        data = { pixels, width };
      } catch {
        data = null;
      }
      this.alpha.set(texture, data);
    }
    return data;
  }

  /**
   * Topmost enemy object the selection can attack whose drawn pixels cover canvas point (x, y): another player's (not
   * Gaia's), alive (`object_state` up to active), of a group the right-click table attacks, with an attacker selected.
   */
  private attackTarget(x: number, y: number): Entity | undefined {
    const { world, player } = this.o;
    if (!this.selectedOwn().some((id) => canAttack(unitType(world.entities.get(id)!.type)))) return undefined;
    return this.topmostAt(x, y, (e) => e.owner > 0 && e.owner !== player && e.state <= ObjectState.Active && isAttackable(unitType(e.type)));
  }

  /**
   * The object passing `test` picked at canvas point (x, y), as `RGE_Main_View::pick1` (src/vw_main.cpp:983) picks: each
   * drawn part of draw level 10 to 20 gives its object a confidence (`pick_objects`), the object's best one a weight
   * (`pick_weight`), and the heaviest wins; on a tie the better confidence, then the higher draw level, then the sprite
   * drawn on top. A building picks inside each row of a part's drawn span, gaps included; a unit also inside its frame
   * box and up to 15 px round it. Order targets skip the player's own selected objects.
   */
  private topmostAt(x: number, y: number, test: (e: Entity) => boolean, skipOwnSelected = true): Entity | undefined {
    let best: { e: Entity; weight: number; confidence: number; layer: number; z: number } | undefined;
    for (const [id, t] of this.tracks) {
      const e = this.o.world.entities.get(id);
      if (!e || !t.sprite.visible || !t.frame || !test(e)) continue;
      if (skipOwnSelected && this.selected.has(id) && e.owner === this.o.player) continue;
      const local = t.sprite.toLocal({ x, y });
      let confidence = 0;
      let layer = 0;
      for (const part of t.frame.parts ?? [{ texture: t.frame.texture, x: 0, y: 0, flipped: false, layer: t.layer }]) {
        if (part.layer < PICK_MIN_LEVEL || part.layer > PICK_MAX_LEVEL) continue;
        const c = this.partConfidenceAt(part, local.x, local.y);
        if (c === 0) continue;
        if (confidence === 0 || c < confidence || (c === confidence && part.layer > layer)) [confidence, layer] = [c, part.layer];
      }
      if (confidence === 0) continue;
      const weight = pickWeight(this.selectLevel(e), e.type, e.state < ObjectState.Active, confidence);
      if (weight <= 0) continue;
      const z = t.sprite.zIndex;
      if (
        !best ||
        weight > best.weight ||
        (weight === best.weight && (confidence < best.confidence || (confidence === best.confidence && (layer > best.layer || (layer === best.layer && z > best.z)))))
      ) {
        best = { e, weight, confidence, layer, z };
      }
    }
    return best?.e;
  }

  /** `pick_objects`' confidence for part `part` of a drawn frame at point (x, y) of that frame. */
  private partConfidenceAt(part: FramePart, x: number, y: number): number {
    const { width, height } = part.texture.frame;
    const data = this.pixelsOf(part.texture);
    const pixels = data && { pixels: data.pixels, stride: data.width, width, height };
    // A mirrored part's column 0 is drawn at its right edge (`check_x = right - Xpos`).
    const px = part.flipped ? part.x + width - x : x - part.x;
    return partConfidence(pixels, width, height, px, y - part.y);
  }

  /** The object a work order can target (Gaia's or an own non-unit) picked at canvas point (x, y). */
  /**
   * The object under the pointer that shows the ring (`mcursors` facet 5) for a selection with an own priest
   * (`priestCursor`); undefined without one.
   */
  private priestTarget(x: number, y: number): Entity | undefined {
    const { world, player } = this.o;
    const own = this.selectedOwn().flatMap((id) => world.entities.get(id) ?? []);
    const priests = own.filter((e) => typeOf(world, e).group === GROUP_PRIEST);
    if (priests.length === 0) return undefined;
    const attributes = world.attributes[player]!;
    const sel: PriestSelection = {
      attack: own.some((e) => canAttack(typeOf(world, e))),
      faith: priests.some((e) => e.heldType === RESOURCE_FAITH && e.heldAmount >= FAITH_FULL),
      single: priests.length === 1 ? priests[0]!.id : -1,
      priestConversion: attributes[ATTR_PRIEST_CONVERSION] !== 0,
      buildingConversion: attributes[ATTR_BUILDING_CONVERSION] !== 0,
    };
    return this.topmostAt(
      x,
      y,
      (e) => {
        const t = typeOf(world, e);
        return priestCursor(sel, { id: e.id, type: t.id, group: t.group, hp: e.hp, maxHp: t.hitPoints, state: e.state }, this.stance(e.owner));
      },
      false,
    );
  }

  /** The own or ally transport under the pointer that shows the ring for a selection that can board (`boardCursor`). */
  private boardTarget(x: number, y: number): Entity | undefined {
    const { world } = this.o;
    if (!this.selectedOwn().some((id) => canBoard(typeOf(world, world.entities.get(id)!)))) return undefined;
    return this.topmostAt(
      x,
      y,
      (e) => {
        const t = typeOf(world, e);
        return boardCursor(true, { id: e.id, type: t.id, group: t.group, hp: e.hp, maxHp: t.hitPoints, state: e.state }, this.stance(e.owner));
      },
      false,
    );
  }

  /** `unitDiplomacy[owner]` of this player: 0 Gaia, 1 self, 2 ally, 3 neutral, 4 enemy. */
  private stance(owner: number): Stance {
    const stances = ['gaia', 'self', 'ally', 'neutral', 'enemy'] as const;
    return stances[unitDiplomacy(this.o.world, this.o.player, owner)] ?? 'enemy';
  }

  /**
   * The object under the pointer a selected unit's task list boards (an own or ally transport, Enter 3, naval.md §7.2) or
   * trades with (another player's Dock, Trade 111, support-actions.md §7): a right click's `work` order.
   */
  private taskTarget(x: number, y: number): Entity | undefined {
    const { world } = this.o;
    const units = this.orderedUnits().flatMap((id) => world.entities.get(id) ?? []);
    if (units.length === 0) return undefined;
    return this.topmostAt(x, y, (e) =>
      units.some((u) => {
        const action = targetActionType(world, u, e);
        return action === ACTION_ENTER || action === ACTION_TRADE;
      }),
    );
  }

  /** The object under the pointer a selected own priest's task list heals or converts (a right click's `work` order). */
  private priestOrderTarget(x: number, y: number): Entity | undefined {
    const { world } = this.o;
    const priests = this.orderedUnits().flatMap((id) => world.entities.get(id) ?? []).filter((e) => typeOf(world, e).group === GROUP_PRIEST);
    if (priests.length === 0) return undefined;
    return this.topmostAt(x, y, (e) => priests.some((p) => [ACTION_HEAL, ACTION_CONVERT].includes(targetActionType(world, p, e))), false);
  }

  private workTarget(x: number, y: number): Entity | undefined {
    if (!this.hasOwnSelection()) return undefined;
    return this.topmostAt(x, y, (e) => e.owner === 0 || (e.owner === this.o.player && !isUnit(e)));
  }

  /**
   * The selected own units an order goes to: `get_selected_objects_to_command` with the default select level 4
   * (src/player.cpp:1648, 1663-1664), so an own ruin (3) is never ordered while a relic (4) is (victory.md §10.2).
   */
  private orderedUnits(): number[] {
    return this.selectedOwn().filter((id) => {
      const e = this.o.world.entities.get(id)!;
      return isUnit(e) && this.selectLevel(e) >= SELECT_BOX;
    });
  }

  private selectedOwn(): number[] {
    return [...this.selected].filter((id) => this.o.world.entities.get(id)?.owner === this.o.player);
  }

  private hasOwnSelection(): boolean {
    return this.selectedOwn().some((id) => isUnit(this.o.world.entities.get(id)!));
  }

  /**
   * A right click on the minimap (`RGE_Diamond_Map_View::command_make_do` with no object): the selected own units walk to
   * map point (x, y). False when no own unit is selected.
   */
  moveSelectedTo(x: number, y: number): boolean {
    const units = this.orderedUnits();
    if (units.length === 0) return false;
    this.flashes.clear();
    this.o.issue({ type: 'move', units, x, y });
    return true;
  }

  /**
   * Right click: the selected units attack the enemy object under the pointer, or work on the object there, or else walk
   * to the map point there.
   */
  private orderAt(x: number, y: number): void {
    const units = this.orderedUnits();
    if (units.length === 0) return;
    const { camera, ground } = this.o.view;
    const { col, row } = ground.pointAt(x + camera.x, y + camera.y);
    const { width, height } = this.o.world.map;
    if (col < 0 || row < 0 || col >= width || row >= height) return;
    // `command_make_do`: an order on an object flashes it (`display_object_selection(id, 1500, 2, 2)`, which ends the
    // other flashes); a move ends them (`reset_display_object_selection(2)`).
    this.flashes.clear();
    const enemy = this.attackTarget(x, y);
    // A priest's heal or convert target is a `work` order on it (support-actions.md §4.7), and so is a transport to board
    // or a Dock to trade with.
    const target = enemy ?? this.workTarget(x, y) ?? this.priestOrderTarget(x, y) ?? this.taskTarget(x, y);
    if (target) {
      this.flashes.set(target.id, performance.now());
      this.moveMarkers.clear();
    } else this.markAt(x, y, MOVE_INTERVAL_MS);
    if (enemy) return this.o.issue({ type: 'attack', units, target: enemy.id });
    if (target) this.o.issue({ type: 'work', units, target: target.id, x: col, y: row });
    else this.o.issue({ type: 'move', units, x: col, y: row });
  }

  /** `add_overlay_sprite(shapes[2], ...)` at canvas point (x, y): the red X of an order on open ground. */
  private markAt(x: number, y: number, interval: number): void {
    const { camera } = this.o.view;
    this.moveMarkers.add(x + camera.x, y + camera.y, interval, performance.now());
  }

  /** The red X markers showing, in canvas pixels with their frame, for the tests. */
  get markers(): { x: number; y: number; frame: number; shown: boolean }[] {
    const { camera } = this.o.view;
    return this.moveMarkers.list(performance.now()).map((m) => ({ ...m, x: m.x - camera.x, y: m.y - camera.y }));
  }
}
