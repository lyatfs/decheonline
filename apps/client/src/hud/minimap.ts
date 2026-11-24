// The minimap in the bottom panel, as RGE_Diamond_Map draws it (src/diam_map.cpp) with the two-button mouse of
// RGE_Diamond_Map_View (src/vw_dimap.cpp). docs/spec/hud.md "Minimap".
import { TILE_BLACK, TILE_FOGGED, TILE_VISIBLE, typeOf, type Entity, type World } from '@aoe/sim';
import type { AssetProvider, MapArt } from '../assets';
import { tileShade, tileType } from '../map/elevation';
import type { MapView } from '../map/map-view';
import type { Doppelganger } from '../units/fog-objects';
import { minimapGeometry, objectPoint, pickTile, plainMinimapShape, tileRect, viewRect, type MinimapGeometry } from './minimap-geometry';

/** Palette indices the minimap draws in: `this->color` (0) inside the lines, 0xFF the frame, selection and Gaia. */
const BACKGROUND = 0;
const WHITE = 0xff;
/** `TRIBE_Diamond_Map_View::draw_object`: own objects under attack flash palette 0x56 and 0xFF, swapping every 333 ms. */
const FLASH = 0x56;
const FLASH_MS = 0x14d;
/** `map_draw_level` 4: the object colours its tile and the 8 around it in the terrain picture (`draw_tile`). */
const LEVEL_TILE = 4;
/** `RGE_View::max_col_num`, `max_row_num`: the main view's size in tiles of 64 x 32 pixels. */
const TILE_W = 64;
const TILE_H = 32;

/** Without a pack: a few plain colours for the indices above, terrain and players. */
const FALLBACK: Record<number, number> = { [BACKGROUND]: 0x000000, [WHITE]: 0xffffff, [FLASH]: 0xff0000 };
const FALLBACK_TERRAIN = 0x3c6428;
const FALLBACK_PLAYERS = [0x0000ff, 0xff0000, 0xffff00, 0x8c4a21, 0xff8000, 0x00ff00, 0x808080, 0x00ffff];

/** What the minimap needs of the map view's unit layer. */
export interface MinimapUnits {
  readonly selected: ReadonlySet<number>;
  readonly doppelgangers: { readonly copies: ReadonlyMap<number, Doppelganger> };
  /** Order the selected own units to walk to map point (x, y); false when none is selected. */
  moveSelectedTo(x: number, y: number): boolean;
}

export interface MinimapOptions {
  /** The minimap's frame in the bottom panel. */
  parent: HTMLElement;
  world: World;
  provider: AssetProvider;
  player: number;
  view: MapView;
  units: MinimapUnits;
}

/**
 * The minimap: explored tiles in their terrain's colour (map.bmp's lines give the shape), objects as dots in their
 * owner's colour, the selection white, the frame of the main view, a left press (and drag) moves the view there and a
 * right click sends the selected units there.
 */
export class Minimap {
  readonly canvas = document.createElement('canvas');
  private readonly g: CanvasRenderingContext2D;
  private readonly geometry: MinimapGeometry;
  private readonly art: MapArt | null;
  /** The terrain picture (`save_area`): background inside the lines, explored tiles drawn once (`draw_explored_tiles`). */
  private readonly terrain: Uint32Array;
  private readonly explored: Uint8Array;
  /** The terrain picture with the objects over it, redrawn when the world or the selection changes. */
  private readonly picture: Uint32Array;
  private readonly image: ImageData;
  /** The image: the picture with the view's frame over it. */
  private readonly pixels: Uint32Array;
  /** What the canvas shows: only the pixels that differ from it are put on it again. */
  private readonly shown: Uint32Array;
  /** The objects drawn into the picture: per dot its tile's column and row, size and colour, in draw order. */
  private dots: number[] = [];
  /** `MapView.exploredVersion` when the explored tiles were last looked for. */
  private exploredAt = '';
  private scrolling = false;
  private drawnKey = '';
  private framedAt = '';
  private flashOn = false;
  private lastFlash = 0;
  private readonly cleanup: (() => void)[] = [];

