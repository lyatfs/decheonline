import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type { Application } from 'pixi.js';
import { startingObjects, World, type Command } from '@aoe/sim';
import type { AssetProvider } from '../assets';
import { GameHud, type HudGame, type HudSelection } from './game-hud';

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
  min: string;
  max: string;
  step: string;
  maxLength: number;
  spellcheck: boolean;
  autocomplete: string;
  isContentEditable: boolean;
  style: { removeProperty: (name: string) => string; setProperty: (name: string, val: string) => void; [k: string]: unknown };
  dataset: Record<string, string>;
  children: MockEl[];
  parentElement: MockEl | null;
  firstElementChild: MockEl | null;
  classList: { add: (...c: string[]) => void; toggle: (c: string, force?: boolean) => void; contains: (c: string) => boolean };
  listeners: Map<string, ((ev: unknown) => void)[]>;
  append(...nodes: (MockEl | string)[]): void;
  addEventListener(type: string, fn: (ev: unknown) => void): void;
  removeEventListener(type: string, fn: (ev: unknown) => void): void;
  remove(): void;
  focus(): void;
  click(): void;
  dispatch(type: string): void;
  querySelector(sel: string): MockEl | null;
}

function makeEl(tag: string): MockEl {
  const classes = new Set<string>();
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
    textContent: '',
    value: '',
    hidden: false,
    disabled: false,
    checked: false,
    type: '',
    name: '',
    min: '',
    max: '',
    step: '',
    maxLength: 0,
    spellcheck: false,
    autocomplete: '',
    isContentEditable: false,
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
    remove() {},
    focus() {},
    click() {
      for (const fn of this.listeners.get('click') ?? []) fn({});
    },
    dispatch(type: string) {
      for (const fn of this.listeners.get(type) ?? []) fn({});
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

describe('HUD single-player vs multiplayer speed controls (S02, S03)', () => {
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
  });

  function dispatchKeydown(key: string, target: unknown = null) {
    const ev = {
      key,
      shiftKey: false,
      ctrlKey: false,
      altKey: false,
      metaKey: false,
      repeat: false,
      target,
      preventDefault: () => {},
      stopPropagation: () => {},
    };
    for (const fn of windowListeners.get('keydown') ?? []) fn(ev);
  }

  function createHud(singlePlayer: boolean, initialPaused = false) {
    const world = new World({ players: 3, units: startingObjects(3) });
    const issued: Command[] = [];
    const parent = makeEl('div');
    const provider = {
      culture: () => 0,
      string: () => null,
      interfaceFrame: () => null,
      unitInfo: () => null,
      soundTable: () => null,
      screen: () => null,
    } as unknown as AssetProvider;
    const app = {
      ticker: { add: () => {}, remove: () => {} },
    } as unknown as Application;
    const selection: HudSelection = {
      selected: new Set([1]),
      primary: 1,
      isGrouped: () => false,
      group: () => {},
      ungroup: () => {},
      unselect: () => {},
      commandObjects: () => [1],
      armCommand: () => {},
      commandMode: null,
      cancelCommand: () => {},
    };
    const game: HudGame = {
      names: ['', 'Human', 'Computer'],
      resign: () => {},
      disconnect: () => {},
      leave: () => {},
      dropped: () => false,
      onGameOver: () => {},
      reveal: () => {},
      sendChat: () => {},
      net: () => ({ rtt: [0, 0], frameMs: [0, 0] }),
      ...(singlePlayer
        ? {
            pause: {
              allowed: true,
              paused: initialPaused,
              toggle: () => true,
            },
          }
        : {}),
      singlePlayerSpeed: singlePlayer,
    };
    const hud = new GameHud({
      parent: parent as unknown as HTMLElement,
      app,
      world,
      provider,
      player: 1,
      selection,
      issue: (c) => issued.push(c),
      startPlacement: () => {},
      cancelPlacement: () => {},
      sounds: { volume: 0, button: () => {}, message: () => {}, chatLine: () => {}, gameOver: () => {} },
      game,
    });
    return { hud, world, issued, root: hud.root as unknown as MockEl };
  }

  test('S02: single-player OptionsDialog exposes [0.5, 4.0] step 0.25 slider/buttons, default 1.0, and commits on OK only', () => {
    const { hud, world, issued, root } = createHud(true);

    // Multiplayer radio buttons are absent in single-player
    expect(findByTestId(root, 'game-speed-1')).toBeUndefined();
    const control = findByTestId(root, 'sp-speed-control')!;
    const slider = findByTestId(root, 'sp-speed-slider')!;
    const dec = findByTestId(root, 'sp-speed-dec')!;
    const inc = findByTestId(root, 'sp-speed-inc')!;
    const value = findByTestId(root, 'sp-speed-value')!;
    expect(control).toBeDefined();
    expect([slider.min, slider.max, slider.step]).toEqual(['0.5', '4', '0.25']);

    hud.options!.show();
    expect(slider.value).toBe('1');
    expect(value.textContent).toBe('1.0x');

    // Step up twice (+0.25 each -> 1.5x) then Cancel -> no command issued
    inc.click();
    expect(value.textContent).toBe('1.25x');
    inc.click();
    expect(value.textContent).toBe('1.5x');
    findByTestId(root, 'options-cancel')!.click();
    expect(issued).toEqual([]);

    // Open again, move slider to 3.75, step up to 4.0 (clamped), OK -> issues 4.0
    hud.options!.show();
    expect(value.textContent).toBe('1.0x');
    slider.value = '3.75';
    slider.dispatch('input');
    expect(value.textContent).toBe('3.75x');
    inc.click();
    expect(value.textContent).toBe('4.0x');
    expect(inc.disabled).toBe(true);
    findByTestId(root, 'options-ok')!.click();
    expect(issued).toEqual([{ type: 'game-speed', speed: 4 }]);

    // Step down to 0.5 minimum clamp
    world.gameSpeed = 0.75;
    hud.options!.show();
    expect(value.textContent).toBe('0.75x');
    dec.click();
    expect(value.textContent).toBe('0.5x');
    expect(dec.disabled).toBe(true);
    findByTestId(root, 'options-ok')!.click();
    expect(issued.at(-1)).toEqual({ type: 'game-speed', speed: 0.5 });

    // Game over disables speed controls and prevents OK changes
    world.victory.gameState = 1;
    hud.gameOver.update();
    hud.options!.show();
    expect(slider.disabled).toBe(true);
    expect(dec.disabled).toBe(true);
    expect(inc.disabled).toBe(true);
    findByTestId(root, 'options-ok')!.click();
    expect(issued).toHaveLength(2);

    hud.destroy();
  });

  test('S02: multiplayer OptionsDialog preserves [1, 1.5, 2] radio buttons and omits single-player slider', () => {
    const { hud, issued, root } = createHud(false);
    expect(findByTestId(root, 'sp-speed-control')).toBeUndefined();
    const r1 = findByTestId(root, 'game-speed-1')!;
    const r15 = findByTestId(root, 'game-speed-1.5')!;
    const r2 = findByTestId(root, 'game-speed-2')!;
    expect([r1, r15, r2].every(Boolean)).toBe(true);

    hud.options!.show();
    expect(r1.checked).toBe(true);
    r1.checked = false;
    r2.checked = true;
    findByTestId(root, 'options-ok')!.click();
    expect(issued).toEqual([{ type: 'game-speed', speed: 2 }]);
    hud.destroy();
  });

  test('S03: an earlier speed applying does not overwrite a later speed still in the command delay', () => {
    const { hud, world, issued } = createHud(true);
    dispatchKeydown('+'); // turn 0 -> applies on turn 2
    world.addBatch(0, 1, issued.slice(0, 1));
    world.runTurn();
    dispatchKeydown('+'); // turn 1 -> applies on turn 3
    world.addBatch(1, 1, issued.slice(1, 2));
    world.runTurn();
    world.runTurn();
    expect(world.gameSpeed).toBe(1.25);

    dispatchKeydown('+');
    expect(issued).toEqual([
      { type: 'game-speed', speed: 1.25 },
      { type: 'game-speed', speed: 1.5 },
      { type: 'game-speed', speed: 1.75 },
    ]);
    hud.destroy();
  });

  test('S03: keyboard speed changes build on the last requested settings value while paused', () => {
    const { hud, issued, root } = createHud(true, true);
    hud.options!.show();
    const slider = findByTestId(root, 'sp-speed-slider')!;
    slider.value = '3';
    slider.dispatch('input');
    findByTestId(root, 'options-ok')!.click();
    dispatchKeydown('+');
    expect(issued).toEqual([
      { type: 'game-speed', speed: 3 },
      { type: 'game-speed', speed: 3.25 },
    ]);
    hud.destroy();
  });

  test('S02/S03: +/- keys step by 0.25 in [0.5, 4.0] in single-player (including while paused) and respect bounds/validation', () => {
    const sp = createHud(true, true);
    dispatchKeydown('+');
    dispatchKeydown('=');
    expect(sp.issued).toEqual([
      { type: 'game-speed', speed: 1.25 },
      { type: 'game-speed', speed: 1.5 },
    ]);

    sp.issued.length = 0;
    sp.world.gameSpeed = 0.75;
    dispatchKeydown('-');
    dispatchKeydown('-'); // clamped at 0.5, no duplicate command
    expect(sp.issued).toEqual([{ type: 'game-speed', speed: 0.5 }]);

    // Ignored inside text inputs
    dispatchKeydown('+', { tagName: 'INPUT', isContentEditable: false });
    dispatchKeydown('+', { tagName: 'DIV', isContentEditable: true });
    expect(sp.issued).toHaveLength(1);

    // Invalid speeds rejected at GameHud.changeGameSpeed boundary
    for (const bad of [0, -1, 0.25, 4.25, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      sp.hud.changeGameSpeed(bad);
    }
    expect(sp.issued).toHaveLength(1);
    sp.hud.destroy();

    // Multiplayer rejects single-player-only speeds in changeGameSpeed and keeps [1, 1.5, 2] ladder
    const mp = createHud(false);
    for (const nonMp of [0.5, 0.75, 1.25, 2.5, 4, 0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      mp.hud.changeGameSpeed(nonMp);
    }
    expect(mp.issued).toEqual([]);
    dispatchKeydown('+');
    expect(mp.issued).toEqual([{ type: 'game-speed', speed: 1.5 }]);
    mp.hud.destroy();
  });
});
