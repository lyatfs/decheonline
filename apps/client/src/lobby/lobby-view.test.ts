import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { DEFAULT_GAME_SETTINGS, type ClientMessage, type ServerMessage } from '@aoe/protocol';
import { Session, type LobbyState } from './session';
import { LobbyView } from './lobby-view';
import { AiBot } from '../bot/ai-bot';
import * as linkModule from '../net/link';
import type { Link } from '../net/link';

interface MockElement {
  tagName: string;
  id: string;
  className: string;
  textContent: string;
  value: string;
  hidden: boolean;
  disabled: boolean;
  checked: boolean;
  selected: boolean;
  type: string;
  maxLength: number;
  ariaLabel: string;
  placeholder: string;
  autocomplete: string;
  role: string;
  scrollTop: number;
  scrollHeight: number;
  clientHeight: number;
  isConnected: boolean;
  style: { cssText: string; [k: string]: string };
  dataset: Record<string, string>;
  children: MockElement[];
  childElementCount: number;
  firstElementChild: MockElement | null;
  listeners: Map<string, ((ev: unknown) => void)[]>;
  append(...nodes: (MockElement | string)[]): void;
  replaceChildren(...nodes: (MockElement | string)[]): void;
  addEventListener(type: string, fn: (ev: unknown) => void): void;
  remove(): void;
  focus(): void;
  click(): void;
}

function makeElement(tagName: string): MockElement {
  const el: MockElement = {
    tagName: tagName.toUpperCase(),
    id: '',
    className: '',
    textContent: '',
    value: '',
    hidden: false,
    disabled: false,
    checked: false,
    selected: false,
    type: '',
    maxLength: 0,
    ariaLabel: '',
    placeholder: '',
    autocomplete: '',
    role: '',
    scrollTop: 0,
    scrollHeight: 0,
    clientHeight: 0,
    isConnected: true,
    style: { cssText: '' },
    dataset: {},
    children: [],
    get childElementCount() {
      return this.children.length;
    },
    get firstElementChild() {
      return this.children[0] ?? null;
    },
    listeners: new Map(),
    append(...nodes: (MockElement | string)[]) {
      for (const n of nodes) {
        if (typeof n !== 'string') this.children.push(n);
      }
    },
    replaceChildren(...nodes: (MockElement | string)[]) {
      this.children = [];
      this.append(...nodes);
    },
    addEventListener(type: string, fn: (ev: unknown) => void) {
      const list = this.listeners.get(type) ?? [];
      list.push(fn);
      this.listeners.set(type, list);
    },
    remove() {},
    focus() {},
    click() {
      for (const fn of this.listeners.get('click') ?? []) fn({});
    },
  };
  return el;
}