  constructor(private readonly o: MinimapOptions) {
    const { world } = o;
    this.art = o.provider.mapArt();
    const shape = this.art?.minimap ?? plainMinimapShape();
    this.geometry = minimapGeometry(shape, world.map.width, world.map.height);
    this.canvas.width = shape.width;
    this.canvas.height = shape.height;
    this.canvas.className = 'hud-minimap-canvas';
    this.canvas.dataset.testid = 'minimap-canvas';
    o.parent.append(this.canvas);
    this.g = this.canvas.getContext('2d')!;
    this.image = this.g.createImageData(shape.width, shape.height);
    this.pixels = new Uint32Array(this.image.data.buffer);
    this.picture = new Uint32Array(shape.width * shape.height);
    this.shown = new Uint32Array(shape.width * shape.height);
    this.terrain = new Uint32Array(shape.width * shape.height);
    this.explored = new Uint8Array(world.map.width * world.map.height);
    // `clear_image`: the lines in the panel's colour; outside them the panel's art shows.
    const background = this.rgba(this.index(BACKGROUND));
    shape.lines.forEach(([start, len], i) => this.terrain.fill(background, (shape.startY + i) * shape.width + start, (shape.startY + i) * shape.width + start + len));
    this.listen();
  }

  destroy(): void {
    for (const fn of this.cleanup) fn();
    this.canvas.remove();
  }

  /** The picture point where tile (col, row)'s objects are drawn (`draw_object`). */
  tilePoint(col: number, row: number): { x: number; y: number } {
    return objectPoint(this.geometry, col, row);
  }

  /**
   * Redraw when the world, the view, the selection or the flash changed since the last call (`RGE_Diamond_Map::draw`):
   * the picture only when a tile was explored or a dot moved, appeared, went or changed colour, and on the canvas only
   * the pixels that changed (a view move changes its frame's).
   */
  update(now = performance.now()): void {
    const { world, view, units } = this.o;
    // `TRIBE_Diamond_Map_View::draw_objects`.
    if (now - this.lastFlash >= FLASH_MS) {
      this.flashOn = !this.flashOn;
      this.lastFlash = now;
    }
    const explored = view.exploredVersion();
    const key = `${world.turn}:${world.turnStep}:${explored}:${this.flashOn}:${[...units.selected].join()}`;
    const framedAt = `${view.camera.x}:${view.camera.y}`;
    if (key === this.drawnKey && framedAt === this.framedAt) return;
    let redrawn = false;
    if (key !== this.drawnKey) {
      this.drawnKey = key;
      const fresh = explored !== this.exploredAt && this.exploreTiles();
      this.exploredAt = explored;
      const dots = this.collectDots();
      if (fresh || !sameDots(dots, this.dots)) {
        this.dots = dots;
        this.picture.set(this.terrain);
        this.drawDots();
        redrawn = true;
      }
    }
    if (!redrawn && framedAt === this.framedAt) return;
    this.framedAt = framedAt;
    this.pixels.set(this.picture);
    this.drawViewRect();
    this.repaint();
  }

  /** Puts the box of the pixels that differ from what the canvas shows on it (`putImageData`'s dirty rectangle). */
  private repaint(): void {
    const w = this.canvas.width;
    let [x0, y0, x1, y1] = [w, this.canvas.height, -1, -1];
    for (let i = 0; i < this.pixels.length; i++) {
      if (this.pixels[i] === this.shown[i]) continue;
      const x = i % w;
      const y = (i - x) / w;
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      y1 = y;
    }
    if (x1 < 0) return;
    this.shown.set(this.pixels);
    this.g.putImageData(this.image, 0, 0, x0, y0, x1 - x0 + 1, y1 - y0 + 1);
  }

