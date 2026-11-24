import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { Texture, type Application } from 'pixi.js';
import {
  CIV_EGYPTIAN,
  CIV_GAIA,
  CIV_GREEK,
  MARKET,
  RELATION_ALLY,
  STATUS_LOST,
  STATUS_WON,
  TILE_VISIBLE,
  TOWN_CENTER,
  VILLAGER,
  World,
  startingObjects,
  type Command,
} from '@aoe/sim';
import type { AssetProvider, ImageFrame, MapArt } from '../assets';
import { DebugProvider } from '../assets/debug-provider';
import type { MapView } from '../map/map-view';
import { AchievementsScreen } from './achievements';
import { ChatEntry } from './chat';
import { CommandPanel } from './command-panel';
import { DiplomacyDialog, diplomacyNotices } from './diplomacy';
import { GameHud, type HudGame, type HudSelection } from './game-hud';
import { ChatLines, GameOver } from './game-over';
import { Minimap, type MinimapUnits } from './minimap';
import { COLOURS, ICON_HIGH_LATENCY, ICON_LATENCY, ICON_SLOW, ScoreDisplay, colorref, netIcons, scoreLines } from './score-display';

// These tests inspect HUD ownership and DOM state; no browser raster decoding is needed.
vi.mock('./frame-image', async (importOriginal) => ({
  ...await importOriginal<typeof import('./frame-image')>(),
  frameDataUrl: async () => 'data:image/png;base64,',
}));

interface MockCanvasCtx {
  createImageData(w: number, h: number): ImageData;
  putImageData(img: ImageData, dx: number, dy: number): void;
  fillStyle: string;
  fillRect(): void;
  clearRect(): void;
  beginPath(): void;
  arc(): void;
  fill(): void;
  moveTo(): void;
  lineTo(): void;
  closePath(): void;
  lastImage: ImageData | null;
  fillStyles: string[];
}

interface MockEl {
  tagName: string;
  id: string;
  className: string;
  textContent: string;
  value: string;
  hidden: boolean;
  disabled: boolean;
  checked: boolean;
  type: string;
  name: string;
  width: number;
  height: number;
  min: string;
  max: string;
  step: string;
  tabIndex: number;
  maxLength: number;
  spellcheck: boolean;
  autocomplete: string;
  isContentEditable: boolean;
  isConnected: boolean;
  style: { removeProperty: (name: string) => string; setProperty: (name: string, val: string) => void; [k: string]: unknown };
  dataset: Record<string, string>;
  children: MockEl[];
  parentElement: MockEl | null;
  firstElementChild: MockEl | null;
  classList: { add: (...c: string[]) => void; toggle: (c: string, force?: boolean) => void; contains: (c: string) => boolean };
  listeners: Map<string, ((ev: unknown) => void)[]>;
  ctx: MockCanvasCtx | null;
  append(...nodes: (MockEl | string)[]): void;
  addEventListener(type: string, fn: (ev: unknown) => void): void;
  removeEventListener(type: string, fn: (ev: unknown) => void): void;
  getContext(kind: string): MockCanvasCtx | null;
  getBoundingClientRect(): { left: number; top: number; width: number; height: number };
  remove(): void;
  focus(): void;
  click(): void;
  dispatch(type: string, ev?: Record<string, unknown>): void;
  querySelector(sel: string): MockEl | null;
}

function makeCtx(): MockCanvasCtx {
  const ctx: MockCanvasCtx = {
    lastImage: null,
    fillStyles: [],
    set fillStyle(v: string) {
      this.fillStyles.push(v);
    },
    get fillStyle(): string {
      return this.fillStyles.at(-1) ?? '';
    },
    createImageData(w: number, h: number): ImageData {
      return { width: w, height: h, data: new Uint8ClampedArray(w * h * 4), colorSpace: 'srgb' } as ImageData;
    },
    putImageData(img: ImageData): void {
      this.lastImage = img;
    },
    fillRect() {},
    clearRect() {},
    beginPath() {},
    arc() {},
    fill() {},
    moveTo() {},
    lineTo() {},
    closePath() {},
  };
  return ctx;
}