function findByTestId(root: MockElement, testid: string): MockElement | undefined {
  if (root.dataset.testid === testid) return root;
  for (const child of root.children) {
    const found = findByTestId(child, testid);
    if (found) return found;
  }
  return undefined;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

class FakeLink implements Link {
  sent: ClientMessage[] = [];
  private messageHandlers = new Set<(m: ServerMessage) => void>();
  private closeHandlers = new Set<() => void>();

  send(m: ClientMessage): void {
    this.sent.push(m);
  }

  onMessage(fn: (m: ServerMessage) => void): () => void {
    this.messageHandlers.add(fn);
    return () => this.messageHandlers.delete(fn);
  }

  onClose(fn: () => void): void {
    this.closeHandlers.add(fn);
  }

  close(): void {
    for (const fn of this.closeHandlers) fn();
  }

  receive(m: ServerMessage): void {
    for (const fn of this.messageHandlers) fn(m);
  }
}

function makeSession(initial?: Partial<LobbyState>) {
  const state: LobbyState = {
    phase: 'idle',
    code: '',
    you: -1,
    players: [],
    seats: [],
    capacity: 2,
    hostSlot: -1,
    versions: null,
    settings: DEFAULT_GAME_SETTINGS,
    error: null,
    ...initial,
  };
  const session = {
    state,
    onChange: (() => {}) as (state: LobbyState) => void,
    onStart: () => {},
    onChat: () => {},
    setVersions: vi.fn(),
    getLobbyState: () => session.state,
    create: vi.fn(),
    join: vi.fn(),
    setReady: vi.fn(),
    setSettings: vi.fn(),
    setCiv: vi.fn(),
    sendChat: vi.fn(),
    start: vi.fn(),
    leave: vi.fn(() => {
      session.state = {
        ...session.state,
        phase: 'idle',
        code: '',
        you: -1,
        players: [],
        seats: [],
        capacity: 2,
        hostSlot: -1,
        versions: null,
      };
      session.onChange(session.state);
    }),
  };
  return session as unknown as Session & {
    create: ReturnType<typeof vi.fn>;
    setReady: ReturnType<typeof vi.fn>;
    start: ReturnType<typeof vi.fn>;
    leave: ReturnType<typeof vi.fn>;
  };
}

describe('LobbyView & AiBot — Issue 3.6.5: Async AiBot.spawn Race & Lifecycle', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal('document', {
      activeElement: null,
      createElement: (tag: string) => makeElement(tag),
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  test('clicking single-player opens setup screen and repeated render() during pending AiBot.spawn spawns at most 1 AiBot', async () => {
    const d = deferred<AiBot>();
    const spawnSpy = vi.spyOn(AiBot, 'spawn').mockReturnValue(d.promise);
    const link = new FakeLink();
    const session = new Session(link);
    const view = new LobbyView(session);
    const root = view.root as unknown as MockElement;

    findByTestId(root, 'single-player')!.click();
    // Clicking single-player opens setup screen instead of immediately creating a room
    expect(link.sent).toHaveLength(0);
    expect(findByTestId(root, 'sp-setup')).toBeDefined();

    findByTestId(root, 'sp-start')!.click();
    expect(link.sent).toEqual([
      { t: 'create', name: 'Player', mode: 'single-player', difficulty: 'medium' },
    ]);

    link.receive({
      t: 'lobby',
      code: 'ABCD2',
      you: 0,
      players: [{ slot: 0, name: 'Player', civ: 1, ready: false }],
      settings: DEFAULT_GAME_SETTINGS,
      mode: 'single-player',
      difficulty: 'medium',
      botToken: 'tok-sp',
    });

    // Rapid repeated render calls while AiBot.spawn is still pending
    view.render(session.state);
    view.render(session.state);

    expect(spawnSpy).toHaveBeenCalledTimes(1);
    expect(spawnSpy).toHaveBeenCalledWith('ABCD2', {
      name: 'Computer (Medium)',
      civ: 2,
      difficulty: 'medium',
      botToken: 'tok-sp',
    });

    const mockBot = { destroy: vi.fn() } as unknown as AiBot;
    d.resolve(mockBot);
    await Promise.resolve();
    await Promise.resolve();

    expect(mockBot.destroy).not.toHaveBeenCalled();
  });

  test('add-bot-btn guards against double-click / concurrent spawn while pending in multiplayer', async () => {
    const d = deferred<AiBot>();
    const spawnSpy = vi.spyOn(AiBot, 'spawn').mockReturnValue(d.promise);
    const session = makeSession();
    const view = new LobbyView(session);
    const root = view.root as unknown as MockElement;

    const lobbyState: LobbyState = {
      phase: 'lobby',
      code: 'ROOM1',
      you: 0,
      players: [{ slot: 0, name: 'Host', civ: 1, ready: false }],
      seats: [
        { slot: 0, status: 'occupied', name: 'Host', civ: 1, ready: false },
        { slot: 1, status: 'open', name: null, civ: null, ready: false },
      ],
      capacity: 2,
      hostSlot: 0,
      versions: null,
      settings: DEFAULT_GAME_SETTINGS,
      mode: 'multiplayer',
      error: null,
    };
    session.state = lobbyState;
    view.render(lobbyState);

    const addBtn = findByTestId(root, 'add-bot-btn')!;
    expect(addBtn).toBeDefined();
    addBtn.click();
    addBtn.click();
    view.render(lobbyState);

    // Button is hidden on re-render while botSpawning is true, and spawn was called only once
    expect(spawnSpy).toHaveBeenCalledTimes(1);
    expect(findByTestId(root, 'add-bot-btn')).toBeUndefined();

    d.resolve({ destroy: vi.fn() } as unknown as AiBot);
    await Promise.resolve();
  });

  test('destroys late-resolved AiBot when user cancels while spawn is pending, and multiplayer afterward never auto-readies (U02, U04)', async () => {
    const d1 = deferred<AiBot>();
    const d2 = deferred<AiBot>();
    const spawnSpy = vi.spyOn(AiBot, 'spawn')
      .mockReturnValueOnce(d1.promise)
      .mockReturnValueOnce(d2.promise);

    const link = new FakeLink();
    const session = new Session(link);
    const view = new LobbyView(session);
    const root = view.root as unknown as MockElement;

    // Enter Single Player setup and start
    findByTestId(root, 'single-player')!.click();
    findByTestId(root, 'sp-start')!.click();
    link.receive({
      t: 'lobby',
      code: 'GAME1',
      you: 0,
      players: [{ slot: 0, name: 'Player', civ: 1, ready: false }],
      settings: DEFAULT_GAME_SETTINGS,
      mode: 'single-player',
      difficulty: 'medium',
      botToken: 'tok-g1',
    });
    expect(spawnSpy).toHaveBeenCalledTimes(1);

    // Cancel while AiBot.spawn is still pending
    findByTestId(root, 'sp-cancel')!.click();
    expect(link.sent.at(-1)).toEqual({ t: 'leave' });
    expect(findByTestId(root, 'sp-setup')).toBeUndefined();

    // Late resolution MUST immediately destroy the orphaned bot
    const lateBot = { destroy: vi.fn() } as unknown as AiBot;
    d1.resolve(lateBot);
    await Promise.resolve();
    await Promise.resolve();
    expect(lateBot.destroy).toHaveBeenCalledTimes(1);

    // Entering Multiplayer after Single-Player must NEVER auto-ready or auto-start (U04)
    const beforeMp = link.sent.length;
    findByTestId(root, 'create')!.click();
    link.receive({
      t: 'lobby',
      code: 'MP123',
      you: 0,
      players: [{ slot: 0, name: 'Player', civ: 1, ready: false }],
      settings: DEFAULT_GAME_SETTINGS,
      mode: 'multiplayer',
    });
    expect(link.sent.slice(beforeMp)).toEqual([{ t: 'create', name: 'Player' }]);
    expect(findByTestId(root, 'invite-code')).toBeDefined();
    expect(spawnSpy).toHaveBeenCalledTimes(1);
    findByTestId(root, 'leave')!.click();

    // Entering a new Single Player setup should cleanly allow spawning a fresh bot
    findByTestId(root, 'single-player')!.click();
    findByTestId(root, 'sp-start')!.click();
    link.receive({
      t: 'lobby',
      code: 'GAME2',
      you: 0,
      players: [{ slot: 0, name: 'Player', civ: 1, ready: false }],
      settings: DEFAULT_GAME_SETTINGS,
      mode: 'single-player',
      difficulty: 'medium',
      botToken: 'tok-g2',
    });
    expect(spawnSpy).toHaveBeenCalledTimes(2);

    const bot2 = { destroy: vi.fn() } as unknown as AiBot;
    d2.resolve(bot2);
    await Promise.resolve();
    await Promise.resolve();

    // Transitioning to 'ended' destroys bot2 and does not call start()
    const beforeEnd = link.sent.length;
    session.finish();
    expect(link.sent.slice(beforeEnd).some((m) => m.t === 'start')).toBe(false);
    expect(bot2.destroy).toHaveBeenCalledTimes(1);
  });

  test('AiBot.connect() closes link and skips join if destroyed before connect resolves', async () => {
    const conn = deferred<Link>();
    vi.spyOn(linkModule, 'connect').mockReturnValue(conn.promise);

    const bot = new AiBot('CODE9', { name: 'Bot', civ: 2, botToken: 'tok-9' });
    const connecting = bot.connect();
    bot.destroy();

    const fakeLink: Link = {
      send: vi.fn(),
      onMessage: vi.fn(() => () => {}),
      onClose: vi.fn(),
      close: vi.fn(),
    };
    conn.resolve(fakeLink);
    await connecting;

    expect(fakeLink.close).toHaveBeenCalledTimes(1);
    expect(fakeLink.send).not.toHaveBeenCalled();
  });
});