  /** What the player knows of tile (col, row) as drawn: the map view's, under the map's flags (REVEAL MAP, NO FOG). */
  private visibility(col: number, row: number): number {
    return this.o.view.fogState(col, row);
  }

  /** `draw_explored_tiles`: a tile is drawn the first time the player has it explored; true when one was. */
  private exploreTiles(): boolean {
    const { world } = this.o;
    const { width, height } = world.map;
    const fresh: number[] = [];
    for (let row = 0; row < height; row++) {
      for (let col = 0; col < width; col++) {
        const i = row * width + col;
        if (this.explored[i] || this.visibility(col, row) === TILE_BLACK) continue;
        this.explored[i] = 1;
        fresh.push(i);
      }
    }
    if (fresh.length === 0) return false;
    // The `map_draw_level` 4 objects' colour by tile they are on or next to, the last object winning, as a scan of
    // every object per tile finds it (a random map has thousands of objects).
    const tileColours = new Map<number, number>();
    for (const e of world.entities.all()) {
      const m = this.art?.unitMinimap(e.type);
      if (m?.[0] !== LEVEL_TILE) continue;
      const ex = Math.floor(e.x);
      const ey = Math.floor(e.y);
      for (let row = ey - 1; row <= ey + 1; row++) {
        for (let col = ex - 1; col <= ex + 1; col++) if (col >= 0 && row >= 0 && col < width && row < height) tileColours.set(row * width + col, m[1]);
      }
    }
    for (const i of fresh) this.drawTile(i % width, Math.trunc(i / width), tileColours.get(i));
    return true;
  }

  /**
   * `draw_tile` (src/diam_map.cpp:459): the terrain's `map_med_color` on a flat tile, `map_hi_color` or `map_low_color`
   * on a slope by its `tile_type` (`tileShade`), or the `map_color` of a `map_draw_level` 4 object on it or next to it.
   */
  private drawTile(col: number, row: number, objectColour: number | undefined): void {
    const r = tileRect(this.geometry, col, row);
    if (!r) return;
    const { world } = this.o;
    const shade = 1 - tileShade(tileType(world.map, col, row));
    let colour = this.art ? this.index(this.art.terrainColours(world.map.terrainAt(col, row))?.[shade] ?? BACKGROUND) : FALLBACK_TERRAIN;
    if (objectColour !== undefined) colour = this.index(objectColour);
    const rgba = this.rgba(colour);
    const w = this.canvas.width;
    for (let y = r.y; y < r.y + r.h; y++) for (let x = r.x; x < r.x + r.w; x++) if (x < w && y < this.canvas.height) this.terrain[y * w + x] = rgba;
  }

  /**
   * `draw_objects` (src/diam_map.cpp:634): Gaia's objects, then each player's doppelgangers and unselected objects in its
   * colour, then the selection in white, then the player's own objects under attack, flashing.
   */
  private collectDots(): number[] {
    const { world, player, units } = this.o;
    const dots: number[] = [];
    // One walk over the objects, skipping those no dot is drawn for (trees colour their tiles instead), in draw order.
    const owned: Entity[][] = Array.from({ length: world.players }, () => []);
    const flashing: Entity[] = [];
    for (const e of world.entities.all()) {
      if (!e.sprite || !this.dotted(e)) continue;
      if (e.owner === 0) this.drawVisible(dots, e, WHITE, WHITE);
      if (e.owner === player && e.ai?.underAttack) flashing.push(e);
      else if (e.owner !== 0 && !units.selected.has(e.id)) owned[e.owner]?.push(e);
    }
    for (let p = 1; p < world.players; p++) {
      const colour = this.playerColour(p);
      if (p === player) for (const c of units.doppelgangers.copies.values()) this.drawCopy(dots, c);
      for (const e of owned[p]!) this.drawVisible(dots, e, colour, colour);
    }
    for (const id of units.selected) {
      const e = world.entities.get(id);
      if (e?.sprite) this.drawVisible(dots, e, WHITE, WHITE);
    }
    const flash = this.flashOn ? FLASH : WHITE;
    for (const e of flashing) this.drawVisible(dots, e, flash, flash, true);
    return dots;
  }