function makeEl(tag: string): MockEl {
  const classes = new Set<string>();
  let content = '';
  const el: MockEl = {
    tagName: tag.toUpperCase(),
    id: '',
    get className() {
      return [...classes].join(' ');
    },
    set className(v: string) {
      classes.clear();
      for (const c of v.split(/\s+/).filter(Boolean)) classes.add(c);
    },
    get textContent() {
      return content + this.children.map((child) => child.textContent).join('');
    },
    set textContent(value: string) {
      content = value;
      this.children = [];
    },
    value: '',
    hidden: false,
    disabled: false,
    checked: false,
    type: '',
    name: '',
    width: 0,
    height: 0,
    min: '',
    max: '',
    step: '',
    tabIndex: 0,
    maxLength: 0,
    spellcheck: false,
    autocomplete: '',
    isContentEditable: false,
    isConnected: true,
    style: {
      removeProperty: () => '',
      setProperty: () => {},
    },
    dataset: {},
    children: [],
    parentElement: null,
    get firstElementChild() {
      return this.children[0] ?? null;
    },
    classList: {
      add: (...cs: string[]) => cs.forEach((c) => classes.add(c)),
      toggle: (c: string, force?: boolean) => {
        if (force === undefined ? !classes.has(c) : force) classes.add(c);
        else classes.delete(c);
      },
      contains: (c: string) => classes.has(c),
    },
    listeners: new Map(),
    ctx: tag.toLowerCase() === 'canvas' ? makeCtx() : null,
    append(...nodes: (MockEl | string)[]) {
      for (const n of nodes) {
        if (typeof n !== 'string') {
          n.parentElement = this;
          this.children.push(n);
        }
      }
    },
    addEventListener(type: string, fn: (ev: unknown) => void) {
      const list = this.listeners.get(type) ?? [];
      list.push(fn);
      this.listeners.set(type, list);
    },
    removeEventListener(type: string, fn: (ev: unknown) => void) {
      const list = this.listeners.get(type);
      if (!list) return;
      this.listeners.set(
        type,
        list.filter((f) => f !== fn),
      );
    },
    getContext(kind: string) {
      return kind === '2d' ? this.ctx : null;
    },
    getBoundingClientRect() {
      return { left: 0, top: 0, width: this.width || 640, height: this.height || 480 };
    },
    remove() {
      this.isConnected = false;
      if (this.parentElement) {
        this.parentElement.children = this.parentElement.children.filter((c) => c !== this);
        this.parentElement = null;
      }
    },
    focus() {},
    click() {
      for (const fn of this.listeners.get('click') ?? []) fn({});
    },
    dispatch(type: string, ev: Record<string, unknown> = {}) {
      for (const fn of this.listeners.get(type) ?? []) fn(ev);
    },
    querySelector(sel: string): MockEl | null {
      const cls = sel.startsWith('.') ? sel.slice(1) : '';
      for (const child of this.children) {
        if (cls && child.classList.contains(cls)) return child;
        const found = child.querySelector(sel);
        if (found) return found;
      }
      return null;
    },
  };
  return el;
}

function findByTestId(root: MockEl, testid: string): MockEl | undefined {
  if (root.dataset.testid === testid) return root;
  for (const child of root.children) {
    const found = findByTestId(child, testid);
    if (found) return found;
  }
  return undefined;
}

function findAllByTestId(root: MockEl, testid: string, out: MockEl[] = []): MockEl[] {
  if (root.dataset.testid === testid) out.push(root);
  for (const child of root.children) findAllByTestId(child, testid, out);
  return out;
}

const NAMES = ['', 'Alice', 'Bob', 'Carol', 'Dave'] as const;

const STRINGS: Record<number, string> = {
  3009: '%s paid %d gold in tribute to you.',
  3012: '%s disconnected.',
  3013: '%s resigned.',
  3014: '%s was defeated.',
  3016: '%s paid %d food in tribute to you.',
  3026: '%s changed diplomatic stance with you to Ally.',
  1217: 'Problem communicating with %s...',
  9004: 'You are victorious!',
  9005: 'You have been defeated!',
  10231: 'Egyptian',
  10232: 'Greek',
  10233: 'Babylonian',
  10234: 'Assyrian',
};

function makeProvider(options: { mapArt?: MapArt | null; onInterfaceFrame?: (slp: number, frame: number, owner?: number) => void } = {}): AssetProvider {
  return {
    kind: 'pack',
    culture: () => 0,
    string: (id: number) => STRINGS[id] ?? null,
    interfaceFrame: (slp: number, frame: number, owner?: number): ImageFrame | null => {
      options.onInterfaceFrame?.(slp, frame, owner);
      return { url: `/assets/sprites/interface/${slp}.o${owner ?? 1}.png`, x: 0, y: 0, w: 32, h: 32, hotspotX: 0, hotspotY: 0 };
    },
    unitInfo: (unitId: number) => ({
      icon: unitId === TOWN_CENTER ? 0 : 1,
      hitPoints: 100,
      button: 1,
      outline: [0.5, 0.5, 1],
      nameId: 0,
      creationId: 0,
      hotkeyId: 0,
      level: unitId === TOWN_CENTER ? 2 : 3,
      displayed: [3, 0, 0, 0],
      selectLevel: 4,
    }),
    techInfo: () => null,
    unitStandingGraphic: () => null,
    graphicInfo: () => null,
    graphicFrames: async () => [],
    terrainFrames: async () => [],
    mapArt: () => options.mapArt ?? null,
    terrainLayout: () => ({ rows: 1, cols: 1, tiles: [] }),
    terrainRules: () => null,
    border: () => null,
    borderFrames: async () => [],
    soundTable: () => null,
    screen: () => null,
  };
}

