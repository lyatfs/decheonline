import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import {
  CIV_RANDOM,
  DEFAULT_GAME_SETTINGS,
  type ClientMessage,
  type ServerMessage,
} from '@aoe/protocol';
import { MAP_HILLY, MAP_SMALL, MAP_TINY, VICTORY_CONQUEST } from '@aoe/sim';
import type { Link } from '../net/link';
import * as linkModule from '../net/link';
import { AiBot, type AiBotSpawnOptions } from '../bot/ai-bot';
import type { SinglePlayerSetup } from '../bot/types';
import { Session } from './session';
import { SinglePlayerController } from './single-player-controller';
import { SinglePlayerSetupView, defaultLobbySettings, validateSinglePlayerSetup } from './single-player-setup';

class FakeLink implements Link {
  sent: ClientMessage[] = [];
  private messageHandlers = new Set<(m: ServerMessage) => void>();
  private closeHandlers = new Set<() => void>();
  closed = false;

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
    this.closed = true;
    for (const fn of this.closeHandlers) fn();
  }

  receive(m: ServerMessage): void {
    for (const fn of this.messageHandlers) fn(m);
  }
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

function makeSetup(patch: Partial<SinglePlayerSetup> = {}): SinglePlayerSetup {
  return {
    humanCiv: 1,
    botCiv: 2,
    difficulty: 'medium',
    settings: defaultLobbySettings(),
    ...patch,
  };
}

describe('Single-player validation and defaults', () => {
  test('defaultLobbySettings produces valid settings and validateSinglePlayerSetup checks bounds', () => {
    const valid = makeSetup({ humanCiv: CIV_RANDOM, botCiv: CIV_RANDOM, difficulty: 'hard' });
    expect(validateSinglePlayerSetup('Alice', valid)).toBeNull();
    expect(validateSinglePlayerSetup('   ', valid)).not.toBeNull();
    expect(validateSinglePlayerSetup('A'.repeat(25), valid)).not.toBeNull();
    expect(validateSinglePlayerSetup('Alice', makeSetup({ humanCiv: 0 }))).not.toBeNull();
    expect(validateSinglePlayerSetup('Alice', makeSetup({ botCiv: 18 }))).not.toBeNull();
    expect(
      validateSinglePlayerSetup('Alice', makeSetup({ difficulty: 'insane' as SinglePlayerSetup['difficulty'] })),
    ).not.toBeNull();
    expect(
      validateSinglePlayerSetup(
        'Alice',
        makeSetup({ settings: { ...defaultLobbySettings(), mapSize: 999 } }),
      ),
    ).not.toBeNull();
  });
});

