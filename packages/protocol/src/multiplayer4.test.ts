import { describe, expect, test } from 'vitest';
import * as protocol from './index';
import type { ClientMessage, CompatibilityVersions, MatchManifest, RoomSeat, ServerMessage } from './index';

const VERSIONS = { protocol: 'mp4-v1', rules: 'sim-v1', build: 'development', assets: 'development' };
const decode = (message: unknown) => protocol.decodeClientMessage(JSON.stringify(message));

describe('room capacity and stable slot boundaries', () => {
  test('retains omitted legacy capacity and accepts explicit capacities', () => {
    expect(decode({ t: 'create', name: 'Host' })).toEqual({ ok: true, message: { t: 'create', name: 'Host' } });
    for (const capacity of [2, 4]) {
      const message = { t: 'create', name: 'Host', capacity };
      expect(decode(message)).toEqual({ ok: true, message });
    }
    expect(protocol.DEFAULT_ROOM_CAPACITY).toBe(2);
    expect(protocol.MAX_PLAYERS).toBe(4);
  });

  test('accepts only capacity 2 or 4 and keeps single-player at 2', () => {
    for (const capacity of [0, 1, 3, 5, -1, 2.5, '4', null, Number.NaN]) {
      expect(decode({ t: 'create', name: 'Host', capacity }).ok).toBe(false);
    }
    expect(decode({ t: 'create', name: 'Host', mode: 'single-player', capacity: 4 }).ok).toBe(false);
    const message = { t: 'create', name: 'Host', mode: 'single-player', capacity: 2, difficulty: 'easy' };
    expect(decode(message)).toEqual({ ok: true, message });
    expect(protocol.isRoomCapacity(2)).toBe(true);
    expect(protocol.isRoomCapacity(4)).toBe(true);
    expect(protocol.isRoomCapacity('4')).toBe(false);
    expect(protocol.isRoomCapacity(3)).toBe(false);
  });

  test('accepts all four stable slots for rejoin and chat', () => {
    for (const slot of [0, 1, 2, 3]) {
      const message = { t: 'rejoin', code: 'ABCD2', slot, token: 'secret', received: 0 };
      expect(decode(message)).toEqual({ ok: true, message });
    }
    const message = { t: 'chat', text: 'hello', to: [0, 1, 2, 3] };
    expect(decode(message)).toEqual({ ok: true, message });
  });

  test.each([4, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, '3', null])('rejects invalid slot %s', (slot) => {
    expect(decode({ t: 'rejoin', code: 'ABCD2', slot, token: 'secret', received: 0 }).ok).toBe(false);
    expect(decode({ t: 'chat', text: 'hello', to: [slot] }).ok).toBe(false);
  });
  test('rejects more than four recipients', () => {
    expect(decode({ t: 'chat', text: 'hello', to: [0, 1, 2, 3, 0] }).ok).toBe(false);
  });
});

describe('compatibility handshake', () => {
  test('exports a frozen compatibility default and compares every identifier', () => {
    expect(protocol.DEFAULT_COMPATIBILITY_VERSIONS).toEqual(VERSIONS);
    expect(Object.isFrozen(protocol.DEFAULT_COMPATIBILITY_VERSIONS)).toBe(true);
    expect(protocol.sameCompatibilityVersions(VERSIONS, { ...VERSIONS })).toBe(true);
    for (const key of ['protocol', 'rules', 'build', 'assets'] as const) {
      expect(protocol.sameCompatibilityVersions(VERSIONS, { ...VERSIONS, [key]: 'other' })).toBe(false);
    }
  });

  test('validates complete nonempty bounded string identifiers', () => {
    expect(protocol.isCompatibilityVersions(VERSIONS)).toBe(true);
    expect(protocol.isCompatibilityVersions({ ...VERSIONS, assets: 'x'.repeat(128) })).toBe(true);
    for (const value of [null, [], 'version', {}, { ...VERSIONS, assets: undefined }]) {
      expect(protocol.isCompatibilityVersions(value)).toBe(false);
    }
    for (const key of ['protocol', 'rules', 'build', 'assets']) {
      for (const value of ['', 'x'.repeat(129), 1, null, false]) {
        expect(protocol.isCompatibilityVersions({ ...VERSIONS, [key]: value })).toBe(false);
      }
    }
  });

  test.each([
    { t: 'create', name: 'Host', capacity: 4 },
    { t: 'join', code: 'ABCD2', name: 'Guest' },
    { t: 'ready', ready: true },
    { t: 'ready', ready: false },
  ])('round-trips versions on $t and strips unknown fields', (base) => {
    const message = { ...base, versions: VERSIONS };
    expect(decode(message)).toEqual({ ok: true, message });
    expect(decode({ ...base, extra: 'ignored', versions: { ...VERSIONS, secret: 'ignored' } })).toEqual({ ok: true, message });
  });

  test.each([
    { t: 'create', name: 'Host' },
    { t: 'join', code: 'ABCD2', name: 'Guest' },
    { t: 'ready', ready: true },
  ])('rejects malformed versions on $t', (base) => {
    for (const versions of [null, {}, [], 'mp4-v1', { ...VERSIONS, build: '' }, { ...VERSIONS, protocol: 'x'.repeat(129) }]) {
      expect(decode({ ...base, versions }).ok).toBe(false);
    }
  });
});

