import { afterEach, describe, expect, test, vi } from 'vitest';
import type { Application } from 'pixi.js';
import {
  DEFAULT_COMPATIBILITY_VERSIONS,
  DEFAULT_GAME_SETTINGS,
  type ClientMessage,
  type CompatibilityVersions,
  type MatchManifest,
  type ServerMessage,
} from '@aoe/protocol';
import { CIV_EGYPTIAN, CIV_RANDOM, MAP_HILLY, VICTORY_CONQUEST, resolveCivs } from '@aoe/sim';
import * as assetsModule from './assets';
import type { AssetProvider } from './assets';
import { Lockstep, type Timers } from './lockstep';
import { Session } from './lobby';
import { buildClientInviteHooks, readStartupInviteCode } from './main';
import { createLobbyDebug, resolveMatchStart, startMultiplayer } from './multiplayer';
import { relayUrl, type Link } from './net/link';
import { checkCompatibility, fetchServerVersions, getClientVersions, verifyVersionGate } from './net/version-gate';

class FakeLink implements Link {
  sent: ClientMessage[] = [];
  private readonly messageHandlers = new Set<(m: ServerMessage) => void>();
  private readonly closeHandlers = new Set<() => void>();

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
    for (const fn of [...this.messageHandlers]) fn(m);
  }
}

class FakeTimers implements Timers {
  clock = 0;
  due: { fn: () => void; at: number }[] = [];

  set(fn: () => void, ms: number): unknown {
    const timer = { fn, at: this.clock + ms };
    this.due.push(timer);
    return timer;
  }

  clear(handle: unknown): void {
    this.due = this.due.filter((t) => t !== handle);
  }

  next(): void {
    const timer = this.due.reduce((a, b) => (b.at < a.at ? b : a));
    this.due = this.due.filter((t) => t !== timer);
    this.clock = Math.max(this.clock, timer.at);
    timer.fn();
  }
}

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
  attributes: Record<string, string>;
  children: MockElement[];
  childElementCount: number;
  firstElementChild: MockElement | null;
  listeners: Map<string, ((ev: unknown) => void)[]>;
  append(...nodes: (MockElement | string)[]): void;
  replaceChildren(...nodes: (MockElement | string)[]): void;
  addEventListener(type: string, fn: (ev: unknown) => void): void;
  setAttribute(name: string, value: string): void;
  getAttribute(name: string): string | null;
  remove(): void;
  focus(): void;
  select(): void;
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
    attributes: {},
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
    setAttribute(name: string, value: string) {
      this.attributes[name] = value;
      if (name === 'role') this.role = value;
    },
    getAttribute(name: string) {
      return this.attributes[name] ?? null;
    },
    remove() {},
    focus() {},
    select() {},
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

function makeFourPlayerManifest(seed = 4242): MatchManifest {
  return {
    code: 'QUAD4',
    capacity: 4,
    mode: 'multiplayer',
    hostSlot: 2,
    players: [
      { slot: 0, playerId: 1, name: 'Alice', civ: 1 },
      { slot: 1, playerId: 2, name: 'Bob', civ: 5 },
      { slot: 2, playerId: 3, name: 'Carol', civ: 9 },
      { slot: 3, playerId: 4, name: 'Dave', civ: CIV_RANDOM },
    ],
    seed,
    settings: {
      ...DEFAULT_GAME_SETTINGS,
      mapType: MAP_HILLY,
      mapSize: 96,
      victory: { type: VICTORY_CONQUEST },
    },
    versions: { ...DEFAULT_COMPATIBILITY_VERSIONS },
  };
}

function installDomStubs(href = 'http://192.168.1.25:8787/'): {
  windowObj: Record<string, unknown>;
} {
  const url = new URL(href);
  const windowObj: Record<string, unknown> = {
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    location: {
      href: url.href,
      origin: url.origin,
      protocol: url.protocol,
      host: url.host,
      search: url.search,
    },
  };
  vi.stubGlobal('document', {
    activeElement: null,
    createElement: (tag: string) => makeElement(tag),
  });
  vi.stubGlobal('window', windowObj);
  return { windowObj };
}