  /** Whether `e`'s `map_draw_level` draws a dot (1 to 3). */
  private dotted(e: Entity): boolean {
    const level = (this.art?.unitMinimap(e.type) ?? fallbackLevel(e))[0];
    return level >= 1 && level <= 3;
  }

  private drawDots(): void {
    const { dots } = this;
    for (let i = 0; i < dots.length; i += 4) this.drawObject(dots[i]!, dots[i + 1]!, dots[i + 2]!, dots[i + 3] as 1 | 2);
  }

  /**
   * `draw_visible_object` (src/diam_map.cpp:702): on a visible tile, or on a fogged one when the master's `fog_flag` is
   * set; `map_draw_level` 1 a 3x3 square, 2 a plus, 3 a plus in the master's own `map_color`.
   */
  private drawVisible(dots: number[], e: Entity, colour1: number, colour2: number, flashing = false): void {
    // A passenger is off the map, inside its transport.
    if (e.inside !== undefined && e.inside !== null) return;
    const { world } = this.o;
    const col = Math.floor(e.x);
    const row = Math.floor(e.y);
    if (!world.map.inBounds(col, row)) return;
    const visible = this.visibility(col, row);
    if (visible !== TILE_VISIBLE && (visible !== TILE_FOGGED || typeOf(world, e).fogFlag === 0)) return;
    const [level, colour] = this.art?.unitMinimap(e.type) ?? fallbackLevel(e);
    if (level === 3 && !flashing) colour1 = colour;
    this.dotLevel(dots, col, row, level, colour1, colour2);
  }

  /** A doppelganger: only on a fogged tile, with the level and colour it copied (`RGE_Doppleganger_Object` setup). */
  private drawCopy(dots: number[], c: Doppelganger): void {
    const col = Math.floor(c.x);
    const row = Math.floor(c.y);
    if (this.visibility(col, row) !== TILE_FOGGED) return;
    const [level, colour] = this.art?.unitMinimap(c.type) ?? [0, 0];
    const own = level === 3 ? colour : c.owner > 0 ? this.playerColour(c.owner) : WHITE;
    this.dotLevel(dots, col, row, level, own, own);
  }

  private dotLevel(dots: number[], col: number, row: number, level: number, colour1: number, colour2: number): void {
    if (level === 1) dots.push(col, row, colour2, 1);
    else if (level === 2 || level === 3) dots.push(col, row, colour1, 2);
  }