describe('match result report', () => {
  test.each([
    { t: 'result', turn: 0, hash: 0, winners: [] },
    { t: 'result', turn: Number.MAX_SAFE_INTEGER, hash: 0xffffffff, winners: [4] },
    { t: 'result', turn: 128, hash: 0xdeadbeef, winners: [3, 1, 4, 2] },
  ])('round-trips legal result without changing winner order', (message) => {
    expect(decode(message)).toEqual({ ok: true, message });
    expect(decode({ ...message, extra: true })).toEqual({ ok: true, message });
  });

  test('rejects invalid report boundaries and duplicate or non-player winners', () => {
    const base = { t: 'result', turn: 0, hash: 0, winners: [1] };
    for (const turn of [-1, 0.5, Number.MAX_SAFE_INTEGER + 1, null, '0']) expect(decode({ ...base, turn }).ok).toBe(false);
    for (const hash of [-1, 0x100000000, 0.5, null, '0']) expect(decode({ ...base, hash }).ok).toBe(false);
    for (const winners of [undefined, null, 1, [0], [5], [-1], [1.5], ['1'], [1, 1], [1, 2, 3, 4, 1], [Number.NaN]]) {
      expect(decode({ ...base, winners }).ok).toBe(false);
    }
  });
});

test('typed metadata and completed result round-trip through trusted server decoder', () => {
  const versions: CompatibilityVersions = VERSIONS;
  const seats: RoomSeat[] = [
    { slot: 0, status: 'open', name: null, civ: null, ready: false },
    { slot: 1, status: 'away', name: 'One', civ: 1, ready: true },
    { slot: 2, status: 'resigned', name: 'Two', civ: 2, ready: false },
    { slot: 3, status: 'dropped', name: 'Three', civ: 3, ready: false },
  ];
  const players = [0, 1, 2, 3].map((slot) => ({ slot, name: `Player ${slot}`, ready: true, civ: slot + 1 }));
  const manifest: MatchManifest = {
    code: 'ABCD2', capacity: 4, mode: 'multiplayer', hostSlot: 1,
    players: players.map(({ slot, name, civ }) => ({ slot, name, civ, playerId: slot + 1 })),
    seed: 42, settings: protocol.DEFAULT_GAME_SETTINGS, versions,
  };
  const messages: ServerMessage[] = [
    { t: 'lobby', code: 'ABCD2', you: 3, players, settings: protocol.DEFAULT_GAME_SETTINGS, capacity: 4, hostSlot: 1, seats, versions },
    { t: 'start', seed: 42, commandDelay: 2, players, settings: protocol.DEFAULT_GAME_SETTINGS, token: 'secret', capacity: 4, hostSlot: 1, manifest, versions },
    { t: 'rejoined', nextTurn: 6, capacity: 4, hostSlot: 1, manifest, versions },
    { t: 'ended', reason: 'completed', result: { turn: 128, hash: 0, winners: [4] } },
    { t: 'error', code: 'version-mismatch', message: 'different rules' },
    { t: 'error', code: 'bad-result', message: 'different results' },
  ];
  const clients: ClientMessage[] = [
    { t: 'create', name: 'Host', capacity: 4, versions },
    { t: 'join', code: 'ABCD2', name: 'Guest', versions },
    { t: 'ready', ready: true, versions },
    { t: 'result', turn: 128, hash: 0, winners: [] },
  ];
  for (const message of messages) expect(protocol.decodeServerMessage(protocol.encode(message))).toEqual({ ok: true, message });
  for (const message of clients) expect(decode(message)).toEqual({ ok: true, message });
});