function makeMockApp(): Application {
  return {
    ticker: {
      add: vi.fn(),
      remove: vi.fn(),
    },
    canvas: {
      parentElement: makeElement('div') as unknown as HTMLElement,
    },
  } as unknown as Application;
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('M10 Version Gate (V01)', () => {
  test('checkCompatibility reports structured per-field mismatch diagnostics for protocol, rules, build, assets', () => {
    const base = { ...DEFAULT_COMPATIBILITY_VERSIONS };
    const exact = checkCompatibility(base, { ...base });
    expect(exact.ok).toBe(true);
    expect(exact.mismatches).toEqual([]);
    expect(exact.message).toBeNull();
    expect(exact.protocol.match).toBe(true);
    expect(exact.rules.match).toBe(true);
    expect(exact.build.match).toBe(true);
    expect(exact.assets.match).toBe(true);

    const server: CompatibilityVersions = {
      protocol: 'mp4-v2',
      rules: 'sim-v1',
      build: 'prod-2026',
      assets: 'pack-hash-9',
    };
    const diff = checkCompatibility(base, server);
    expect(diff.ok).toBe(false);
    expect(diff.protocol).toEqual({ match: false, client: 'mp4-v1', server: 'mp4-v2' });
    expect(diff.rules).toEqual({ match: true, client: 'sim-v1', server: 'sim-v1' });
    expect(diff.build).toEqual({ match: false, client: 'development', server: 'prod-2026' });
    expect(diff.assets).toEqual({ match: false, client: 'development', server: 'pack-hash-9' });
    expect(diff.mismatches).toEqual([
      { field: 'protocol', client: 'mp4-v1', server: 'mp4-v2' },
      { field: 'build', client: 'development', server: 'prod-2026' },
      { field: 'assets', client: 'development', server: 'pack-hash-9' },
    ]);
    expect(diff.message).toContain('protocol');
    expect(diff.message).toContain('build');
    expect(diff.message).toContain('assets');
  });

  test('fetchServerVersions handles valid payloads, HTTP errors, network errors, and fallbackToDefault without bypassing explicit mismatch', async () => {
    const serverVersions: CompatibilityVersions = {
      protocol: 'mp4-v1',
      rules: 'sim-v2',
      build: 'prod-1',
      assets: 'assets-1',
    };
    const fetch200 = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify(serverVersions), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    const okRes = await fetchServerVersions('http://192.168.1.10:8787/', { fetchImpl: fetch200 });
    expect(fetch200).toHaveBeenCalledWith('http://192.168.1.10:8787/api/versions', expect.objectContaining({ method: 'GET' }));
    expect(okRes).toEqual({ ok: true, versions: serverVersions, source: 'server' });

    const fetch503 = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify({ status: 'not-ready', reasons: ['missing owner1.slp'] }), {
        status: 503,
        headers: { 'content-type': 'application/json' },
      }),
    );
    const err503 = await fetchServerVersions('', { fetchImpl: fetch503, fallbackToDefault: true });
    expect(err503.ok).toBe(false);
    if (!err503.ok) {
      expect(err503.kind).toBe('http');
      expect(err503.status).toBe(503);
      expect(err503.error).toContain('missing owner1.slp');
      expect(err503.retryable).toBe(true);
    }

    const fetch404 = vi.fn<typeof fetch>().mockResolvedValue(new Response('not found', { status: 404 }));
    const strict404 = await fetchServerVersions('', { fetchImpl: fetch404 });
    expect(strict404.ok).toBe(false);
    const fallback404 = await fetchServerVersions('', { fetchImpl: fetch404, fallbackToDefault: true });
    expect(fallback404).toEqual({ ok: true, versions: DEFAULT_COMPATIBILITY_VERSIONS, source: 'fallback' });

    const fetchDown = vi.fn<typeof fetch>().mockRejectedValue(new Error('ECONNREFUSED'));
    const strictDown = await fetchServerVersions('', { fetchImpl: fetchDown });
    expect(strictDown.ok).toBe(false);
    const fallbackDown = await fetchServerVersions('', { fetchImpl: fetchDown, fallbackToDefault: true });
    expect(fallbackDown).toEqual({ ok: true, versions: DEFAULT_COMPATIBILITY_VERSIONS, source: 'fallback' });

    // Even with fallbackToDefault: true, an explicit mismatched server payload MUST fail the gate!
    const gateMismatch = await verifyVersionGate({
      clientVersions: { ...DEFAULT_COMPATIBILITY_VERSIONS },
      fallbackToDefault: true,
      fetchImpl: fetch200,
    });
    expect(gateMismatch.ok).toBe(false);
    if (!gateMismatch.ok && gateMismatch.kind === 'mismatch') {
      expect(gateMismatch.diagnostics.rules).toEqual({ match: false, client: 'sim-v1', server: 'sim-v2' });
    }
  });

  test('getClientVersions reads VITE_* overrides when present and defaults safely otherwise', () => {
    expect(getClientVersions({})).toEqual(DEFAULT_COMPATIBILITY_VERSIONS);
    expect(
      getClientVersions({
        VITE_PROTOCOL_VERSION: 'mp4-v1',
        VITE_RULES_VERSION: 'sim-v1',
        VITE_BUILD_VERSION: 'build-99',
        VITE_ASSETS_VERSION: 'pack-99',
      }),
    ).toEqual({
      protocol: 'mp4-v1',
      rules: 'sim-v1',
      build: 'build-99',
      assets: 'pack-99',
    });
  });

  test('startMultiplayer blocks lobby on version mismatch and mounts lobby after Retry succeeds (V01)', async () => {
    installDomStubs('http://192.168.1.50:8787/?debug=net');
    vi.spyOn(assetsModule, 'createAssetProvider').mockResolvedValue({
      string: () => undefined,
      soundTable: () => null,
    } as unknown as AssetProvider);

    const host = makeElement('div');
    const link = new FakeLink();
    const connectLink = vi.fn(async () => link);
    let attempt = 0;
    const fetchImpl = vi.fn<typeof fetch>(async () => {
      attempt++;
      const versions: CompatibilityVersions =
        attempt === 1
          ? { ...DEFAULT_COMPATIBILITY_VERSIONS, rules: 'sim-v99' }
          : { ...DEFAULT_COMPATIBILITY_VERSIONS };
      return new Response(JSON.stringify(versions), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });

    await startMultiplayer(host as unknown as HTMLElement, makeMockApp(), {
      debug: true,
      speed: 1,
      connectLink,
      fetchImpl,
      setGameVisible: vi.fn(),
    });

    // Blocked before connecting or entering lobby on version mismatch.
    expect(connectLink).not.toHaveBeenCalled();
    expect(findByTestId(host, 'version-gate')).toBeDefined();
    expect(findByTestId(host, 'version-gate-error')?.textContent).toContain('rules');
    expect(findByTestId(host, 'version-gate-details')?.children.length).toBe(1);
    expect(findByTestId(host, 'lobby')).toBeUndefined();

    // Retry when server now matches.
    findByTestId(host, 'version-gate-retry')!.click();
    await vi.waitFor(() => expect(findByTestId(host, 'lobby')).toBeDefined());

    expect(connectLink).toHaveBeenCalledTimes(1);
    expect(findByTestId(host, 'version-gate')).toBeUndefined();
    expect(findByTestId(host, 'lobby')).toBeDefined();
  });
});

