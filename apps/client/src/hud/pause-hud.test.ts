import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type { Application } from 'pixi.js';
import { startingObjects, World } from '@aoe/sim';
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

describe('HUD F3 pause, input/modal guards & Options pause button (Q04, A04)', () => {
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

  function dispatchKeydown(opts: {
    key: string;
    shiftKey?: boolean;
    ctrlKey?: boolean;
    altKey?: boolean;
    metaKey?: boolean;
    repeat?: boolean;
    target?: unknown;
  }) {
    let defaultPrevented = false;
    const ev = {
      key: opts.key,
      shiftKey: opts.shiftKey ?? false,
      ctrlKey: opts.ctrlKey ?? false,
      altKey: opts.altKey ?? false,
      metaKey: opts.metaKey ?? false,
      repeat: opts.repeat ?? false,
      target: opts.target ?? null,
      preventDefault: () => {
        defaultPrevented = true;
      },
      stopPropagation: () => {},
    };
    for (const fn of windowListeners.get('keydown') ?? []) fn(ev);
    return { defaultPrevented };
  }

  function createHud(allowed: boolean, initialPaused = false) {
    const world = new World({ players: 3, units: startingObjects(3) });
    const issued: unknown[] = [];
    let paused = initialPaused;
    let onPauseChange: ((p: boolean) => void) | undefined;
    const toggleMock = vi.fn(() => {
      if (!allowed) return false;
      paused = !paused;
      onPauseChange?.(paused);
      return true;
    });
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
      pause: {
        get allowed() {
          return allowed;
        },
        get paused() {
          return paused;
        },
        toggle: toggleMock,
        onChange: (h) => {
          onPauseChange = h;
          return () => {
            onPauseChange = undefined;
          };
        },
      },
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
    return {
      hud,
      world,
      issued,
      toggleMock,
      root: hud.root as unknown as MockEl,
      setPaused: (p: boolean) => {
        paused = p;
        onPauseChange?.(p);
      },
    };
  }

  test('F3 toggles pause in single-player, shows PAUSED indicator, and Shift+F3 keeps formation(1)', () => {
    const { hud, issued, toggleMock, root } = createHud(true);
    const indicator = findByTestId(root, 'pause-indicator')!;
    expect(indicator).toBeDefined();
    expect(indicator.hidden).toBe(true);

    // Unmodified F3 toggles pause on
    const res1 = dispatchKeydown({ key: 'F3' });
    expect(res1.defaultPrevented).toBe(true);
    expect(toggleMock).toHaveBeenCalledTimes(1);
    expect(indicator.hidden).toBe(false);
    expect(indicator.textContent).toContain('PAUSED');

    // Repeated keydown, Ctrl+F3, Alt+F3, Meta+F3 do NOT toggle
    dispatchKeydown({ key: 'F3', repeat: true });
    dispatchKeydown({ key: 'F3', ctrlKey: true });
    dispatchKeydown({ key: 'F3', altKey: true });
    dispatchKeydown({ key: 'F3', metaKey: true });
    expect(toggleMock).toHaveBeenCalledTimes(1);

    // Unmodified F3 toggles pause off
    dispatchKeydown({ key: 'F3' });
    expect(toggleMock).toHaveBeenCalledTimes(2);
    expect(indicator.hidden).toBe(true);

    // Shift+F3 triggers formation(1), not pause
    dispatchKeydown({ key: 'F3', shiftKey: true });
    expect(toggleMock).toHaveBeenCalledTimes(2);
    expect(issued).toEqual([{ type: 'formation', units: [1], formation: 1 }]);

    hud.destroy();
  });

  test('A04/Q04: F3 is ignored in INPUT/TEXTAREA/SELECT, when modals are open, in multiplayer, and at game over', () => {
    const sp = createHud(true);

    for (const tagName of ['INPUT', 'TEXTAREA', 'SELECT']) {
      dispatchKeydown({ key: 'F3', target: { tagName, isContentEditable: false } });
    }
    dispatchKeydown({ key: 'F3', target: { tagName: 'DIV', isContentEditable: true } });
    expect(sp.toggleMock).not.toHaveBeenCalled();

    // Blocking modals: Options, ChatEntry, Menu, Diplomacy
    sp.hud.options!.show();
    dispatchKeydown({ key: 'F3' });
    expect(sp.toggleMock).not.toHaveBeenCalled();
    sp.hud.options!.close();

    sp.hud.chatEntry.quick();
    dispatchKeydown({ key: 'F3' });
    expect(sp.toggleMock).not.toHaveBeenCalled();
    sp.hud.chatEntry.close();

    sp.hud.menu.show();
    dispatchKeydown({ key: 'F3' });
    expect(sp.toggleMock).not.toHaveBeenCalled();
    sp.hud.menu.close();

    // Game over blocks F3
    sp.world.victory.gameState = 1;
    sp.hud.gameOver.update();
    dispatchKeydown({ key: 'F3' });
    expect(sp.toggleMock).not.toHaveBeenCalled();
    sp.hud.destroy();

    // Multiplayer blocks F3 and keeps indicator hidden
    const mp = createHud(false);
    dispatchKeydown({ key: 'F3' });
    expect(mp.toggleMock).not.toHaveBeenCalled();
    expect(findByTestId(mp.root, 'pause-indicator')!.hidden).toBe(true);
    mp.hud.destroy();
  });

  test('OptionsDialog exposes Pause/Resume button in single-player and hides/disables it in multiplayer', () => {
    const sp = createHud(true);
    sp.hud.options!.show();
    const spBtn = findByTestId(sp.root, 'options-pause')!;
    expect(spBtn).toBeDefined();
    expect(spBtn.hidden).toBe(false);
    expect(spBtn.disabled).toBe(false);
    spBtn.click();
    expect(sp.toggleMock).toHaveBeenCalledTimes(1);
    expect(sp.hud.options!.open).toBe(false);
    sp.hud.destroy();

    const mp = createHud(false);
    mp.hud.options!.show();
    const mpBtn = findByTestId(mp.root, 'options-pause')!;
    expect(mpBtn.hidden).toBe(true);
    expect(mpBtn.disabled).toBe(true);
    mp.hud.destroy();
  });
});