  /** `draw_object` (src/diam_map.cpp:771): size 1 a 3x3 square, size 2 a plus, around the tile's picture point. */
  private drawObject(col: number, row: number, colour: number, size: 1 | 2): void {
    const p = objectPoint(this.geometry, col, row);
    const rgba = this.rgba(this.index(colour));
    const set = (x: number, y: number) => {
      if (x >= 0 && y >= 0 && x < this.canvas.width && y < this.canvas.height) this.picture[y * this.canvas.width + x] = rgba;
    };
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) if (size === 1 || dx === 0 || dy === 0) set(p.x + dx, p.y + dy);
    }
  }

  /** The main view's frame (`view_rect`) and the tile it is centred on: the view's centre point's, `view_x` and `view_y`. */
  viewFrame(): { col: number; row: number; left: number; top: number; right: number; bottom: number } | null {
    const { camera } = this.o.view;
    const centre = this.o.view.viewPoint();
    const [col, row] = [Math.trunc(centre.col), Math.trunc(centre.row)];
    const r = viewRect(this.geometry, col, row, Math.trunc(camera.viewW / TILE_W), Math.trunc(camera.viewH / TILE_H));
    return r && { col, row, ...r };
  }

  /** `draw_view_rect` (src/diam_map.cpp:826): the main view's frame, clipped to the lines, in white. */
  private drawViewRect(): void {
    const r = this.viewFrame();
    if (!r) return;
    const { shape } = this.geometry;
    const white = this.rgba(this.index(WHITE));
    for (let y = r.top; y <= r.bottom; y++) {
      const line = shape.lines[y - shape.startY];
      if (!line) continue;
      const [start, len] = line;
      const end = start + len;
      const set = (x: number) => (this.pixels[y * this.canvas.width + x] = white);
      if (y === r.top || y === r.bottom) {
        if (r.left < end && r.right >= start) for (let x = Math.max(r.left, start); x <= Math.min(r.right, end - 1); x++) set(x);
      } else {
        if (r.left >= start && r.left < end) set(r.left);
        if (r.right >= start && r.right < end) set(r.right);
      }
    }
  }

  private listen(): void {
    const on = <K extends keyof HTMLElementEventMap>(type: K, fn: (e: HTMLElementEventMap[K]) => void) => {
      this.canvas.addEventListener(type, fn);
      this.cleanup.push(() => this.canvas.removeEventListener(type, fn));
    };
    const tile = (e: MouseEvent) => {
      const r = this.canvas.getBoundingClientRect();
      const x = Math.floor(((e.clientX - r.left) * this.canvas.width) / r.width);
      const y = Math.floor(((e.clientY - r.top) * this.canvas.height) / r.height);
      return pickTile(this.geometry, x, y);
    };
    on('contextmenu', (e) => e.preventDefault());
    // `start_scroll_view`, `handle_scroll_view`: a left press on a tile centres the view on it, and so does dragging.
    on('pointerdown', (e) => {
      const t = tile(e);
      if (!t) return;
      if (e.button === 0) {
        this.scrolling = true;
        this.canvas.setPointerCapture?.(e.pointerId);
        this.lookAt(t.col, t.row);
      }
    });
    on('pointermove', (e) => {
      if (!this.scrolling) return;
      const t = tile(e);
      if (t) this.lookAt(t.col, t.row);
    });
    on('pointerup', (e) => {
      if (e.button === 0) {
        this.scrolling = false;
        return;
      }
      // `mouse_right_up_action` with `interface_style` 2: `command_make_do` at the tile's middle.
      const t = e.button === 2 ? tile(e) : null;
      if (t) this.o.units.moveSelectedTo(t.col + 0.5, t.row + 0.5);
    });
  }

  /** `set_view_loc(col + 0.5, row + 0.5)`. */
  private lookAt(col: number, row: number): void {
    this.o.view.lookAt(col + 0.5, row + 0.5);
  }

  private playerColour(player: number): number {
    if (player <= 0) return WHITE;
    const fromArt = this.art?.playerColour(player) ?? null;
    if (fromArt !== null) return fromArt;
    return FALLBACK_PLAYERS[(player - 1) % FALLBACK_PLAYERS.length]! | 0x1000000;
  }

  /**
   * The colour of palette index `i` as 0xRRGGBB. Without a pack the few indices above have plain colours; a value with
   * bit 24 set is already a colour.
   */
  private index(i: number): number {
    if (i & 0x1000000) return i & 0xffffff;
    if (this.art) return this.art.rgb(i);
    return FALLBACK[i] ?? FALLBACK_TERRAIN;
  }

  /** 0xRRGGBB as an opaque ImageData pixel (little-endian RGBA). */
  private rgba(rgb: number): number {
    return (0xff000000 | ((rgb & 0xff) << 16) | (rgb & 0xff00) | ((rgb >> 16) & 0xff)) >>> 0;
  }
}

function sameDots(a: readonly number[], b: readonly number[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/** Without a pack: units and buildings as their owner's dot, everything else not drawn. */
function fallbackLevel(e: Entity): [number, number] {
  return [e.owner > 0 ? 2 : 0, 0];
}