describe('SinglePlayerController lifecycle (U01–U04)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  test('U01: creates single-player room, confirms settings & civs on server, spawns bot with difficulty/token/civ, and starts without timer hack', async () => {
    const link = new FakeLink();
    const session = new Session(link);
    const bot = { destroy: vi.fn() } as unknown as AiBot;
    const spawnCalls: { code: string; opts: AiBotSpawnOptions }[] = [];

    const controller = new SinglePlayerController({
      session,
      spawnBot: async (code, opts) => {
        spawnCalls.push({ code, opts });
        return bot;
      },
    });
    session.onChange = (s) => controller.onSessionState(s);

    const customSettings = {
      ...defaultLobbySettings(),
      mapType: MAP_HILLY,
      mapSize: MAP_SMALL,
      victory: { type: VICTORY_CONQUEST },
    };
    const setup = makeSetup({
      humanCiv: 10,
      botCiv: CIV_RANDOM,
      difficulty: 'hard',
      settings: customSettings,
    });

    expect(controller.start('Alice', setup)).toBe(true);
    expect(link.sent).toEqual([
      { t: 'create', name: 'Alice', mode: 'single-player', difficulty: 'hard' },
    ]);

    // 1. Server sends initial single-player lobby with default settings and civ 1
    link.receive({
      t: 'lobby',
      code: 'SP001',
      you: 0,
      players: [{ slot: 0, name: 'Alice', ready: false, civ: 1 }],
      settings: DEFAULT_GAME_SETTINGS,
      mode: 'single-player',
      difficulty: 'hard',
      botToken: 'bot-secret-1',
    });

    // Must apply settings first and NOT spawn bot or ready or start yet
    expect(link.sent[1]).toEqual({ t: 'settings', settings: customSettings });
    expect(spawnCalls).toHaveLength(0);
    expect(link.sent.some((m) => m.t === 'ready' || m.t === 'start')).toBe(false);

    // 2. Server confirms settings
    link.receive({
      t: 'lobby',
      code: 'SP001',
      you: 0,
      players: [{ slot: 0, name: 'Alice', ready: false, civ: 1 }],
      settings: customSettings,
      mode: 'single-player',
      difficulty: 'hard',
      botToken: 'bot-secret-1',
    });

    // Now sends human civ 10
    expect(link.sent[2]).toEqual({ t: 'civ', civ: 10 });
    expect(spawnCalls).toHaveLength(0);

    // 3. Server confirms human civ 10 -> controller spawns bot with exact civ, difficulty, botToken
    link.receive({
      t: 'lobby',
      code: 'SP001',
      you: 0,
      players: [{ slot: 0, name: 'Alice', ready: false, civ: 10 }],
      settings: customSettings,
      mode: 'single-player',
      difficulty: 'hard',
      botToken: 'bot-secret-1',
    });

    expect(spawnCalls).toEqual([
      {
        code: 'SP001',
        opts: {
          name: 'Computer (Hard)',
          civ: CIV_RANDOM,
          difficulty: 'hard',
          botToken: 'bot-secret-1',
        },
      },
    ]);
    await Promise.resolve();
    await Promise.resolve();

    // Still must NOT start or ready before bot appears in lobby
    expect(link.sent.some((m) => m.t === 'start')).toBe(false);

    // 4. Bot joins with initial civ 1 before setting its civ 17 (Random)
    link.receive({
      t: 'lobby',
      code: 'SP001',
      you: 0,
      players: [
        { slot: 0, name: 'Alice', ready: false, civ: 10 },
        { slot: 1, name: 'Computer (Hard)', ready: false, civ: 1 },
      ],
      settings: customSettings,
      mode: 'single-player',
      difficulty: 'hard',
      botToken: 'bot-secret-1',
    });
    expect(link.sent.some((m) => m.t === 'ready' || m.t === 'start')).toBe(false);

    // 5. Bot sets civ to CIV_RANDOM and readies
    link.receive({
      t: 'lobby',
      code: 'SP001',
      you: 0,
      players: [
        { slot: 0, name: 'Alice', ready: false, civ: 10 },
        { slot: 1, name: 'Computer (Hard)', ready: true, civ: CIV_RANDOM },
      ],
      settings: customSettings,
      mode: 'single-player',
      difficulty: 'hard',
      botToken: 'bot-secret-1',
    });

    // Human now readies, NOT start yet until server confirms both ready
    expect(link.sent.at(-1)).toEqual({ t: 'ready', ready: true });
    expect(link.sent.some((m) => m.t === 'start')).toBe(false);

    // 6. Server confirms both ready -> start is sent immediately (no 300ms timer!)
    link.receive({
      t: 'lobby',
      code: 'SP001',
      you: 0,
      players: [
        { slot: 0, name: 'Alice', ready: true, civ: 10 },
        { slot: 1, name: 'Computer (Hard)', ready: true, civ: CIV_RANDOM },
      ],
      settings: customSettings,
      mode: 'single-player',
      difficulty: 'hard',
      botToken: 'bot-secret-1',
    });

    expect(link.sent.at(-1)).toEqual({ t: 'start' });

    link.receive({
      t: 'start',
      seed: 12345,
      commandDelay: 2,
      players: [
        { slot: 0, name: 'Alice', ready: true, civ: 10 },
        { slot: 1, name: 'Computer (Hard)', ready: true, civ: CIV_RANDOM },
      ],
      settings: customSettings,
      token: 'rejoin-1',
      mode: 'single-player',
      difficulty: 'hard',
    });
    expect(controller.state.status).toBe('playing');
    expect(bot.destroy).not.toHaveBeenCalled();
  });

  test('U02: repeated start() clicks create at most one room/bot; cancel mid-spawn destroys late-resolved bot and never resurrects session', async () => {
    const link = new FakeLink();
    const session = new Session(link);
    const d1 = deferred<AiBot>();
    const spawnBot = vi.fn().mockReturnValueOnce(d1.promise);

    const controller = new SinglePlayerController({ session, spawnBot });
    session.onChange = (s) => controller.onSessionState(s);

    const setup = makeSetup({ humanCiv: 1, botCiv: 2, difficulty: 'easy' });
    expect(controller.start('Alice', setup)).toBe(true);
    // Repeated clicks while creating must be ignored
    expect(controller.start('Alice', setup)).toBe(false);
    expect(controller.start('Alice', setup)).toBe(false);
    expect(link.sent.filter((m) => m.t === 'create')).toHaveLength(1);

    link.receive({
      t: 'lobby',
      code: 'SP002',
      you: 0,
      players: [{ slot: 0, name: 'Alice', ready: false, civ: 1 }],
      settings: DEFAULT_GAME_SETTINGS,
      mode: 'single-player',
      difficulty: 'easy',
      botToken: 'tok-2',
    });

    // Repeated clicks while spawning must be ignored
    expect(controller.start('Alice', setup)).toBe(false);
    expect(spawnBot).toHaveBeenCalledTimes(1);

    // User cancels mid-spawn
    controller.cancel();
    expect(controller.state.status).toBe('idle');
    expect(link.sent.at(-1)).toEqual({ t: 'leave' });

    // Late promise resolves after cancel -> immediately destroyed, no ready/start
    const lateBot = { destroy: vi.fn() } as unknown as AiBot;
    d1.resolve(lateBot);
    await Promise.resolve();
    await Promise.resolve();

    expect(lateBot.destroy).toHaveBeenCalledTimes(1);
    expect(link.sent.some((m) => m.t === 'ready' || m.t === 'start')).toBe(false);
  });

  test('U02: cancel while create is in flight leaves room as soon as delayed lobby arrives', () => {
    const link = new FakeLink();
    const session = new Session(link);
    const spawnBot = vi.fn();
    const controller = new SinglePlayerController({ session, spawnBot });
    session.onChange = (s) => controller.onSessionState(s);

    controller.start('Alice', makeSetup());
    controller.cancel();
    expect(controller.state.status).toBe('idle');

    // Delayed server lobby arrives for the cancelled create
    link.receive({
      t: 'lobby',
      code: 'LATE1',
      you: 0,
      players: [{ slot: 0, name: 'Alice', ready: false, civ: 1 }],
      settings: DEFAULT_GAME_SETTINGS,
      mode: 'single-player',
      difficulty: 'medium',
      botToken: 'tok-late',
    });

    expect(spawnBot).not.toHaveBeenCalled();
    expect(link.sent.at(-1)).toEqual({ t: 'leave' });
    expect(session.state.phase).toBe('idle');
  });

  test('U03: spawn failure cleans up room and surfaces error; retry creates exactly one fresh bot', async () => {
    const link = new FakeLink();
    const session = new Session(link);
    const bot2 = { destroy: vi.fn() } as unknown as AiBot;
    const spawnBot = vi
      .fn()
      .mockRejectedValueOnce(new Error('WebSocket failed'))
      .mockResolvedValueOnce(bot2);

    const controller = new SinglePlayerController({ session, spawnBot });
    session.onChange = (s) => controller.onSessionState(s);

    const setup = makeSetup({ humanCiv: 1, botCiv: 2, difficulty: 'medium' });
    controller.start('Alice', setup);
    link.receive({
      t: 'lobby',
      code: 'FAIL1',
      you: 0,
      players: [{ slot: 0, name: 'Alice', ready: false, civ: 1 }],
      settings: DEFAULT_GAME_SETTINGS,
      mode: 'single-player',
      difficulty: 'medium',
      botToken: 'tok-fail',
    });

    await Promise.resolve();
    await Promise.resolve();

    expect(controller.state.status).toBe('error');
    expect(controller.state.error).toContain('WebSocket failed');
    expect(link.sent.at(-1)).toEqual({ t: 'leave' });
    expect(session.state.phase).toBe('idle');

    // Retry
    expect(controller.start('Alice', setup)).toBe(true);
    link.receive({
      t: 'lobby',
      code: 'GOOD2',
      you: 0,
      players: [{ slot: 0, name: 'Alice', ready: false, civ: 1 }],
      settings: DEFAULT_GAME_SETTINGS,
      mode: 'single-player',
      difficulty: 'medium',
      botToken: 'tok-good',
    });
    await Promise.resolve();
    await Promise.resolve();

    expect(spawnBot).toHaveBeenCalledTimes(2);
    expect(bot2.destroy).not.toHaveBeenCalled();

    // Bot joins & readies, game starts, then ending game cleans up bot2
    link.receive({
      t: 'lobby',
      code: 'GOOD2',
      you: 0,
      players: [
        { slot: 0, name: 'Alice', ready: false, civ: 1 },
        { slot: 1, name: 'Computer (Medium)', ready: true, civ: 2 },
      ],
      settings: DEFAULT_GAME_SETTINGS,
      mode: 'single-player',
      difficulty: 'medium',
      botToken: 'tok-good',
    });
    link.receive({
      t: 'start',
      seed: 42,
      commandDelay: 2,
      players: [
        { slot: 0, name: 'Alice', ready: true, civ: 1 },
        { slot: 1, name: 'Computer (Medium)', ready: true, civ: 2 },
      ],
      settings: DEFAULT_GAME_SETTINGS,
      token: 'rejoin-good',
      mode: 'single-player',
      difficulty: 'medium',
    });
    expect(controller.state.status).toBe('playing');

    session.finish();
    expect(bot2.destroy).toHaveBeenCalledTimes(1);
    expect(controller.state.status).toBe('idle');
  });

  test('U04: entering multiplayer after single-player never auto-readies, auto-starts, or retains bot/profile', async () => {
    const link = new FakeLink();
    const session = new Session(link);
    const bot = { destroy: vi.fn() } as unknown as AiBot;
    const spawnBot = vi.fn().mockResolvedValue(bot);

    const controller = new SinglePlayerController({ session, spawnBot });
    session.onChange = (s) => controller.onSessionState(s);

    controller.start('Alice', makeSetup({ humanCiv: 1, botCiv: 2, difficulty: 'hard' }));
    link.receive({
      t: 'lobby',
      code: 'SP004',
      you: 0,
      players: [{ slot: 0, name: 'Alice', ready: false, civ: 1 }],
      settings: DEFAULT_GAME_SETTINGS,
      mode: 'single-player',
      difficulty: 'hard',
      botToken: 'tok-4',
    });
    await Promise.resolve();
    controller.cancel();
    expect(bot.destroy).toHaveBeenCalledTimes(1);

    const sentBeforeMp = link.sent.length;
    session.create('Alice');
    link.receive({
      t: 'lobby',
      code: 'MP001',
      you: 0,
      players: [{ slot: 0, name: 'Alice', ready: false, civ: 1 }],
      settings: DEFAULT_GAME_SETTINGS,
      mode: 'multiplayer',
    });

    const sentDuringMp = link.sent.slice(sentBeforeMp);
    expect(sentDuringMp).toEqual([{ t: 'create', name: 'Alice' }]);
    expect(spawnBot).toHaveBeenCalledTimes(1);
    expect(session.state.mode).toBe('multiplayer');
    expect(session.state.difficulty).toBeUndefined();
    expect(session.state.botToken).toBeUndefined();
  });

  test('U03/U04 Path A: failed SP create (lobby.error) -> cancel -> multiplayer create/join stays in multiplayer lobby without auto-leaving', () => {
    const link = new FakeLink();
    const session = new Session(link);
    const spawnBot = vi.fn();

    const controller = new SinglePlayerController({ session, spawnBot });
    session.onChange = (s) => controller.onSessionState(s);

    expect(controller.start('Alice', makeSetup())).toBe(true);
    expect(controller.state.status).toBe('creating');

    // Server rejects SP create with error while phase is still 'idle'
    link.receive({ t: 'error', code: 'bad-message', message: 'Invalid settings' });
    expect(controller.state.status).toBe('error');
    expect(controller.state.error).toContain('Invalid settings');

    // User cancels and switches to multiplayer create
    controller.cancel();
    expect(controller.state.status).toBe('idle');

    const sentBeforeMp = link.sent.length;
    session.create('Alice');
    link.receive({
      t: 'lobby',
      code: 'MP100',
      you: 0,
      players: [{ slot: 0, name: 'Alice', ready: false, civ: 1 }],
      settings: DEFAULT_GAME_SETTINGS,
      mode: 'multiplayer',
    });

    expect(link.sent.slice(sentBeforeMp)).toEqual([{ t: 'create', name: 'Alice' }]);
    expect(session.state.phase).toBe('lobby');
    expect(session.state.code).toBe('MP100');
    expect(session.state.mode).toBe('multiplayer');
    expect(spawnBot).not.toHaveBeenCalled();

    // Also verify multiplayer join stays in lobby
    session.leave();
    const sentBeforeJoin = link.sent.length;
    session.join('MP200', 'Alice');
    link.receive({
      t: 'lobby',
      code: 'MP200',
      you: 1,
      players: [
        { slot: 0, name: 'Host', ready: false, civ: 1 },
        { slot: 1, name: 'Alice', ready: false, civ: 2 },
      ],
      settings: DEFAULT_GAME_SETTINGS,
      mode: 'multiplayer',
    });
    expect(link.sent.slice(sentBeforeJoin)).toEqual([{ t: 'join', code: 'MP200', name: 'Alice' }]);
    expect(session.state.phase).toBe('lobby');
    expect(session.state.code).toBe('MP200');
  });

  test('U03/U04 Path B: cancelled in-flight SP create receiving error -> multiplayer create/join stays in multiplayer lobby', () => {
    const link = new FakeLink();
    const session = new Session(link);
    const spawnBot = vi.fn();

    const controller = new SinglePlayerController({ session, spawnBot });
    session.onChange = (s) => controller.onSessionState(s);

    expect(controller.start('Alice', makeSetup())).toBe(true);
    controller.cancel();
    expect(controller.state.status).toBe('idle');

    // Server responds with error instead of lobby for the cancelled SP create
    link.receive({ t: 'error', code: 'bad-message', message: 'Create rejected' });
    expect(controller.state.status).toBe('idle');

    // Subsequent multiplayer create (calling cancel() again as LobbyView does) stays in MP lobby
    const sentBeforeMp = link.sent.length;
    controller.cancel();
    session.create('Alice');
    link.receive({
      t: 'lobby',
      code: 'MP300',
      you: 0,
      players: [{ slot: 0, name: 'Alice', ready: false, civ: 1 }],
      settings: DEFAULT_GAME_SETTINGS,
      mode: 'multiplayer',
    });

    expect(link.sent.slice(sentBeforeMp)).toEqual([{ t: 'create', name: 'Alice' }]);
    expect(session.state.phase).toBe('lobby');
    expect(session.state.code).toBe('MP300');
    expect(session.state.mode).toBe('multiplayer');
    expect(spawnBot).not.toHaveBeenCalled();

    // Even if a multiplayer lobby arrives while abandonRoomOnLobby was still armed, do NOT leave it
    session.leave();
    controller.start('Alice', makeSetup());
    controller.cancel();
    const sentBeforeMpDirect = link.sent.length;
    session.create('Alice');
    link.receive({
      t: 'lobby',
      code: 'MP301',
      you: 0,
      players: [{ slot: 0, name: 'Alice', ready: false, civ: 1 }],
      settings: DEFAULT_GAME_SETTINGS,
      mode: 'multiplayer',
    });
    expect(link.sent.slice(sentBeforeMpDirect)).toEqual([{ t: 'create', name: 'Alice' }]);
    expect(session.state.phase).toBe('lobby');
    expect(session.state.code).toBe('MP301');
  });

  test('U03: post-connect AiBot join error or premature close surfaces cleanly out of spawning instead of hanging', async () => {
    const flushMicrotasks = async () => {
      for (let i = 0; i < 6; i++) await Promise.resolve();
    };

    const botLink1 = new FakeLink();
    const botLink2 = new FakeLink();
    const botLink3 = new FakeLink();
    vi.spyOn(linkModule, 'connect')
      .mockResolvedValueOnce(botLink1)
      .mockResolvedValueOnce(botLink2)
      .mockResolvedValueOnce(botLink3);

    const link = new FakeLink();
    const session = new Session(link);
    const controller = new SinglePlayerController({ session });
    session.onChange = (s) => controller.onSessionState(s);

    // Case 1: AiBot connects, sends join, and server rejects join with { t: 'error' }
    controller.start('Alice', makeSetup());
    link.receive({
      t: 'lobby',
      code: 'BOTERR1',
      you: 0,
      players: [{ slot: 0, name: 'Alice', ready: false, civ: 1 }],
      settings: DEFAULT_GAME_SETTINGS,
      mode: 'single-player',
      difficulty: 'medium',
      botToken: 'tok-err-1',
    });
    await flushMicrotasks();
    expect(controller.state.status).toBe('spawning');
    expect(botLink1.sent).toEqual([
      { t: 'join', code: 'BOTERR1', name: 'Computer (Medium)', botToken: 'tok-err-1' },
    ]);

    botLink1.receive({ t: 'error', code: 'bad-code', message: 'Invalid bot token' });
    expect(controller.state.status).toBe('error');
    expect(controller.state.error).toContain('Invalid bot token');
    expect(botLink1.closed).toBe(true);
    expect(link.sent.at(-1)).toEqual({ t: 'leave' });
    expect(session.state.phase).toBe('idle');

    // Case 2: Retry succeeds connect, then bot link closes prematurely before game start
    controller.start('Alice', makeSetup());
    link.receive({
      t: 'lobby',
      code: 'BOTERR2',
      you: 0,
      players: [{ slot: 0, name: 'Alice', ready: false, civ: 1 }],
      settings: DEFAULT_GAME_SETTINGS,
      mode: 'single-player',
      difficulty: 'medium',
      botToken: 'tok-err-2',
    });
    await flushMicrotasks();
    expect(controller.state.status).toBe('spawning');

    botLink2.close();
    expect(controller.state.status).toBe('error');
    expect(controller.state.error).toBeTruthy();
    expect(link.sent.at(-1)).toEqual({ t: 'leave' });
    expect(session.state.phase).toBe('idle');

    // Case 3: Server rejects join in the microtask window before spawnBot().then() attaches setOnError
    controller.start('Alice', makeSetup());
    link.receive({
      t: 'lobby',
      code: 'BOTERR3',
      you: 0,
      players: [{ slot: 0, name: 'Alice', ready: false, civ: 1 }],
      settings: DEFAULT_GAME_SETTINGS,
      mode: 'single-player',
      difficulty: 'medium',
      botToken: 'tok-err-3',
    });
    await Promise.resolve();
    await Promise.resolve();
    botLink3.receive({ t: 'error', code: 'room-full', message: 'Room is full' });
    await flushMicrotasks();
    expect(controller.state.status).toBe('error');
    expect(controller.state.error).toContain('Room is full');
    expect(botLink3.closed).toBe(true);
    expect(link.sent.at(-1)).toEqual({ t: 'leave' });
  });
});

