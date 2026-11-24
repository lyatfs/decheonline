import { describe, expect, test } from 'vitest';
import {
  DEFAULT_COMPATIBILITY_VERSIONS,
  DEFAULT_GAME_SETTINGS,
  type ClientMessage,
  type CompatibilityVersions,
  type RoomSeat,
  type ServerMessage,
} from '@aoe/protocol';
import type { Link } from '../net/link';
import { Session, type LobbyState } from './session';

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

describe('Session room mode and single-player support', () => {
  test('backward-compatible create(name) and join(code, name) send legacy shapes and default mode to multiplayer', () => {
    const link = new FakeLink();
    const session = new Session(link);
    expect(session.state.mode).toBe('multiplayer');
    expect(session.state.difficulty).toBeUndefined();
    expect(session.state.botToken).toBeUndefined();

    session.create('Alice');
    expect(link.sent[0]).toEqual({ t: 'create', name: 'Alice' });

    link.receive({
      t: 'lobby',
      code: 'ABCD2',
      you: 0,
      players: [{ slot: 0, name: 'Alice', ready: false, civ: 1 }],
      settings: DEFAULT_GAME_SETTINGS,
      mode: 'multiplayer',
    });
    expect(session.state.mode).toBe('multiplayer');
    expect(session.state.difficulty).toBeUndefined();
    expect(session.state.botToken).toBeUndefined();

    session.join('ab-c d2', 'Bob');
    expect(link.sent[1]).toEqual({ t: 'join', code: 'ABCD2', name: 'Bob' });
  });

  test('create with single-player options and join with botToken track server-authoritative LobbyState', () => {
    const link = new FakeLink();
    const session = new Session(link);
    const changes: LobbyState[] = [];
    session.onChange = (s) => changes.push(s);

    session.create('Alice', { mode: 'single-player', difficulty: 'hard' });
    expect(link.sent[0]).toEqual({ t: 'create', name: 'Alice', mode: 'single-player', difficulty: 'hard' });
    // Mode is server-authoritative: remains 'multiplayer' until server sends 'lobby'
    expect(session.state.mode).toBe('multiplayer');

    link.receive({
      t: 'lobby',
      code: 'SP123',
      you: 0,
      players: [{ slot: 0, name: 'Alice', ready: false, civ: 1 }],
      settings: DEFAULT_GAME_SETTINGS,
      mode: 'single-player',
      difficulty: 'hard',
      botToken: 'tok-abc',
    });

    expect(session.state.mode).toBe('single-player');
    expect(session.state.difficulty).toBe('hard');
    expect(session.state.botToken).toBe('tok-abc');
    expect(changes.at(-1)?.mode).toBe('single-player');

    // Start preserves mode & difficulty
    link.receive({
      t: 'start',
      seed: 99,
      commandDelay: 2,
      players: [
        { slot: 0, name: 'Alice', ready: true, civ: 1 },
        { slot: 1, name: 'Computer (Hard)', ready: true, civ: 2 },
      ],
      settings: DEFAULT_GAME_SETTINGS,
      token: 'rejoin-tok',
      mode: 'single-player',
      difficulty: 'hard',
    });
    expect(session.state.phase).toBe('playing');
    expect(session.state.mode).toBe('single-player');
    expect(session.state.difficulty).toBe('hard');

    // Rejoined preserves mode & difficulty
    link.receive({ t: 'rejoined', nextTurn: 5, mode: 'single-player', difficulty: 'hard' });
    expect(session.state.mode).toBe('single-player');
    expect(session.state.difficulty).toBe('hard');

    // Join with botToken
    session.join('sp-123', 'Bot', 'tok-abc');
    expect(link.sent[1]).toEqual({ t: 'join', code: 'SP123', name: 'Bot', botToken: 'tok-abc' });
  });

  test('multiplayer create ignores difficulty option and does not send it on the wire', () => {
    const link = new FakeLink();
    const session = new Session(link);
    session.create('Alice', { mode: 'multiplayer', difficulty: 'hard' });
    expect(link.sent[0]).toEqual({ t: 'create', name: 'Alice', mode: 'multiplayer' });
  });

  test('leave(), finish(), and socket close reset mode, difficulty, and botToken to multiplayer defaults (U04 prep)', () => {
    const link = new FakeLink();
    const session = new Session(link);

    link.receive({
      t: 'lobby',
      code: 'SP123',
      you: 0,
      players: [{ slot: 0, name: 'Alice', ready: false, civ: 1 }],
      settings: DEFAULT_GAME_SETTINGS,
      mode: 'single-player',
      difficulty: 'easy',
      botToken: 'tok-xyz',
    });
    expect(session.state.mode).toBe('single-player');
    expect(session.state.difficulty).toBe('easy');
    expect(session.state.botToken).toBe('tok-xyz');

    session.leave();
    expect(session.state.phase).toBe('idle');
    expect(session.state.mode).toBe('multiplayer');
    expect(session.state.difficulty).toBeUndefined();
    expect(session.state.botToken).toBeUndefined();

    // Repopulate single-player and test finish()
    link.receive({
      t: 'lobby',
      code: 'SP124',
      you: 0,
      players: [{ slot: 0, name: 'Alice', ready: false, civ: 1 }],
      settings: DEFAULT_GAME_SETTINGS,
      mode: 'single-player',
      difficulty: 'medium',
      botToken: 'tok-999',
    });
    session.finish();
    expect(session.state.phase).toBe('ended');
    expect(session.state.mode).toBe('multiplayer');
    expect(session.state.difficulty).toBeUndefined();
    expect(session.state.botToken).toBeUndefined();

    // Repopulate and simulate socket close while in lobby
    link.receive({
      t: 'lobby',
      code: 'SP125',
      you: 0,
      players: [{ slot: 0, name: 'Alice', ready: false, civ: 1 }],
      settings: DEFAULT_GAME_SETTINGS,
      mode: 'single-player',
      difficulty: 'hard',
      botToken: 'tok-777',
    });
    link.close();
    expect(session.state.phase).toBe('idle');
    expect(session.state.mode).toBe('multiplayer');
    expect(session.state.difficulty).toBeUndefined();
    expect(session.state.botToken).toBeUndefined();
    expect(session.state.error?.code).toBe('connection');
  });
});

