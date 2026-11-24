import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import {
  DEFAULT_COMPATIBILITY_VERSIONS,
  DEFAULT_GAME_SETTINGS,
  type ClientMessage,
  type CompatibilityVersions,
  type RoomSeat,
  type ServerMessage,
} from '@aoe/protocol';
import { MAP_HILLY, MAP_SMALL } from '@aoe/sim';
import type { Link } from '../net/link';
import { AiBot } from '../bot/ai-bot';
import { LobbyView } from './lobby-view';
import { Session } from './session';

interface MockElement {
  tagName: string;
  id: string;
  className: string;
  textContent: string;
  value: string;
  readOnly: boolean;
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
  select(): void;
  click(): void;
  dispatch(type: string, ev?: unknown): void;
}

function makeElement(tagName: string): MockElement {
  let ownText = '';
  const el: MockElement = {
    tagName: tagName.toUpperCase(),
    id: '',
    className: '',
    get textContent() {
      if (this.children.length === 0) return ownText;
      return ownText + this.children.map((c) => c.textContent).join('');
    },
    set textContent(v: string) {
      ownText = v;
      this.children = [];
    },
    value: '',
    readOnly: false,
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
        if (typeof n === 'string') {
          ownText += n;
        } else {
          this.children.push(n);
        }
      }
    },
    replaceChildren(...nodes: (MockElement | string)[]) {
      ownText = '';
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
    select() {},
    click() {
      for (const fn of this.listeners.get('click') ?? []) fn({});
    },
    dispatch(type: string, ev: unknown = {}) {
      for (const fn of this.listeners.get(type) ?? []) fn(ev);
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

describe('LobbyView 4-seat multiplayer flows (M05 U01–U04)', () => {
  let activeElement: MockElement | null = null;

  beforeEach(() => {
    activeElement = null;
    vi.stubGlobal('document', {
      get activeElement() {
        return activeElement;
      },
      createElement: (tag: string) => makeElement(tag),
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  test('U01: capacity 2/4 selector creates 4-seat room, renders 4 color-badged seats, and requires all 4 ready to enable Start', () => {
    const link = new FakeLink();
    const session = new Session(link);
    const view = new LobbyView(session);
    const root = view.root as unknown as MockElement;

    const capacityEl = findByTestId(root, 'capacity')!;
    expect(capacityEl).toBeDefined();
    expect(capacityEl.value).toBe('2');

    const nameEl = findByTestId(root, 'name')!;
    nameEl.value = 'Alice';
    nameEl.dispatch('input');

    capacityEl.value = '4';
    capacityEl.dispatch('change');
    findByTestId(root, 'create')!.click();

    expect(link.sent[0]).toEqual({
      t: 'create',
      name: 'Alice',
      capacity: 4,
      versions: DEFAULT_COMPATIBILITY_VERSIONS,
    });

    // 1 occupied + 3 open seats
    const seats1: RoomSeat[] = [
      { slot: 0, status: 'occupied', name: 'Alice', civ: 1, ready: false },
      { slot: 1, status: 'open', name: null, civ: null, ready: false },
      { slot: 2, status: 'open', name: null, civ: null, ready: false },
      { slot: 3, status: 'open', name: null, civ: null, ready: false },
    ];
    link.receive({
      t: 'lobby',
      code: 'MP401',
      you: 0,
      capacity: 4,
      hostSlot: 0,
      seats: seats1,
      versions: DEFAULT_COMPATIBILITY_VERSIONS,
      players: [{ slot: 0, name: 'Alice', civ: 1, ready: false }],
      settings: DEFAULT_GAME_SETTINGS,
      mode: 'multiplayer',
    });

    const playersList = findByTestId(root, 'players')!;
    expect(playersList.children).toHaveLength(4);
    expect(findByTestId(root, 'player-0')).toBeDefined();
    expect(findByTestId(root, 'seat-1')).toBeDefined();
    expect(findByTestId(root, 'seat-2')).toBeDefined();
    expect(findByTestId(root, 'seat-3')).toBeDefined();
    expect(findByTestId(root, 'add-bot-btn')).toBeUndefined();

    // Player color badges P1..P4 are rendered on seats 0..3
    expect(findByTestId(root, 'seat-color-0')?.textContent).toBe('P1');
    expect(findByTestId(root, 'seat-color-1')?.textContent).toBe('P2');
    expect(findByTestId(root, 'seat-color-2')?.textContent).toBe('P3');
    expect(findByTestId(root, 'seat-color-3')?.textContent).toBe('P4');
    expect(findByTestId(root, 'host-badge-0')?.textContent).toContain('host');
    expect(findByTestId(root, 'start')?.disabled).toBe(true);

    // 3 players ready, 4th seat open -> Start MUST stay disabled
    link.receive({
      t: 'lobby',
      code: 'MP401',
      you: 0,
      capacity: 4,
      hostSlot: 0,
      seats: [
        { slot: 0, status: 'occupied', name: 'Alice', civ: 1, ready: true },
        { slot: 1, status: 'occupied', name: 'Bob', civ: 2, ready: true },
        { slot: 2, status: 'occupied', name: 'Carol', civ: 3, ready: true },
        { slot: 3, status: 'open', name: null, civ: null, ready: false },
      ],
      versions: DEFAULT_COMPATIBILITY_VERSIONS,
      players: [
        { slot: 0, name: 'Alice', civ: 1, ready: true },
        { slot: 1, name: 'Bob', civ: 2, ready: true },
        { slot: 2, name: 'Carol', civ: 3, ready: true },
      ],
      settings: DEFAULT_GAME_SETTINGS,
      mode: 'multiplayer',
    });
    expect(findByTestId(root, 'start')?.disabled).toBe(true);

    // 4th player joins unready -> Start still disabled
    link.receive({
      t: 'lobby',
      code: 'MP401',
      you: 0,
      capacity: 4,
      hostSlot: 0,
      seats: [
        { slot: 0, status: 'occupied', name: 'Alice', civ: 1, ready: false },
        { slot: 1, status: 'occupied', name: 'Bob', civ: 2, ready: false },
        { slot: 2, status: 'occupied', name: 'Carol', civ: 3, ready: false },
        { slot: 3, status: 'occupied', name: 'Dave', civ: 4, ready: false },
      ],
      versions: DEFAULT_COMPATIBILITY_VERSIONS,
      players: [
        { slot: 0, name: 'Alice', civ: 1, ready: false },
        { slot: 1, name: 'Bob', civ: 2, ready: false },
        { slot: 2, name: 'Carol', civ: 3, ready: false },
        { slot: 3, name: 'Dave', civ: 4, ready: false },
      ],
      settings: DEFAULT_GAME_SETTINGS,
      mode: 'multiplayer',
    });
    expect(findByTestId(root, 'start')?.disabled).toBe(true);
    expect(findByTestId(root, 'civ-0')?.tagName).toBe('SELECT');

    // All 4 occupied and ready -> Start enabled
    link.receive({
      t: 'lobby',
      code: 'MP401',
      you: 0,
      capacity: 4,
      hostSlot: 0,
      seats: [
        { slot: 0, status: 'occupied', name: 'Alice', civ: 1, ready: true },
        { slot: 1, status: 'occupied', name: 'Bob', civ: 2, ready: true },
        { slot: 2, status: 'occupied', name: 'Carol', civ: 3, ready: true },
        { slot: 3, status: 'occupied', name: 'Dave', civ: 4, ready: true },
      ],
      versions: DEFAULT_COMPATIBILITY_VERSIONS,
      players: [
        { slot: 0, name: 'Alice', civ: 1, ready: true },
        { slot: 1, name: 'Bob', civ: 2, ready: true },
        { slot: 2, name: 'Carol', civ: 3, ready: true },
        { slot: 3, name: 'Dave', civ: 4, ready: true },
      ],
      settings: DEFAULT_GAME_SETTINGS,
      mode: 'multiplayer',
    });
    expect(findByTestId(root, 'start')?.disabled).toBe(false);
    expect(findByTestId(root, 'civ-0')?.tagName).toBe('SPAN');
  });

  test('U02: membership/settings change clears ready, preserves chat across redraws, and maps version-mismatch/bad-result errors without clearing form', () => {
    const link = new FakeLink();
    const session = new Session(link);
    const view = new LobbyView(session);
    const root = view.root as unknown as MockElement;

    // Entry screen preserves form inputs on join error
    const nameEl = findByTestId(root, 'name')!;
    const codeEl = findByTestId(root, 'code')!;
    nameEl.value = 'Guest';
    nameEl.dispatch('input');
    codeEl.value = 'ROOM4';
    codeEl.dispatch('input');
    findByTestId(root, 'join')!.click();

    link.receive({ t: 'error', code: 'version-mismatch', message: 'raw mismatch' });
    expect(findByTestId(root, 'error')?.textContent).toContain('Version mismatch');
    expect(findByTestId(root, 'code')?.value).toBe('ROOM4');
    expect(findByTestId(root, 'name')?.value).toBe('Guest');

    link.receive({ t: 'error', code: 'bad-result', message: 'raw bad result' });
    expect(findByTestId(root, 'error')?.textContent).toContain('Invalid match result');

    // Join room as slot 1, ready up, send chat
    link.receive({
      t: 'lobby',
      code: 'ROOM4',
      you: 1,
      capacity: 4,
      hostSlot: 0,
      seats: [
        { slot: 0, status: 'occupied', name: 'Alice', civ: 1, ready: true },
        { slot: 1, status: 'occupied', name: 'Guest', civ: 2, ready: true },
        { slot: 2, status: 'open', name: null, civ: null, ready: false },
        { slot: 3, status: 'open', name: null, civ: null, ready: false },
      ],
      versions: DEFAULT_COMPATIBILITY_VERSIONS,
      players: [
        { slot: 0, name: 'Alice', civ: 1, ready: true },
        { slot: 1, name: 'Guest', civ: 2, ready: true },
      ],
      settings: DEFAULT_GAME_SETTINGS,
      mode: 'multiplayer',
    });

    const chatInput = findByTestId(root, 'lobby-chat-input')!;
    activeElement = chatInput;
    chatInput.value = 'hello team';
    chatInput.dispatch('keydown', { key: 'Enter' });
    expect(findByTestId(root, 'lobby-chat')?.children).toHaveLength(1);
    expect(findByTestId(root, 'civ-1')?.tagName).toBe('SPAN');

    // Server broadcasts updated settings and clears ready
    const nextSettings = { ...DEFAULT_GAME_SETTINGS, mapType: MAP_HILLY, mapSize: MAP_SMALL };
    link.receive({
      t: 'lobby',
      code: 'ROOM4',
      you: 1,
      capacity: 4,
      hostSlot: 0,
      seats: [
        { slot: 0, status: 'occupied', name: 'Alice', civ: 1, ready: false },
        { slot: 1, status: 'occupied', name: 'Guest', civ: 2, ready: false },
        { slot: 2, status: 'occupied', name: 'Carol', civ: 5, ready: false },
        { slot: 3, status: 'open', name: null, civ: null, ready: false },
      ],
      versions: DEFAULT_COMPATIBILITY_VERSIONS,
      players: [
        { slot: 0, name: 'Alice', civ: 1, ready: false },
        { slot: 1, name: 'Guest', civ: 2, ready: false },
        { slot: 2, name: 'Carol', civ: 5, ready: false },
      ],
      settings: nextSettings,
      mode: 'multiplayer',
    });

    // Ready cleared -> civ selector unlocked again, chat log preserved
    expect(findByTestId(root, 'civ-1')?.tagName).toBe('SELECT');
    expect(findByTestId(root, 'ready')?.textContent).toBe('Ready');
    expect(findByTestId(root, 'lobby-chat')?.children).toHaveLength(1);
    expect(findByTestId(root, 'settings-summary')?.textContent).toContain('Hill Country');
  });

  test('U03: host role transfer to non-0 hostSlot moves settings and start controls without altering slot identities or colors', () => {
    const link = new FakeLink();
    const session = new Session(link);
    const view = new LobbyView(session);
    const root = view.root as unknown as MockElement;

    // Client is slot 2, initially hostSlot is 0 -> slot 2 has NO start button and read-only settings
    link.receive({
      t: 'lobby',
      code: 'HOST2',
      you: 2,
      capacity: 4,
      hostSlot: 0,
      seats: [
        { slot: 0, status: 'occupied', name: 'Alice', civ: 1, ready: false },
        { slot: 1, status: 'away', name: 'Bob', civ: 3, ready: false },
        { slot: 2, status: 'occupied', name: 'Carol', civ: 7, ready: false },
        { slot: 3, status: 'resigned', name: 'Dave', civ: 9, ready: false },
      ],
      versions: DEFAULT_COMPATIBILITY_VERSIONS,
      players: [
        { slot: 0, name: 'Alice', civ: 1, ready: false },
        { slot: 2, name: 'Carol', civ: 7, ready: false },
      ],
      settings: DEFAULT_GAME_SETTINGS,
      mode: 'multiplayer',
    });

    expect(findByTestId(root, 'start')).toBeUndefined();
    expect(findByTestId(root, 'map-size')).toBeUndefined();
    expect(findByTestId(root, 'settings-summary')).toBeDefined();
    expect(findByTestId(root, 'host-badge-0')).toBeDefined();
    expect(findByTestId(root, 'host-badge-2')).toBeUndefined();
    expect(findByTestId(root, 'seat-status-1')?.textContent).toContain('away');
    expect(findByTestId(root, 'seat-status-3')?.textContent).toContain('resigned');

    // Host leaves slot 0; server transfers hostSlot to 2 while keeping Carol in slot 2 (P3)
    link.receive({
      t: 'lobby',
      code: 'HOST2',
      you: 2,
      capacity: 4,
      hostSlot: 2,
      seats: [
        { slot: 0, status: 'open', name: null, civ: null, ready: false },
        { slot: 1, status: 'dropped', name: 'Bob', civ: 3, ready: false },
        { slot: 2, status: 'occupied', name: 'Carol', civ: 7, ready: false },
        { slot: 3, status: 'open', name: null, civ: null, ready: false },
      ],
      versions: DEFAULT_COMPATIBILITY_VERSIONS,
      players: [{ slot: 2, name: 'Carol', civ: 7, ready: false }],
      settings: DEFAULT_GAME_SETTINGS,
      mode: 'multiplayer',
    });

    expect(findByTestId(root, 'start')).toBeDefined();
    expect(findByTestId(root, 'start')?.disabled).toBe(true);
    expect(findByTestId(root, 'map-size')).toBeDefined();
    expect(findByTestId(root, 'host-badge-2')).toBeDefined();
    expect(findByTestId(root, 'host-badge-0')).toBeUndefined();
    expect(findByTestId(root, 'seat-color-2')?.textContent).toBe('P3');
    expect(findByTestId(root, 'seat-status-1')?.textContent).toContain('dropped');
    expect(findByTestId(root, 'civ-2')?.value).toBe('7');
  });

  test('U04: switching from capacity-4 and single-player back to capacity-2 resets capacity, bot, ready, and autostart state; hooks integrate cleanly', async () => {
    const botMock = { destroy: vi.fn() } as unknown as AiBot;
    vi.spyOn(AiBot, 'spawn').mockResolvedValue(botMock);

    const customVersions: CompatibilityVersions = {
      protocol: 'mp4-v1',
      rules: 'sim-v1',
      build: 'prod-1',
      assets: 'pack-1',
    };
    const copyInvite = vi.fn().mockResolvedValue({ copied: true, method: 'clipboard' });
    const link = new FakeLink();
    const session = new Session(link);
    const view = new LobbyView(session, {
      initialRoomCode: 'INIT5',
      buildInviteUrl: (code) => `https://example.test/?room=${code}`,
      copyInvite,
      isLocalOrigin: (origin) => origin.includes('localhost'),
      versions: () => customVersions,
    });
    const root = view.root as unknown as MockElement;

    expect(findByTestId(root, 'code')?.value).toBe('INIT5');

    // Create capacity-4 room first
    const cap1 = findByTestId(root, 'capacity')!;
    cap1.value = '4';
    cap1.dispatch('change');
    findByTestId(root, 'create')!.click();
    expect(link.sent[0]).toEqual({
      t: 'create',
      name: 'Player',
      capacity: 4,
      versions: customVersions,
    });

    link.receive({
      t: 'lobby',
      code: 'MP400',
      you: 0,
      capacity: 4,
      hostSlot: 0,
      seats: [
        { slot: 0, status: 'occupied', name: 'Player', civ: 1, ready: true },
        { slot: 1, status: 'open', name: null, civ: null, ready: false },
        { slot: 2, status: 'open', name: null, civ: null, ready: false },
        { slot: 3, status: 'open', name: null, civ: null, ready: false },
      ],
      versions: customVersions,
      players: [{ slot: 0, name: 'Player', civ: 1, ready: true }],
      settings: DEFAULT_GAME_SETTINGS,
      mode: 'multiplayer',
    });

    // Invite link hook rendered and copy works
    expect(findByTestId(root, 'invite-url')?.value).toBe('https://example.test/?room=MP400');
    findByTestId(root, 'copy-invite')!.click();
    await Promise.resolve();
    expect(copyInvite).toHaveBeenCalledWith('https://example.test/?room=MP400');
    expect(findByTestId(root, 'copy-invite-status')?.hidden).toBe(false);

    // Leave capacity-4 room -> capacity selector resets to 2
    findByTestId(root, 'leave')!.click();
    expect(session.state.capacity).toBe(2);
    expect(session.state.hostSlot).toBe(-1);
    expect(session.state.seats).toEqual([]);
    expect(findByTestId(root, 'capacity')?.value).toBe('2');

    // Run single-player and cancel
    findByTestId(root, 'single-player')!.click();
    findByTestId(root, 'sp-start')!.click();
    link.receive({
      t: 'lobby',
      code: 'SP999',
      you: 0,
      capacity: 2,
      hostSlot: 0,
      seats: [
        { slot: 0, status: 'occupied', name: 'Player', civ: 1, ready: false },
        { slot: 1, status: 'open', name: null, civ: null, ready: false },
      ],
      versions: customVersions,
      players: [{ slot: 0, name: 'Player', civ: 1, ready: false }],
      settings: DEFAULT_GAME_SETTINGS,
      mode: 'single-player',
      difficulty: 'medium',
      botToken: 'tok-sp-999',
    });
    await Promise.resolve();
    findByTestId(root, 'sp-cancel')!.click();
    expect(botMock.destroy).toHaveBeenCalledTimes(1);

    // Create capacity-2 multiplayer room afterward -> no stale capacity=4, bot, ready, or start
    const sentBefore = link.sent.length;
    findByTestId(root, 'create')!.click();
    expect(link.sent.slice(sentBefore)).toEqual([
      { t: 'create', name: 'Player', capacity: 2, versions: customVersions },
    ]);
    link.receive({
      t: 'lobby',
      code: 'MP200',
      you: 0,
      capacity: 2,
      hostSlot: 0,
      seats: [
        { slot: 0, status: 'occupied', name: 'Player', civ: 1, ready: false },
        { slot: 1, status: 'open', name: null, civ: null, ready: false },
      ],
      versions: customVersions,
      players: [{ slot: 0, name: 'Player', civ: 1, ready: false }],
      settings: DEFAULT_GAME_SETTINGS,
      mode: 'multiplayer',
    });
    expect(findByTestId(root, 'players')?.children).toHaveLength(3); // 2 seats + add-bot-btn li
    expect(link.sent.slice(sentBefore).some((m) => m.t === 'ready' || m.t === 'start')).toBe(false);
  });
});