describe('AiBot.spawn minimal bridge', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  test('supports both legacy positional args and options object with difficulty + botToken', async () => {
    const sentLegacy: ClientMessage[] = [];
    const sentOpts: ClientMessage[] = [];
    const makeFakeLink = (bucket: ClientMessage[]): Link => ({
      send: (m) => bucket.push(m),
      onMessage: vi.fn(() => () => {}),
      onClose: vi.fn(),
      close: vi.fn(),
    });

    vi.spyOn(linkModule, 'connect')
      .mockResolvedValueOnce(makeFakeLink(sentLegacy))
      .mockResolvedValueOnce(makeFakeLink(sentOpts));

    const legacyBot = await AiBot.spawn('LEG12', 'LegacyBot', 4);
    expect(legacyBot.difficulty).toBe('medium');
    expect(sentLegacy).toEqual([{ t: 'join', code: 'LEG12', name: 'LegacyBot' }]);

    const spBot = await AiBot.spawn('SP999', {
      civ: CIV_RANDOM,
      difficulty: 'hard',
      botToken: 'secret-999',
      speed: 2,
    });
    expect(spBot.difficulty).toBe('hard');
    expect(sentOpts).toEqual([
      { t: 'join', code: 'SP999', name: 'Computer (Hard)', botToken: 'secret-999' },
    ]);
  });
});