describe('Session 4-seat capacity, hostSlot, seats, and versions (M05)', () => {
  test('create(name, { capacity: 4 }) defaults versions to DEFAULT_COMPATIBILITY_VERSIONS and uses configured versions when set', () => {
    const link = new FakeLink();
    const session = new Session(link);

    session.create('Alice', { capacity: 4 });
    expect(link.sent[0]).toEqual({
      t: 'create',
      name: 'Alice',
      capacity: 4,
      versions: DEFAULT_COMPATIBILITY_VERSIONS,
    });

    const customVersions: CompatibilityVersions = {
      protocol: 'mp4-v1',
      rules: 'sim-v1',
      build: 'build-123',
      assets: 'assets-456',
    };
    session.setVersions(customVersions);
    session.create('Alice', { capacity: 4 });
    expect(link.sent[1]).toEqual({
      t: 'create',
      name: 'Alice',
      capacity: 4,
      versions: customVersions,
    });

    session.join('mp4-99', 'Bob');
    expect(link.sent[2]).toEqual({
      t: 'join',
      code: 'MP499',
      name: 'Bob',
      versions: customVersions,
    });

    session.setVersions(null);
    session.create('Alice');
    expect(link.sent[3]).toEqual({ t: 'create', name: 'Alice' });
  });

  test('tracks capacity, hostSlot, seats, and versions from lobby/start/rejoined and exposes getLobbyState()', () => {
    const link = new FakeLink();
    const session = new Session(link);
    const seats: RoomSeat[] = [
      { slot: 0, status: 'occupied', name: 'Alice', civ: 1, ready: true },
      { slot: 1, status: 'open', name: null, civ: null, ready: false },
      { slot: 2, status: 'occupied', name: 'Carol', civ: 4, ready: false },
      { slot: 3, status: 'away', name: 'Dave', civ: 7, ready: false },
    ];
    const versions: CompatibilityVersions = {
      protocol: 'mp4-v1',
      rules: 'sim-v1',
      build: 'v2',
      assets: 'pack-2',
    };

    link.receive({
      t: 'lobby',
      code: 'FOUR4',
      you: 2,
      capacity: 4,
      hostSlot: 2,
      seats,
      versions,
      players: [
        { slot: 0, name: 'Alice', civ: 1, ready: true },
        { slot: 2, name: 'Carol', civ: 4, ready: false },
      ],
      settings: DEFAULT_GAME_SETTINGS,
      mode: 'multiplayer',
    });

    const snapshot = session.getLobbyState();
    expect(snapshot.capacity).toBe(4);
    expect(snapshot.hostSlot).toBe(2);
    expect(snapshot.seats).toEqual(seats);
    expect(snapshot.versions).toEqual(versions);

    // Mutating returned snapshot must not mutate internal session state
    snapshot.seats[1]!.status = 'dropped';
    expect(session.state.seats[1]?.status).toBe('open');

    // Ready in capacity 4 room sends compatibility versions
    session.setReady(true);
    expect(link.sent.at(-1)).toEqual({
      t: 'ready',
      ready: true,
      versions: DEFAULT_COMPATIBILITY_VERSIONS,
    });

    // Leave resets capacity, hostSlot, seats, and versions
    session.leave();
    expect(session.state.capacity).toBe(2);
    expect(session.state.hostSlot).toBe(-1);
    expect(session.state.seats).toEqual([]);
    expect(session.state.versions).toBeNull();
  });

  test('legacy lobby snapshot omitting capacity, hostSlot, seats, and versions falls back safely', () => {
    const link = new FakeLink();
    const session = new Session(link);

    link.receive({
      t: 'lobby',
      code: 'LEG22',
      you: 1,
      players: [
        { slot: 0, name: 'Alice', civ: 1, ready: true },
        { slot: 1, name: 'Bob', civ: 2, ready: false },
      ],
      settings: DEFAULT_GAME_SETTINGS,
    });

    expect(session.state.capacity).toBe(2);
    expect(session.state.hostSlot).toBe(0);
    expect(session.state.versions).toBeNull();
    expect(session.state.seats).toEqual([
      { slot: 0, status: 'occupied', name: 'Alice', civ: 1, ready: true },
      { slot: 1, status: 'occupied', name: 'Bob', civ: 2, ready: false },
    ]);
  });
});