describe('M10 Manifest Initialization & Non-Compacted Arrays (N06, U05)', () => {
  test('resolveMatchStart builds LockstepStart and 1..capacity names from manifest without compacting after drop (N06)', () => {
    const manifest = makeFourPlayerManifest(8888);
    // Deliberately reverse player order in wire fixture to verify slot sorting.
    const shuffledManifest: MatchManifest = {
      ...manifest,
      players: [...manifest.players].reverse(),
    };
    const startMsg: ServerMessage = {
      t: 'start',
      seed: 1111, // manifest.seed (8888) takes precedence
      commandDelay: 2,
      capacity: 4,
      hostSlot: 2,
      manifest: shuffledManifest,
      versions: shuffledManifest.versions,
      players: shuffledManifest.players.map((p) => ({ slot: p.slot, name: p.name, ready: true, civ: p.civ })),
      settings: shuffledManifest.settings,
      token: 'secret-rejoin-tok',
      mode: 'multiplayer',
    };

    const resolved = resolveMatchStart(startMsg, 2, 'QUAD4');
    expect(resolved.lockstepStart).toEqual({
      seed: 8888,
      commandDelay: 2,
      playerCount: 4,
      mode: 'multiplayer',
      slot: 2,
      settings: shuffledManifest.settings,
      civs: [1, 5, 9, CIV_RANDOM],
      rejoin: { code: 'QUAD4', slot: 2, token: 'secret-rejoin-tok' },
      testMap: false,
    });
    expect(resolved.names).toEqual(['', 'Alice', 'Bob', 'Carol', 'Dave']);

    const link = new FakeLink();
    const timers = new FakeTimers();
    const lockstep = new Lockstep({ link, start: resolved.lockstepStart, timers });
    expect(lockstep.world.players).toBe(5);
    expect(lockstep.world.civs).toEqual([0, ...resolveCivs(8888, [1, 5, 9, CIV_RANDOM])]);
    expect(lockstep.slot).toBe(2);

    // Simulating player 2 (slot 1) dropping/resigning must NOT compact civs or names.
    const dropped = new Set<number>();
    lockstep.onDropped = (slot) => dropped.add(slot + 1);
    link.receive({ t: 'dropped', slot: 1 });
    expect(dropped.has(2)).toBe(true);
    expect(resolved.names).toEqual(['', 'Alice', 'Bob', 'Carol', 'Dave']);
    expect(lockstep.world.players).toBe(5);
    expect(lockstep.world.civs.length).toBe(5);
    lockstep.stop();
  });

  test('resolveMatchStart preserves legacy capacity-2 and single-player starts without manifest (N06)', () => {
    const legacyStart: ServerMessage = {
      t: 'start',
      seed: 77,
      commandDelay: 2,
      players: [
        { slot: 1, name: 'Computer (Medium)', ready: true, civ: 2 },
        { slot: 0, name: 'Alice', ready: true, civ: CIV_EGYPTIAN },
      ],
      settings: DEFAULT_GAME_SETTINGS,
      token: 'sp-tok',
      mode: 'single-player',
      difficulty: 'medium',
    };
    const resolved = resolveMatchStart(legacyStart, 0, 'SP123');
    expect(resolved.manifest).toBeNull();
    expect(resolved.lockstepStart).toEqual({
      seed: 77,
      commandDelay: 2,
      playerCount: 2,
      mode: 'single-player',
      slot: 0,
      settings: DEFAULT_GAME_SETTINGS,
      civs: [CIV_EGYPTIAN, 2],
      rejoin: { code: 'SP123', slot: 0, token: 'sp-tok' },
      testMap: false,
    });
    expect(resolved.names).toEqual(['', 'Alice', 'Computer (Medium)']);
  });

  test('four clients initialized from the same MatchManifest share identical world setup and turn hashes (U05)', () => {
    const manifest = makeFourPlayerManifest(20261124);
    const timers = new FakeTimers();
    const links = [new FakeLink(), new FakeLink(), new FakeLink(), new FakeLink()];
    const locksteps = links.map((link, slot) => {
      const startMsg: ServerMessage = {
        t: 'start',
        seed: manifest.seed,
        commandDelay: 2,
        capacity: 4,
        hostSlot: manifest.hostSlot,
        manifest,
        versions: manifest.versions,
        players: manifest.players.map((p) => ({ slot: p.slot, name: p.name, ready: true, civ: p.civ })),
        settings: manifest.settings,
        token: `tok-${slot}`,
        mode: 'multiplayer',
      };
      const { lockstepStart } = resolveMatchStart(startMsg, slot, manifest.code);
      return new Lockstep({ link, start: lockstepStart, timers, now: () => timers.clock, frameMs: () => 16 });
    });

    const expectedCivs = [0, ...resolveCivs(manifest.seed, [1, 5, 9, CIV_RANDOM])];
    for (let i = 0; i < 4; i++) {
      const ls = locksteps[i]!;
      expect(ls.slot).toBe(i);
      expect(ls.world.players).toBe(5);
      expect(ls.world.civs).toEqual(expectedCivs);
      expect([ls.world.map.width, ls.world.map.height]).toEqual([96, 96]);
      expect(ls.world.victory.type).toBe(VICTORY_CONQUEST);
      expect(ls.world.hash()).toBe(locksteps[0]!.world.hash());
    }

    // Issue commands on turn 0 from all 4 clients and verify identical sync hashes at turn 4.
    locksteps.forEach((ls, slot) => ls.issue({ type: 'test', x: 10 + slot, y: 20 + slot }));
    const sent = [new Map(), new Map(), new Map(), new Map()] as Map<number, ClientMessage>[];
    let nextRelease = 0;
    while (locksteps.some((ls) => ls.turn <= 4)) {
      timers.next();
      links.forEach((link, slot) => {
        for (const msg of link.sent.splice(0)) {
          if (msg.t === 'turn') sent[slot]!.set(msg.turn, msg);
        }
      });
      while (sent.every((m) => m.has(nextRelease))) {
        const releaseMsg: ServerMessage = {
          t: 'turn',
          turn: nextRelease,
          batches: sent.map((m, slot) => {
            const turnMsg = m.get(nextRelease)!;
            return { slot, commands: turnMsg.t === 'turn' ? turnMsg.commands : [] };
          }),
        };
        for (const link of links) link.receive(releaseMsg);
        nextRelease++;
      }
    }

    const turn4Hashes = locksteps.map((ls) => ls.hashes.get(4));
    expect(turn4Hashes[0]).toBeDefined();
    expect(turn4Hashes).toEqual([turn4Hashes[0], turn4Hashes[0], turn4Hashes[0], turn4Hashes[0]]);
    for (const ls of locksteps) ls.stop();
  });

  test('createLobbyDebug exposes capacity, hostSlot, seats, and versions without leaking token or botToken', () => {
    const link = new FakeLink();
    const session = new Session(link);
    link.receive({
      t: 'lobby',
      code: 'SEC99',
      you: 0,
      capacity: 2,
      hostSlot: 0,
      seats: [
        { slot: 0, status: 'occupied', name: 'Alice', civ: 1, ready: false },
        { slot: 1, status: 'open', name: null, civ: null, ready: false },
      ],
      versions: { ...DEFAULT_COMPATIBILITY_VERSIONS },
      players: [{ slot: 0, name: 'Alice', civ: 1, ready: false }],
      settings: DEFAULT_GAME_SETTINGS,
      mode: 'single-player',
      difficulty: 'hard',
      botToken: 'super-secret-bot-token',
    });

    const dbg = createLobbyDebug(session);
    expect(dbg.code()).toBe('SEC99');
    expect(dbg.capacity()).toBe(2);
    expect(dbg.hostSlot()).toBe(0);
    expect(dbg.versions()).toEqual(DEFAULT_COMPATIBILITY_VERSIONS);
    const serialized = JSON.stringify({
      phase: dbg.phase(),
      code: dbg.code(),
      you: dbg.you(),
      capacity: dbg.capacity(),
      hostSlot: dbg.hostSlot(),
      mode: dbg.mode(),
      players: dbg.players(),
      seats: dbg.seats(),
      versions: dbg.versions(),
      error: dbg.error(),
    });
    expect(serialized).not.toContain('super-secret-bot-token');
    expect(serialized).not.toContain('botToken');
  });
});