interface MockDomNode {
  tagName: string;
  value: string;
  textContent: string;
  hidden: boolean;
  disabled: boolean;
  checked: boolean;
  selected: boolean;
  dataset: Record<string, string>;
  style: { cssText: string };
  children: MockDomNode[];
  listeners: Map<string, ((ev: unknown) => void)[]>;
  append(...nodes: (MockDomNode | string)[]): void;
  replaceChildren(...nodes: (MockDomNode | string)[]): void;
  addEventListener(type: string, fn: (ev: unknown) => void): void;
  dispatch(type: string, ev?: unknown): void;
}

function makeDomNode(tagName: string): MockDomNode {
  return {
    tagName: tagName.toUpperCase(),
    value: '',
    textContent: '',
    hidden: false,
    disabled: false,
    checked: false,
    selected: false,
    dataset: {},
    style: { cssText: '' },
    children: [],
    listeners: new Map(),
    append(...nodes) {
      for (const n of nodes) if (typeof n !== 'string') this.children.push(n);
    },
    replaceChildren(...nodes) {
      this.children = [];
      this.append(...nodes);
    },
    addEventListener(type, fn) {
      const list = this.listeners.get(type) ?? [];
      list.push(fn);
      this.listeners.set(type, list);
    },
    dispatch(type, ev = {}) {
      for (const fn of this.listeners.get(type) ?? []) fn(ev);
    },
  };
}