function makeWorld4(): World {
  return new World({
    players: 5,
    civs: [CIV_GAIA, CIV_EGYPTIAN, CIV_GREEK, 3, 4],
    units: startingObjects(5),
  });
}

function pixelRgba(img: ImageData, x: number, y: number): [number, number, number, number] {
  const idx = (y * img.width + x) * 4;
  return [img.data[idx]!, img.data[idx + 1]!, img.data[idx + 2]!, img.data[idx + 3]!];
}

describe('M08 multiplayer4 HUD (H01, H02, H03)', () => {
  const windowListeners = new Map<string, Set<(e: unknown) => void>>();

  beforeEach(() => {
    windowListeners.clear();
    vi.stubGlobal('document', {
      activeElement: null,
      createElement: (tag: string) => makeEl(tag),
    });
    vi.stubGlobal('window', {
      innerWidth: 1024,
      innerHeight: 768,
      addEventListener: (type: string, fn: (e: unknown) => void) => {
        let set = windowListeners.get(type);
        if (!set) {
          set = new Set();
          windowListeners.set(type, set);
        }
        set.add(fn);
      },
      removeEventListener: (type: string, fn: (e: unknown) => void) => {
        windowListeners.get(type)?.delete(fn);
      },
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  function makeHud(opts: {
    world?: World;
    player?: number;
    dropped?: (p: number) => boolean;
    net?: () => { rtt: readonly number[]; frameMs: readonly number[] };
    provider?: AssetProvider;
    selected?: number[];
    singlePlayerSpeed?: boolean;
  } = {}) {
    const world = opts.world ?? makeWorld4();
    const player = opts.player ?? 1;
    const issued: Command[] = [];
    const sentChats: Array<{ text: string; to: number[] }> = [];
    const parent = makeEl('div');
    const app = { ticker: { add: () => {}, remove: () => {} } } as unknown as Application;
    const selectedSet = new Set(opts.selected ?? []);
    const selection: HudSelection = {
      selected: selectedSet,
      primary: opts.selected?.[0] ?? null,
      isGrouped: () => false,
      group: () => {},
      ungroup: () => {},
      unselect: () => selectedSet.clear(),
      commandObjects: () => [...selectedSet],
      armCommand: () => {},
      commandMode: null,
      cancelCommand: () => {},
    };
    const game: HudGame = {
      names: NAMES,
      resign: () => issued.push({ type: 'resign' }),
      disconnect: () => {},
      leave: () => {},
      dropped: opts.dropped ?? (() => false),
      onGameOver: () => {},
      reveal: () => {},
      sendChat: (text, to) => sentChats.push({ text, to }),
      net: opts.net ?? (() => ({ rtt: [20, 40, 60, 80], frameMs: [16, 16, 16, 16] })),
      ...(opts.singlePlayerSpeed !== undefined ? { singlePlayerSpeed: opts.singlePlayerSpeed } : {}),
    };
    const hud = new GameHud({
      parent: parent as unknown as HTMLElement,
      app,
      world,
      provider: opts.provider ?? makeProvider(),
      player,
      selection,
      issue: (c) => issued.push(c),
      startPlacement: () => {},
      cancelPlacement: () => {},
      sounds: { volume: 0, button: () => {}, message: () => {}, chatLine: () => {}, gameOver: () => {} },
      game,
    });
    return { hud, world, issued, sentChats, root: hud.root as unknown as MockEl };
  }

  test('H01: Scoreboard displays all 4 players sorted with distinct colors and slot-indexed net icons', () => {
    const world = makeWorld4();
    world.victory.totals[1] = 120;
    world.victory.totals[2] = 350;
    world.victory.totals[3] = 240;
    world.victory.totals[4] = 410;

    const lines = scoreLines(world, NAMES);
    expect(lines).toEqual([
      { player: 4, text: 'Dave: 410/410', struck: false },
      { player: 2, text: 'Bob: 350/350', struck: false },
      { player: 3, text: 'Carol: 240/240', struck: false },
      { player: 1, text: 'Alice: 120/120', struck: false },
    ]);

    // Latency & slow icon mapping for 4 slots (me = player 2, rtt[0..3], frameMs[0..3])
    const icons = netIcons([4, 2, 3, 1], 2, [400, 150, 900, 160], [16, 16, 150, 16], () => true);
    expect(icons.get(2)).toEqual([0, 0]); // self stays 30 ms
    expect(icons.get(4)).toEqual([ICON_LATENCY, 0]); // 150 + 160 = 310 ms -> > 299
    expect(icons.get(1)).toEqual([ICON_LATENCY, 0]); // 150 + 400 = 550 ms
    expect(icons.get(3)).toEqual([ICON_HIGH_LATENCY, ICON_SLOW]); // 150 + 900 = 1050 ms & < 11 fps

    const view = makeEl('div');
    const display = new ScoreDisplay(view as unknown as HTMLElement, world, NAMES, {
      player: 2,
      status: () => ({ rtt: [400, 150, 900, 160], frameMs: [16, 16, 150, 16] }),
      dropped: () => false,
      icon: () => null,
    });
    display.toggle();
    expect(display.texts).toEqual(['Dave: 410/410', 'Bob: 350/350', 'Carol: 240/240', 'Alice: 120/120']);

    const visibleLines = findAllByTestId(view, 'score-line').filter((el) => !el.hidden);
    expect(visibleLines).toHaveLength(4);
    const colors = visibleLines.map((el) => String(el.style.color));
    expect(new Set(colors).size).toBe(4);
    expect(colors).toEqual([
      colorref(COLOURS[3]![0]),
      colorref(COLOURS[1]![0]),
      colorref(COLOURS[2]![0]),
      colorref(COLOURS[0]![0]),
    ]);
    display.destroy();
  });

  test('H01: Chat recipients list all 4 players with zero slot off-by-one and route messages accurately', () => {
    const world = makeWorld4();
    const { hud, sentChats, root } = makeHud({ world, player: 3 });

    // Open full Send Messages dialog as player 3 (slot 2)
    hud.commandChat(false);
    const names = findAllByTestId(root, 'chat-player-name').map((el) => el.textContent);
    expect(names).toEqual(['Alice', 'Bob', 'Carol', 'Dave']);

    // Checkboxes exist for players 1, 2, 4 (not self player 3)
    expect(findByTestId(root, 'chat-to-1')).toBeDefined();
    expect(findByTestId(root, 'chat-to-2')).toBeDefined();
    expect(findByTestId(root, 'chat-to-3')).toBeUndefined();
    expect(findByTestId(root, 'chat-to-4')).toBeDefined();

    // Uncheck player 2, keep 1 and 4
    findByTestId(root, 'chat-to-2')!.click();
    const input = findByTestId(root, 'chat-input')!;
    input.value = 'Attack player 2!';
    findByTestId(root, 'chat-return')!.click();

    expect(sentChats).toEqual([{ text: 'Attack player 2!', to: [1, 4] }]);
    hud.destroy();
  });

  test('H01: ChatEntry Allies / Enemies / Everyone buttons handle 4 players cleanly', () => {
    const parent = makeEl('div');
    const group = new Set([1, 2, 3, 4]);
    const sent: string[] = [];
    const entry = new ChatEntry({
      parent: parent as unknown as HTMLElement,
      provider: makeProvider(),
      group,
      players: () => [
        { player: 1, name: 'Alice', civ: 'Egyptian', out: false, checkable: false },
        { player: 2, name: 'Bob', civ: 'Greek', out: false, checkable: true },
        { player: 3, name: 'Carol', civ: 'Babylonian', out: false, checkable: true },
        { player: 4, name: 'Dave', civ: 'Assyrian', out: false, checkable: true },
      ],
      isAlly: (p) => p === 4,
      isEnemy: (p) => p === 2 || p === 3,
      send: (t) => sent.push(t),
      click: () => {},
    });
    entry.full();

    findByTestId(parent, 'chat-allies')!.click();
    expect([...group].sort()).toEqual([1, 4]);

    findByTestId(parent, 'chat-enemies')!.click();
    expect([...group].sort()).toEqual([1, 2, 3]);

    findByTestId(parent, 'chat-everyone')!.click();
    expect([...group].sort()).toEqual([1, 2, 3, 4]);
    entry.close();
  });

  test('H01: Diplomacy dialog supports 4 players, stances, tributes, and notifications for players 1..4', () => {
    const world = makeWorld4();
    // Give player 3 a Market and resources to test tribute from non-host slot
    world.createUnit({ owner: 3, type: MARKET, x: 14, y: 40 });
    world.attributes[3]![0] = 500; // food
    world.attributes[3]![3] = 500; // gold

    const issued: Command[] = [];
    const parent = makeEl('div');
    const dialog = new DiplomacyDialog({
      parent: parent as unknown as HTMLElement,
      provider: makeProvider(),
      world,
      player: 3,
      names: NAMES,
      out: () => false,
      gameOver: () => false,
      civ: (p) => ['', 'Egyptian', 'Greek', 'Babylonian', 'Assyrian'][p] ?? '',
      issue: (c) => issued.push(c),
      click: () => {},
    });
    dialog.show();

    const rowNames = findAllByTestId(parent, 'diplomacy-player-name').map((el) => el.textContent);
    expect(rowNames).toEqual(['Alice', 'Bob', 'Carol', 'Dave']);

    // Player 3 sets player 4 to Ally, player 1 to Neutral, and tributes 100 gold to player 4
    findByTestId(parent, 'diplomacy-ally-4')!.click();
    findByTestId(parent, 'diplomacy-neutral-1')!.click();
    findByTestId(parent, 'diplomacy-tribute-gold-4')!.click();
    findByTestId(parent, 'diplomacy-allied-victory')!.click();
    findByTestId(parent, 'diplomacy-ok')!.click();

    expect(issued).toContainEqual({ type: 'allied-victory', on: true });
    expect(issued).toContainEqual({ type: 'relation', player: 4, relation: RELATION_ALLY });
    expect(issued).toContainEqual({ type: 'relation', player: 1, relation: 1 });
    expect(issued).toContainEqual({ type: 'tribute', player: 4, resource: 3, amount: 100 });

    // Run commands in world and verify player 4 receives diplomacy & tribute notices
    world.addBatch(world.turn, 3, issued);
    for (let i = 0; i < 3; i++) world.runTurn();
    const noticesP4 = diplomacyNotices(world, 4, 0, makeProvider(), NAMES);
    expect(noticesP4.map((n) => n.text)).toEqual([
      'Carol changed diplomatic stance with you to Ally.',
      'Carol paid 100 gold in tribute to you.',
    ]);
    expect(diplomacyNotices(world, 2, 0, makeProvider(), NAMES)).toEqual([]);
  });

  test('H01: AchievementsScreen renders all 4 players with distinct colors and timeline entries', () => {
    const world = makeWorld4();
    world.victory.totals[1] = 100;
    world.victory.totals[2] = 200;
    world.victory.totals[3] = 300;
    world.victory.totals[4] = 400;
    world.victory.status[4] = STATUS_WON;
    world.log.history[1]!.population.push(5);
    world.log.history[2]!.population.push(6);
    world.log.history[3]!.population.push(7);
    world.log.history[4]!.population.push(8);

    const parent = makeEl('div');
    const screen = new AchievementsScreen({
      parent: parent as unknown as HTMLElement,
      provider: makeProvider(),
      world,
      player: 4,
      names: NAMES,
      end: true,
      click: () => {},
      onClose: () => {},
      onQuit: () => {},
    });

    const rowColors = [1, 2, 3, 4].map((p) => {
      const el = findByTestId(parent, `achievements-name-${p}`)!;
      expect(el.textContent).toBe(NAMES[p]);
      return String(el.style.color);
    });
    expect(new Set(rowColors).size).toBe(4);
    expect(findByTestId(parent, 'achievements-winner-4')).toBeDefined();

    screen.setMode(6); // Timeline mode
    const timelineNames = findAllByTestId(parent, 'timeline-name').map((el) => el.textContent);
    expect(timelineNames).toHaveLength(4);
    expect(timelineNames[2]).toContain('Carol');
    expect(timelineNames[3]).toContain('Dave');
    screen.close();
  });

  test('H02: Distinct owner colors for 0 (Gaia) and 1..4 on minimap, DebugProvider, and HUD icons without falling back to owner 0', async () => {
    // 1) Minimap without pack AND with partial 2-color pack: owners 1..4 must remain distinct and never fall back to Gaia (white)
    for (const partialPack of [false, true]) {
      const world = new World({ players: 5 });
      // Place 1 Gaia unit and 1 unit for each of owners 1..4 on distinct tiles
      const coords: Array<{ owner: number; x: number; y: number }> = [
        { owner: 0, x: 5.5, y: 5.5 },
        { owner: 1, x: 10.5, y: 10.5 },
        { owner: 2, x: 15.5, y: 15.5 },
        { owner: 3, x: 20.5, y: 20.5 },
        { owner: 4, x: 25.5, y: 25.5 },
      ];
      for (const c of coords) {
        const u = world.createUnit({ owner: c.owner, type: VILLAGER, x: c.x, y: c.y });
        u.sprite = { graphic: 0, frame: 0, lastFrame: 0, interval: 0, last: 0, changed: false, looped: false, flag: 0 };
      }

      const mapArt: MapArt | null = partialPack
        ? {
            rgb: (idx: number) => (idx === 24 ? 0x0000ff : idx === 223 ? 0xff0000 : idx === 0xff ? 0xffffff : 0x224422),
            terrainColours: () => [0, 0, 0],
            unitMinimap: () => [2, 0],
            doppelganger: () => 0,
            // Deliberately only provide colors for players 1..2 (like synthetic pack) to verify 3..4 fall back to distinct RGBs, NOT Gaia WHITE!
            playerColour: (p: number) => (p === 1 ? 24 : p === 2 ? 223 : null),
            minimap: null,
            tileEdges: null,
          }
        : null;

      const parent = makeEl('div');
      const view = {
        camera: { x: 0, y: 0, viewW: 800, viewH: 600 },
        fogState: () => TILE_VISIBLE,
        exploredVersion: () => 'v1',
        viewPoint: () => ({ col: 15, row: 15 }),
        lookAt: () => {},
      } as unknown as MapView;
      const units: MinimapUnits = {
        selected: new Set(),
        doppelgangers: { copies: new Map() },
        moveSelectedTo: () => false,
      };
      const minimap = new Minimap({
        parent: parent as unknown as HTMLElement,
        world,
        provider: makeProvider({ mapArt }),
        player: 1,
        view,
        units,
      });
      minimap.update(1000);
      const canvasEl = minimap.canvas as unknown as MockEl;
      const img = canvasEl.ctx!.lastImage!;
      expect(img).not.toBeNull();

      const sampled = coords.map((c) => {
        const pt = minimap.tilePoint(Math.floor(c.x), Math.floor(c.y));
        return pixelRgba(img, pt.x, pt.y).join(',');
      });
      // The debug minimap omits Gaia; a pack's drawable Gaia unit uses white.
      expect(sampled[0]).toBe(partialPack ? '255,255,255,255' : '60,100,40,255');
      expect(new Set(sampled.slice(1)).size).toBe(4);
      for (const rgb of sampled.slice(1)) expect(rgb).not.toBe('255,255,255,255');
      minimap.destroy();
    }

    // 2) DebugProvider draws distinct colors for 0 (Gaia) and 1..4 for units, buildings, and projectiles
    const filledByOwner = new Map<number, string>();
    const createdCtxs: MockCanvasCtx[] = [];
    const origCreate = (globalThis.document as unknown as { createElement: (tag: string) => MockEl }).createElement;
    vi.stubGlobal('document', {
      activeElement: null,
      createElement: (tag: string) => {
        const el = origCreate(tag);
        if (tag === 'canvas' && el.ctx) createdCtxs.push(el.ctx);
        return el;
      },
    });
    vi.stubGlobal('createImageBitmap', async () => ({ width: 20, height: 36 }));
    vi.spyOn(Texture, 'from').mockImplementation(() => Texture.EMPTY);

    const debug = new DebugProvider();
    await Promise.all(
      [0, 1, 2, 3, 4].map(async (owner) => {
        const before = createdCtxs.length;
        await debug.graphicFrames(9, owner); // projectile/unit graphic
        const ctx = createdCtxs[before]!;
        filledByOwner.set(owner, ctx.fillStyles[0]!);
      }),
    );
    // Distinct colors for 0 and 1..4
    expect(new Set(filledByOwner.values()).size).toBe(5);
    // Building graphic also preserves owner 1..4 distinct from 0
    const bBefore = createdCtxs.length;
    await debug.graphicFrames(12, 4);
    expect(createdCtxs[bBefore]!.fillStyles[0]).toBe(filledByOwner.get(4));

    // 3) GameHud object panel icon requests interfaceFrame with exact owner 1..4 and never passes 0 to slpImagePath
    const calls: Array<{ slp: number; owner: number | undefined }> = [];
    const world = makeWorld4();
    const gaiaEntity = world.createUnit({ owner: 0, type: VILLAGER, x: 5, y: 5 });
    const p4Entity = world.createUnit({ owner: 4, type: TOWN_CENTER, x: 20, y: 20 });
    const sel = new Set<number>([p4Entity.id]);
    const parent = makeEl('div');
    const app = { ticker: { add: () => {}, remove: () => {} } } as unknown as Application;
    let primaryId = p4Entity.id;
    const hud = new GameHud({
      parent: parent as unknown as HTMLElement,
      app,
      world,
      provider: makeProvider({
        onInterfaceFrame: (slp, _frame, owner) => {
          calls.push({ slp, owner });
        },
      }),
      player: 4,
      selection: {
        selected: sel,
        get primary() {
          return primaryId;
        },
        isGrouped: () => false,
        group: () => {},
        ungroup: () => {},
        unselect: () => {},
        commandObjects: () => [p4Entity.id],
        armCommand: () => {},
        commandMode: null,
        cancelCommand: () => {},
      },
      issue: () => {},
      startPlacement: () => {},
      cancelPlacement: () => {},
      game: {
        names: NAMES,
        resign: () => {},
        disconnect: () => {},
        leave: () => {},
        dropped: () => false,
        onGameOver: () => {},
        reveal: () => {},
        sendChat: () => {},
        net: () => ({ rtt: [0, 0, 0, 0], frameMs: [0, 0, 0, 0] }),
      },
    });
    // Owner 4 building icon call passed owner=4 (never 0)
    expect(calls.some((c) => c.owner === 4)).toBe(true);
    // Selecting Gaia entity never passes owner=0 to interfaceFrame
    calls.length = 0;
    sel.clear();
    sel.add(gaiaEntity.id);
    primaryId = gaiaEntity.id;
    (hud as unknown as { update: () => void }).update();
    expect(calls.every((c) => c.owner !== 0)).toBe(true);
    hud.destroy();
  });

  test('H02: CommandPanel passes active player (1..4) for unit and building icons', () => {
    const world = makeWorld4();
    const tc3 = [...world.entities.ofPlayer(3)].find((e) => e.type === TOWN_CENTER)!;
    const ownerCalls: number[] = [];
    const slots = Array.from({ length: 12 }, () => makeEl('div'));
    const message = makeEl('div');
    const panel = new CommandPanel({
      slots: slots as unknown as HTMLElement[],
      message: message as unknown as HTMLElement,
      world,
      provider: makeProvider({
        onInterfaceFrame: (_slp, _frame, owner) => {
          if (owner !== undefined) ownerCalls.push(owner);
        },
      }),
      player: 3,
      culture: 0,
      issue: () => {},
      startPlacement: () => {},
      cancelPlacement: () => {},
      unselect: () => {},
      group: () => {},
      ungroup: () => {},
    });
    panel.update(tc3, [tc3], false);
    expect(ownerCalls).toContain(3);
    expect(ownerCalls).not.toContain(0);
    panel.destroy();
  });

  test('H03: HUD handles dropped and resigned players cleanly without ending the game or changing colors/ownership', () => {
    const world = makeWorld4();
    const droppedSet = new Set<number>();
    const { hud, sentChats, root } = makeHud({
      world,
      player: 1,
      dropped: (p) => droppedSet.has(p),
      net: () => ({ rtt: [20, 900, 30, 40], frameMs: [16, 150, 16, 16] }),
    });

    // Capture player 4 unit ownership before drop/resign
    const p4UnitsBefore = [...world.entities.ofPlayer(4)].map((e) => e.id);
    expect(p4UnitsBefore.length).toBeGreaterThan(0);

    // 1) Player 2 drops (disconnected) while player 3 resigns voluntarily
    droppedSet.add(2);
    world.addBatch(world.turn, 2, [{ type: 'resign' }]);
    world.addBatch(world.turn, 3, [{ type: 'resign' }]);
    for (let i = 0; i < 3; i++) world.runTurn();

    expect(world.playerStatus(2)).toBe(STATUS_LOST);
    expect(world.playerStatus(3)).toBe(STATUS_LOST);
    expect(world.playerStatus(1)).toBe(0);
    expect(world.playerStatus(4)).toBe(0);
    expect(world.gameOver).toBe(false);

    // Update HUD: GameOver logs disconnected for player 2 and resigned for player 3, does NOT trigger local gameOver for player 1
    hud.gameOver.update(1000);
    expect(hud.gameOver.over).toBe(false);
    expect(hud.chat.texts).toContain('Bob disconnected.');
    expect(hud.chat.texts).toContain('Carol resigned.');

    // ScoreDisplay: toggle on, shows dropped/resigned struck out, keeps all 4 distinct player colors, drops slow/latency icons for player 2
    hud.scores.toggle();
    const scoreEls = findAllByTestId(root, 'score-line').filter((el) => !el.hidden);
    expect(scoreEls).toHaveLength(4);
    const struckTexts = scoreEls.filter((el) => el.className.includes('strikeout')).map((el) => el.textContent);
    expect(struckTexts.some((t) => t.startsWith('Bob:'))).toBe(true);
    expect(struckTexts.some((t) => t.startsWith('Carol:'))).toBe(true);
    expect(struckTexts.some((t) => t.startsWith('Alice:'))).toBe(false);
    expect(struckTexts.some((t) => t.startsWith('Dave:'))).toBe(false);

    // ScoreDisplay.update() immediately reflects a newly resigned player (player 4) even within 3s interval
    world.addBatch(world.turn, 4, [{ type: 'resign' }]);
    for (let i = 0; i < 3; i++) world.runTurn();
    hud.scores.update(500);
    const struckAfter = findAllByTestId(root, 'score-line')
      .filter((el) => !el.hidden && el.className.includes('strikeout'))
      .map((el) => el.textContent);
    expect(struckAfter.some((t) => t.startsWith('Dave:'))).toBe(true);

    // ChatEntry: dropped player 2 has no checkbox and is struck out; sendChat skips dropped player 2
    hud.commandChat(false);
    expect(findByTestId(root, 'chat-to-2')).toBeUndefined();
    expect(findByTestId(root, 'chat-to-3')).toBeDefined();
    const input = findByTestId(root, 'chat-input')!;
    input.value = 'Still fighting';
    findByTestId(root, 'chat-return')!.click();
    expect(sentChats).toEqual([{ text: 'Still fighting', to: [3, 4] }]);

    // DiplomacyDialog: dropped/resigned players are struck out and have no tribute buttons
    hud.diplomacy.show();
    const dipNames = findAllByTestId(root, 'diplomacy-player-name');
    expect(dipNames.filter((el) => el.className.includes('strikeout')).map((el) => el.textContent)).toEqual(['Bob', 'Carol', 'Dave']);
    expect(findByTestId(root, 'diplomacy-tribute-gold-2')).toBeUndefined();
    expect(findByTestId(root, 'diplomacy-tribute-gold-3')).toBeUndefined();
    hud.diplomacy.close();

    // notResponding() skips already-dropped player 2
    const chatCountBefore = hud.chat.texts.length;
    hud.notResponding();
    const addedNotices = hud.chat.texts.slice(chatCountBefore);
    expect(addedNotices.some((t) => t.includes('Bob'))).toBe(false);

    // Ownership of player 4 units was never mutated by HUD or drop/resign of other players
    expect([...world.entities.ofPlayer(4)].map((e) => e.id)).toEqual(p4UnitsBefore);
    hud.destroy();
  });

  test('H03: Host-role transfer (non-0 host playing multiplayer) keeps colors, player IDs, and multiplayer speed/pause rules', () => {
    const world = makeWorld4();
    // Simulate client at slot 1 (player 2) after hostSlot transferred to slot 1:
    // Multiplayer HUD must NOT gain single-player pause/speed, and player 2 keeps its own player ID & color.
    const { hud, root } = makeHud({ world, player: 2 });

    expect(findByTestId(root, 'sp-speed-control')).toBeUndefined();
    expect(findByTestId(root, 'game-speed-1')).toBeDefined();
    expect(findByTestId(root, 'pause-indicator')!.hidden).toBe(true);

    hud.scores.toggle();
    const p2Line = findAllByTestId(root, 'score-line').find((el) => !el.hidden && el.textContent.startsWith('Bob:'));
    expect(p2Line).toBeDefined();
    expect(p2Line!.style.color).toBe(colorref(COLOURS[1]![0]));

    // GameOver only triggers for this player if player 2 lost/resigned or world.gameOver
    const view = makeEl('div');
    const chat = new ChatLines(view as unknown as HTMLElement);
    const go = new GameOver({
      view: view as unknown as HTMLElement,
      provider: makeProvider(),
      world,
      player: 2,
      names: NAMES,
      sounds: null,
      chat,
      quit: () => false,
      dropped: (p) => p === 1, // former host (player 1 / slot 0) dropped
      onGameOver: () => {},
      reveal: () => {},
    });
    world.victory.resigned[1] = true;
    world.victory.status[1] = STATUS_LOST;
    go.update(1000);
    expect(go.over).toBe(false);
    expect(chat.texts).toEqual(['Alice disconnected.']);

    chat.destroy();
    hud.destroy();
  });
});