describe('M10 Same-Origin WebSocket & Invite URL Entry Flow (I06)', () => {
  test('relayUrl uses ws: on http:, wss: on https:, preserves LAN/tunnel host, and never hardcodes localhost', () => {
    expect(relayUrl({ protocol: 'http:', host: '192.168.1.42:8787' })).toBe('ws://192.168.1.42:8787/ws');
    expect(relayUrl({ protocol: 'https:', host: 'game-tunnel.trycloudflare.com' })).toBe('wss://game-tunnel.trycloudflare.com/ws');
    expect(() => relayUrl({ protocol: 'https:', host: '' })).toThrow(/location\.host/);
  });

  test('startup invite parsing and entry hooks wire ?room=CODE through LobbyView and Session to join (I06)', async () => {
    const href = 'https://lan-host.example:8787/?room=ab-cd2';
    const { windowObj } = installDomStubs(href);
    vi.spyOn(assetsModule, 'createAssetProvider').mockResolvedValue({
      string: () => undefined,
      soundTable: () => null,
    } as unknown as AssetProvider);

    const initialRoomCode = readStartupInviteCode(href);
    expect(initialRoomCode).toBe('ABCD2');
    const inviteHooks = buildClientInviteHooks('https://lan-host.example:8787');
    expect(inviteHooks.buildInviteUrl('ABCD2')).toBe('https://lan-host.example:8787/?room=ABCD2');
    expect(inviteHooks.isLocalOrigin('https://lan-host.example:8787')).toBe(false);
    expect(inviteHooks.isLocalOrigin('http://localhost:5173')).toBe(true);

    const host = makeElement('div');
    const link = new FakeLink();
    const fetchImpl = vi.fn<typeof fetch>(async () =>
      new Response(JSON.stringify(DEFAULT_COMPATIBILITY_VERSIONS), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );

    await startMultiplayer(host as unknown as HTMLElement, makeMockApp(), {
      debug: true,
      speed: 1,
      initialRoomCode,
      ...inviteHooks,
      clientVersions: { ...DEFAULT_COMPATIBILITY_VERSIONS },
      connectLink: async () => link,
      fetchImpl,
      setGameVisible: vi.fn(),
    });

    const codeInput = findByTestId(host, 'code');
    expect(codeInput?.value).toBe('ABCD2');

    // Join using the prefilled invite code without auto-ready or auto-start.
    const nameInput = findByTestId(host, 'name');
    if (nameInput) {
      nameInput.value = 'GuestBob';
      for (const fn of nameInput.listeners.get('input') ?? []) fn({});
    }
    findByTestId(host, 'join')!.click();

    expect(link.sent).toEqual([
      {
        t: 'join',
        code: 'ABCD2',
        name: 'GuestBob',
        versions: DEFAULT_COMPATIBILITY_VERSIONS,
      },
    ]);
    expect(windowObj.__lobby).toBeDefined();
  });
});