function findNode(root: MockDomNode, testid: string): MockDomNode | undefined {
  if (root.dataset.testid === testid) return root;
  for (const child of root.children) {
    const found = findNode(child, testid);
    if (found) return found;
  }
  return undefined;
}

describe('SinglePlayerSetupView UI & keyboard/validation behavior', () => {
  beforeEach(() => {
    vi.stubGlobal('document', {
      createElement: (tag: string) => makeDomNode(tag),
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  test('validates empty name, propagates selected options on submit, disables controls while loading, and cancels on Escape', () => {
    const onStart = vi.fn();
    const onCancel = vi.fn();
    const view = new SinglePlayerSetupView({ onStart, onCancel });
    const root = view.root as unknown as MockDomNode;

    const nameEl = findNode(root, 'sp-name')!;
    const humanCivEl = findNode(root, 'sp-human-civ')!;
    const botCivEl = findNode(root, 'sp-bot-civ')!;
    const diffEl = findNode(root, 'sp-difficulty')!;
    const mapTypeEl = findNode(root, 'sp-map-type')!;
    const mapSizeEl = findNode(root, 'sp-map-size')!;
    const startBtn = findNode(root, 'sp-start')!;
    const cancelBtn = findNode(root, 'sp-cancel')!;
    const errorEl = findNode(root, 'sp-error')!;
    const statusEl = findNode(root, 'sp-status')!;

    // Empty name triggers validation error banner without calling onStart
    nameEl.value = '   ';
    nameEl.dispatch('input');
    startBtn.dispatch('click', { preventDefault: vi.fn() });
    expect(onStart).not.toHaveBeenCalled();
    expect(errorEl.hidden).toBe(false);
    expect(errorEl.textContent).toContain('player name');

    // Fill valid selections and submit
    nameEl.value = 'Hero';
    nameEl.dispatch('input');
    expect(errorEl.hidden).toBe(true);

    humanCivEl.value = String(CIV_RANDOM);
    humanCivEl.dispatch('change');
    botCivEl.value = '10';
    botCivEl.dispatch('change');
    diffEl.value = 'hard';
    diffEl.dispatch('change');
    mapTypeEl.value = String(MAP_HILLY);
    mapTypeEl.dispatch('change');
    mapSizeEl.value = String(MAP_TINY);
    mapSizeEl.dispatch('change');

    startBtn.dispatch('click', { preventDefault: vi.fn() });
    expect(onStart).toHaveBeenCalledTimes(1);
    expect(onStart).toHaveBeenCalledWith(
      'Hero',
      expect.objectContaining({
        humanCiv: CIV_RANDOM,
        botCiv: 10,
        difficulty: 'hard',
        settings: expect.objectContaining({
          mapType: MAP_HILLY,
          mapSize: MAP_TINY,
        }),
      }),
    );

    // Loading state disables form inputs and Start while keeping Cancel enabled
    view.update({
      status: 'spawning',
      statusMessage: 'Connecting AI opponent...',
      error: null,
      activeSetup: null,
    });
    expect(nameEl.disabled).toBe(true);
    expect(startBtn.disabled).toBe(true);
    expect(cancelBtn.disabled).toBe(false);
    expect(statusEl.hidden).toBe(false);
    expect(statusEl.textContent).toContain('Connecting');

    // Escape key triggers onCancel even while loading
    root.dispatch('keydown', { key: 'Escape', preventDefault: vi.fn() });
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  test('A04: validation error is cleared on cancel / Escape and setPlayerName so re-opening setup hides stale error', () => {
    const onStart = vi.fn();
    const onCancel = vi.fn();
    const view = new SinglePlayerSetupView({ onStart, onCancel });
    const root = view.root as unknown as MockDomNode;

    const nameEl = findNode(root, 'sp-name')!;
    const startBtn = findNode(root, 'sp-start')!;
    const cancelBtn = findNode(root, 'sp-cancel')!;
    const errorEl = findNode(root, 'sp-error')!;

    // Trigger local validation error
    nameEl.value = '   ';
    nameEl.dispatch('input');
    startBtn.dispatch('click', { preventDefault: vi.fn() });
    expect(errorEl.hidden).toBe(false);
    expect(errorEl.textContent).toContain('player name');

    // Cancel via Cancel button, then re-open via setPlayerName + update (like LobbyView)
    cancelBtn.dispatch('click');
    expect(onCancel).toHaveBeenCalledTimes(1);
    view.setPlayerName('Player');
    view.update({
      status: 'idle',
      statusMessage: '',
      error: null,
      activeSetup: null,
    });
    expect(errorEl.hidden).toBe(true);
    expect(errorEl.textContent).toBe('');

    // Trigger local validation error again, then cancel via Escape and re-open
    nameEl.value = '   ';
    nameEl.dispatch('input');
    startBtn.dispatch('click', { preventDefault: vi.fn() });
    expect(errorEl.hidden).toBe(false);

    root.dispatch('keydown', { key: 'Escape', preventDefault: vi.fn() });
    expect(onCancel).toHaveBeenCalledTimes(2);
    view.setPlayerName('Player');
    view.update({
      status: 'idle',
      statusMessage: '',
      error: null,
      activeSetup: null,
    });
    expect(errorEl.hidden).toBe(true);
    expect(errorEl.textContent).toBe('');
  });
});
