import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { WebSocket } from 'ws';
import { DEFAULT_COMPATIBILITY_VERSIONS, CODE_LENGTH, DROP_AFTER_MS, isValidCode, type ClientMessage, type ServerMessage } from '@aoe/protocol';
import { createApp } from './app';
import { PING_INTERVAL_MS, RoomRegistry, type Peer } from './rooms';

const WAIT_MS = 15_000;

/** A ws client that queues server messages so tests can await them in order. Pings are left unanswered and skipped. */
class TestClient {
  private readonly queue: ServerMessage[] = [];
  private waiter: ((m: ServerMessage) => void) | undefined;
  private constructor(readonly socket: WebSocket) {
    socket.on('message', (data) => {
      const message = JSON.parse(data.toString()) as ServerMessage;
      if (message.t === 'ping') return;
      if (this.waiter) {
        const w = this.waiter;
        this.waiter = undefined;
        w(message);
      } else this.queue.push(message);
    });
  }

  static async connect(port: number): Promise<TestClient> {
    const socket = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    await new Promise((resolve, reject) => {
      socket.once('open', resolve);
      socket.once('error', reject);
    });
    return new TestClient(socket);
  }

  send(message: ClientMessage | { t: string; [k: string]: unknown }): void {
    this.socket.send(JSON.stringify(message));
  }

  next(): Promise<ServerMessage> {
    const queued = this.queue.shift();
    if (queued) return Promise.resolve(queued);
    return new Promise((resolve, reject) => {
      // Only a hung relay reaches this; a loaded machine takes seconds to schedule the server and the client.
      const timer = setTimeout(() => reject(new Error('timed out waiting for a server message')), WAIT_MS);
      this.waiter = (m) => {
        clearTimeout(timer);
        resolve(m);
      };
    });
  }

  async expect<T extends ServerMessage['t']>(t: T): Promise<Extract<ServerMessage, { t: T }>> {
    const m = await this.next();
    expect(m.t).toBe(t);
    return m as Extract<ServerMessage, { t: T }>;
  }

  /**
   * Assert nothing else is on its way. The relay answers a socket's messages in order, so a malformed frame's error
   * arriving with nothing queued before it means the relay had nothing more to send this client (no fixed sleep).
   */
  async expectSilence(): Promise<void> {
    this.socket.send('{nope');
    const m = await this.next();
    expect(this.queue).toEqual([]);
    expect(m).toMatchObject({ t: 'error', code: 'bad-message' });
  }

  close(): void {
    this.socket.close();
  }

  /** Break the socket without a close frame, as a lost connection does (the server sees 1006). */
  terminate(): void {
    this.socket.terminate();
  }
}

let server: Server;
let rooms: RoomRegistry;
let port: number;
let clients: TestClient[];

async function connect(): Promise<TestClient> {
  const c = await TestClient.connect(port);
  clients.push(c);
  return c;
}

beforeEach(async () => {
  let civ = 0;
  rooms = new RoomRegistry({ generateSeed: () => 1234, generateCiv: () => (civ++ % 2) + 5 });
  server = createApp({ rooms });
  await new Promise<void>((resolve) => server.listen(0, resolve));
  port = (server.address() as AddressInfo).port;
  clients = [];
});

afterEach(async () => {
  for (const c of clients) c.close();
  await new Promise((resolve) => server.close(resolve));
});

/** Host creates, guest joins by code; both drained to the post-join lobby. */
async function pair(): Promise<{ host: TestClient; guest: TestClient; code: string }> {
  const host = await connect();
  const guest = await connect();
  host.send({ t: 'create', name: 'Host' });
  const { code } = await host.expect('lobby');
  guest.send({ t: 'join', code, name: 'Guest' });
  await guest.expect('lobby');
  await host.expect('lobby');
  return { host, guest, code };
}

async function startGame(host: TestClient, guest: TestClient): Promise<string[]> {
  host.send({ t: 'ready', ready: true });
  guest.send({ t: 'ready', ready: true });
  await host.expect('lobby');
  await host.expect('lobby');
  await guest.expect('lobby');
  await guest.expect('lobby');
  host.send({ t: 'start' });
  return [(await host.expect('start')).token, (await guest.expect('start')).token];
}

describe('rooms', () => {
  test('create returns a short invite code and the guest joins by it', async () => {
    const host = await connect();
    const guest = await connect();
    host.send({ t: 'create', name: 'Eric' });
    const created = await host.expect('lobby');
    expect(created.code).toHaveLength(CODE_LENGTH);
    expect(isValidCode(created.code)).toBe(true);
    expect(created.you).toBe(0);
    expect(created.players).toEqual([{ slot: 0, name: 'Eric', ready: false, civ: 5 }]);
    expect(created.settings).toEqual({ deathMatch: false, startingAge: 0, resources: 0, revealMap: false, fullTechTree: false, mapType: 3, mapSize: 144, victory: { type: 0 }, populationLimit: 50, pathFinding: 0, fixedPositions: true, cheating: false });

    // Lower-case and dashes are accepted.
    guest.send({ t: 'join', code: created.code.toLowerCase().replace(/^(..)/, '$1-'), name: 'Bao' });
    const joined = await guest.expect('lobby');
    expect(joined.you).toBe(1);
    expect(joined.players.map((p) => p.name)).toEqual(['Eric', 'Bao']);
    const hostView = await host.expect('lobby');
    expect(hostView.you).toBe(0);
    expect(hostView.players).toHaveLength(2);
  });

  test('bad invite code is rejected', async () => {
    const c = await connect();
    c.send({ t: 'join', code: 'ZZZZZ', name: 'x' });
    expect((await c.expect('error')).code).toBe('bad-code');
    c.send({ t: 'join', code: 'nonsense!!', name: 'x' });
    expect((await c.expect('error')).code).toBe('bad-code');
  });

  test('third client is rejected with room-full and the room is unharmed', async () => {
    const { host, guest, code } = await pair();
    const third = await connect();
    third.send({ t: 'join', code, name: 'Third' });
    expect((await third.expect('error')).code).toBe('room-full');
    await host.expectSilence();
    await guest.expectSilence();
    expect(rooms.rooms.get(code)?.members).toHaveLength(2);
  });

  test('start needs the host and both players ready', async () => {
    const { host, guest } = await pair();
    host.send({ t: 'start' });
    expect((await host.expect('error')).code).toBe('not-ready');
    host.send({ t: 'ready', ready: true });
    guest.send({ t: 'ready', ready: true });
    for (const c of [host, guest]) {
      await c.expect('lobby');
      await c.expect('lobby');
    }
    guest.send({ t: 'start' });
    expect((await guest.expect('error')).code).toBe('not-host');
    host.send({ t: 'start' });
    const start = await host.expect('start');
    expect(start).toMatchObject({ seed: 1234, commandDelay: 2 });
    await guest.expect('start');
  });

  test('the host sets map and victory, each player its civ, both see them and the start carries them', async () => {
    const { host, guest } = await pair();
    const settings = { deathMatch: true, mapType: 7, mapSize: 96, victory: { type: 2, amount: 5000 }, startingAge: 4, resources: 0, revealMap: true, fullTechTree: true, populationLimit: 125, pathFinding: 1, fixedPositions: false, cheating: true };
    guest.send({ t: 'settings', settings });
    expect((await guest.expect('error')).code).toBe('not-host');
    host.send({ t: 'settings', settings });
    for (const c of [host, guest]) expect((await c.expect('lobby')).settings).toEqual(settings);
    guest.send({ t: 'civ', civ: 17 });
    for (const c of [host, guest]) expect((await c.expect('lobby')).players.map((p) => p.civ)).toEqual([5, 17]);
    host.send({ t: 'civ', civ: 10 });
    for (const c of [host, guest]) expect((await c.expect('lobby')).players.map((p) => p.civ)).toEqual([10, 17]);
    // Ready locks the player's civ, and the host's settings (scr_mps.cpp fillPlayers, action).
    host.send({ t: 'ready', ready: true });
    for (const c of [host, guest]) await c.expect('lobby');
    host.send({ t: 'civ', civ: 1 });
    expect((await host.expect('error')).code).toBe('locked');
    host.send({ t: 'settings', settings: { deathMatch: false, startingAge: 0, resources: 0, revealMap: false, fullTechTree: false, mapType: 3, mapSize: 144, victory: { type: 0 }, populationLimit: 50, pathFinding: 0, fixedPositions: true, cheating: false } });
    expect((await host.expect('error')).code).toBe('locked');
    guest.send({ t: 'ready', ready: true });
    for (const c of [host, guest]) await c.expect('lobby');
    host.send({ t: 'start' });
    for (const c of [host, guest]) {
      const start = await c.expect('start');
      expect(start.settings).toEqual(settings);
      expect(start.players.map((p) => p.civ)).toEqual([10, 17]);
    }
  });

  test('settings the sim cannot play are refused by the codec', async () => {
    const { host } = await pair();
    host.send({ t: 'settings', settings: { deathMatch: false, startingAge: 0, resources: 0, revealMap: false, fullTechTree: false, mapType: 9, mapSize: 144, victory: { type: 0 }, populationLimit: 50, pathFinding: 0, fixedPositions: true, cheating: false } });
    expect((await host.expect('error')).code).toBe('bad-message');
    host.send({ t: 'civ', civ: 0 });
    expect((await host.expect('error')).code).toBe('bad-message');
  });

  test('joining a started game is rejected', async () => {
    const { host, guest, code } = await pair();
    await startGame(host, guest);
    const late = await connect();
    late.send({ t: 'join', code, name: 'Late' });
    expect((await late.expect('error')).code).toBe('room-started');
  });

  test('malformed frame and messages outside a room are rejected', async () => {
    const c = await connect();
    c.socket.send('{nope');
    expect((await c.expect('error')).code).toBe('bad-message');
    c.send({ t: 'turn', turn: 0, commands: [] });
    expect((await c.expect('error')).code).toBe('not-in-room');
  });

  test('host leaving the lobby promotes the guest and drops readiness', async () => {
    const { host, guest, code } = await pair();
    host.send({ t: 'leave' });
    const lobby = await guest.expect('lobby');
    expect(lobby.you).toBe(1);
    expect(lobby.hostSlot).toBe(1);
    expect(lobby.players).toEqual([{ slot: 1, name: 'Guest', ready: false, civ: 6 }]);
    guest.send({ t: 'leave' });
    await guest.expectSilence();
    expect(rooms.rooms.has(code)).toBe(false);
  });
});

describe('chat', () => {
  test('a chat message goes to the players it names, in the lobby and in the game, never into a turn', async () => {
    const { host, guest, code } = await pair();
    host.send({ t: 'chat', text: 'hello', to: [0, 1] });
    expect(await guest.next()).toEqual({ t: 'chat', from: 0, text: 'hello' });
    // Not to the sender (it shows its own copy), nor to a player left out.
    guest.send({ t: 'chat', text: 'just me', to: [1] });
    host.send({ t: 'chat', text: 'nobody', to: [0] });
    await host.expectSilence();
    await guest.expectSilence();

    await startGame(host, guest);
    guest.send({ t: 'chat', text: 'gl hf', to: [0, 1] });
    expect(await host.next()).toEqual({ t: 'chat', from: 1, text: 'gl hf' });
    host.send({ t: 'turn', turn: 0, commands: [] });
    guest.send({ t: 'turn', turn: 0, commands: [] });
    expect(await host.expect('turn')).toMatchObject({ batches: [{ slot: 0, commands: [] }, { slot: 1, commands: [] }] });
    expect(rooms.rooms.get(code)?.log).toHaveLength(1);
  });
});

describe('turn relay', () => {
  test('both clients receive turns in order, batches ordered by slot', async () => {
    const { host, guest, code } = await pair();
    await startGame(host, guest);

    // Guest runs ahead; nothing is released until the host submits the same turn.
    guest.send({ t: 'turn', turn: 0, commands: [{ type: 'noop' }] });
    guest.send({ t: 'turn', turn: 1, commands: [] });
    await host.expectSilence();
    host.send({ t: 'turn', turn: 0, commands: [] });
    host.send({ t: 'turn', turn: 1, commands: [{ type: 'test', x: 3, y: 4 }] });

    const expected = [
      {
        t: 'turn',
        turn: 0,
        batches: [
          { slot: 0, commands: [] },
          { slot: 1, commands: [{ type: 'noop' }] },
        ],
        frameMs: [0, 0],
      },
      {
        t: 'turn',
        turn: 1,
        batches: [
          { slot: 0, commands: [{ type: 'test', x: 3, y: 4 }] },
          { slot: 1, commands: [] },
        ],
        frameMs: [0, 0],
      },
    ];
    for (const c of [host, guest]) {
      expect(await c.next()).toEqual(expected[0]);
      expect(await c.next()).toEqual(expected[1]);
    }
    expect(rooms.rooms.get(code)?.log).toEqual(expected.map(({ turn, batches }) => ({ turn, batches })));
  });

  test('out-of-order and premature turns are rejected', async () => {
    const { host, guest } = await pair();
    host.send({ t: 'turn', turn: 0, commands: [] });
    expect((await host.expect('error')).code).toBe('not-started');
    await startGame(host, guest);
    host.send({ t: 'turn', turn: 1, commands: [] });
    expect((await host.expect('error')).code).toBe('bad-turn');
    host.send({ t: 'turn', turn: 0, commands: [] });
    host.send({ t: 'turn', turn: 0, commands: [] });
    expect((await host.expect('error')).code).toBe('bad-turn');
  });

  test('a player may not run unboundedly ahead', async () => {
    const { host, guest } = await pair();
    await startGame(host, guest);
    for (let turn = 0; turn < 64; turn++) host.send({ t: 'turn', turn, commands: [] });
    host.send({ t: 'turn', turn: 64, commands: [] });
    expect((await host.expect('error')).code).toBe('bad-turn');
  });

  test('matching hashes stay quiet, mismatched hashes report desync to both', async () => {
    const { host, guest, code } = await pair();
    await startGame(host, guest);
    for (const c of [host, guest]) c.send({ t: 'turn', turn: 0, commands: [] });
    await host.expect('turn');
    await guest.expect('turn');

    host.send({ t: 'hash', turn: 0, hash: 7 });
    guest.send({ t: 'hash', turn: 0, hash: 7 });
    await host.expectSilence();

    for (const c of [host, guest]) c.send({ t: 'turn', turn: 1, commands: [] });
    await host.expect('turn');
    await guest.expect('turn');
    host.send({ t: 'hash', turn: 1, hash: 7 });
    guest.send({ t: 'hash', turn: 1, hash: 8 });
    expect(await host.next()).toEqual({ t: 'desync', turn: 1, hashes: [7, 8] });
    expect(await guest.next()).toEqual({ t: 'desync', turn: 1, hashes: [7, 8] });
    expect(rooms.rooms.get(code)?.desyncs).toEqual([1]);
  });

  test('hashes sent before their turn is released, as the client sends them, are held and compared', async () => {
    const { host, guest, code } = await pair();
    await startGame(host, guest);
    // Lockstep.endTurn: the hash of turn N goes out just before the batch of turn N.
    host.send({ t: 'hash', turn: 0, hash: 7 });
    host.send({ t: 'turn', turn: 0, commands: [] });
    guest.send({ t: 'hash', turn: 0, hash: 7 });
    guest.send({ t: 'turn', turn: 0, commands: [] });
    expect((await host.expect('turn')).turn).toBe(0);
    expect((await guest.expect('turn')).turn).toBe(0);
    await host.expectSilence();
    expect(rooms.rooms.get(code)?.desyncs).toEqual([]);

    host.send({ t: 'hash', turn: 1, hash: 7 });
    host.send({ t: 'turn', turn: 1, commands: [] });
    guest.send({ t: 'hash', turn: 1, hash: 8 });
    guest.send({ t: 'turn', turn: 1, commands: [] });
    expect(await host.next()).toEqual({ t: 'desync', turn: 1, hashes: [7, 8] });
    expect(await guest.next()).toEqual({ t: 'desync', turn: 1, hashes: [7, 8] });
    expect(rooms.rooms.get(code)?.desyncs).toEqual([1]);
  });

  test('a hash for a turn the player has not run yet is refused', async () => {
    const { host, guest } = await pair();
    await startGame(host, guest);
    host.send({ t: 'hash', turn: 1, hash: 7 });
    expect((await host.expect('error')).code).toBe('bad-turn');
  });

  test('a player leaving a started game resigns its seat while the other keeps playing', async () => {
    const { host, guest, code } = await pair();
    await startGame(host, guest);
    guest.send({ t: 'leave' });
    await guest.expectSilence();
    host.send({ t: 'turn', turn: 0, commands: [] });
    expect(await host.expect('turn')).toEqual({ t: 'turn', turn: 0, batches: [{ slot: 0, commands: [] }, { slot: 1, commands: [{ type: 'resign' }] }], frameMs: [0, 0] });
    host.send({ t: 'turn', turn: 1, commands: [] });
    expect(await host.expect('turn')).toEqual({ t: 'turn', turn: 1, batches: [{ slot: 0, commands: [] }, { slot: 1, commands: [] }], frameMs: [0, 0] });
    await host.expectSilence();
    expect(rooms.rooms.has(code)).toBe(true);
    host.send({ t: 'leave' }); await host.expectSilence(); expect(rooms.rooms.has(code)).toBe(false);
  });

  test('a player who resigned leaves without ending the game: the server fills its batches', async () => {
    const { host, guest, code } = await pair();
    await startGame(host, guest);
    guest.send({ t: 'turn', turn: 0, commands: [{ type: 'resign' }] });
    guest.send({ t: 'leave' });
    host.send({ t: 'turn', turn: 0, commands: [] });
    expect(await host.expect('turn')).toEqual({ t: 'turn', turn: 0, batches: [{ slot: 0, commands: [] }, { slot: 1, commands: [{ type: 'resign' }] }], frameMs: [0, 0] });
    host.send({ t: 'turn', turn: 1, commands: [] });
    expect(await host.expect('turn')).toEqual({ t: 'turn', turn: 1, batches: [{ slot: 0, commands: [] }, { slot: 1, commands: [] }], frameMs: [0, 0] });
    expect(rooms.rooms.get(code)?.members.map((m) => m.dropped)).toEqual([false, true]);
    host.close();
    await guest.expectSilence();
  });
});

describe('rejoin', () => {
  test('a broken socket keeps its slot: the player rejoins with its token, gets the turns it missed and goes on', async () => {
    const { host, guest, code } = await pair();
    const [, token] = await startGame(host, guest);
    expect(token).toMatch(/^[0-9a-f]{32}$/);
    for (const c of [host, guest]) c.send({ t: 'turn', turn: 0, commands: [] });
    await host.expect('turn');
    await guest.expect('turn');
    // Turn 1 is released while the guest's socket is broken: it sent its batch just before.
    guest.send({ t: 'turn', turn: 1, commands: [{ type: 'noop' }] });
    host.send({ t: 'turn', turn: 1, commands: [] });
    expect((await host.expect('turn')).turn).toBe(1);
    guest.terminate();
    host.send({ t: 'turn', turn: 2, commands: [] });
    await host.expectSilence();

    const wrong = await connect();
    wrong.send({ t: 'rejoin', code, slot: 1, token: 'nope', received: 1 });
    expect((await wrong.expect('error')).code).toBe('bad-rejoin');

    const back = await connect();
    back.send({ t: 'rejoin', code: code.toLowerCase(), slot: 1, token: token!, received: 1 });
    expect(await back.next()).toEqual({ t: 'rejoined', nextTurn: 2, mode: 'multiplayer', capacity: 2, hostSlot: 0, versions: DEFAULT_COMPATIBILITY_VERSIONS, manifest: rooms.rooms.get(code)!.manifest });
    expect(await back.next()).toEqual({ t: 'turn', turn: 1, batches: [{ slot: 0, commands: [] }, { slot: 1, commands: [{ type: 'noop' }] }] });
    expect((await back.expect('rtt')).rtt).toHaveLength(2);
    back.send({ t: 'turn', turn: 2, commands: [] });
    expect((await host.expect('turn')).turn).toBe(2);
    expect((await back.expect('turn')).turn).toBe(2);
    expect(rooms.rooms.get(code)?.members.map((m) => m.dropped)).toEqual([false, false]);
  });
});

describe('speed control', () => {
  class FakePeer implements Peer {
    messages: ServerMessage[] = [];
    send(m: ServerMessage): void {
      this.messages.push(m);
    }
    take<T extends ServerMessage['t']>(t: T): Extract<ServerMessage, { t: T }>[] {
      const out = this.messages.filter((m): m is Extract<ServerMessage, { t: T }> => m.t === t);
      this.messages = this.messages.filter((m) => m.t !== t);
      return out;
    }
  }

  function started(now: () => number) {
    const registry = new RoomRegistry({ generateSeed: () => 1, now });
    const peers = [new FakePeer(), new FakePeer()];
    registry.handle(peers[0]!, { t: 'create', name: 'A' });
    const code = peers[0]!.take('lobby')[0]!.code;
    registry.handle(peers[1]!, { t: 'join', code, name: 'B' });
    for (const p of peers) registry.handle(p, { t: 'ready', ready: true });
    registry.handle(peers[0]!, { t: 'start' });
    return { registry, peers, room: registry.rooms.get(code)! };
  }

  test('pings each player at start and every 8 s, and reports the round trips to both', () => {
    let clock = 1000;
    const { registry, peers } = started(() => clock);
    const pings = peers.map((p) => p.take('ping'));
    expect(pings).toEqual([[{ t: 'ping', n: 1 }], [{ t: 'ping', n: 1 }]]);
    clock += 12;
    registry.handle(peers[0]!, { t: 'pong', n: 1 });
    clock += 30;
    registry.handle(peers[1]!, { t: 'pong', n: 1 });
    expect(peers[0]!.take('rtt')).toEqual([{ t: 'rtt', rtt: [12, 0], frameMs: [0, 0] }, { t: 'rtt', rtt: [12, 42], frameMs: [0, 0] }]);
    clock += PING_INTERVAL_MS;
    registry.handle(peers[1]!, { t: 'hash', turn: 0, hash: 0 });
    expect(peers[1]!.take('ping')).toEqual([{ t: 'ping', n: 2 }]);
    expect(peers[0]!.take('ping')).toEqual([]);
  });

  test("the round trips go out with each player's last reported frame time", () => {
    let clock = 1000;
    const { registry, peers } = started(() => clock);
    registry.handle(peers[0]!, { t: 'turn', turn: 0, commands: [], frameMs: 17 });
    registry.handle(peers[1]!, { t: 'turn', turn: 0, commands: [], frameMs: 120 });
    clock += 25;
    registry.handle(peers[1]!, { t: 'pong', n: 1 });
    expect(peers[0]!.take('rtt')).toEqual([{ t: 'rtt', rtt: [0, 25], frameMs: [17, 120] }]);
  });

  test("each released turn carries every player's last reported frame time", () => {
    const { registry, peers } = started(() => 1000);
    registry.handle(peers[0]!, { t: 'turn', turn: 0, commands: [], frameMs: 17 });
    registry.handle(peers[1]!, { t: 'turn', turn: 0, commands: [], frameMs: 120 });
    expect(peers[0]!.take('turn').map((m) => (m.t === 'turn' ? m.frameMs : null))).toEqual([[17, 120]]);
    registry.handle(peers[0]!, { t: 'turn', turn: 1, commands: [], frameMs: 17 });
    registry.handle(peers[1]!, { t: 'turn', turn: 1, commands: [], frameMs: 150 });
    expect(peers[1]!.take('turn').map((m) => (m.t === 'turn' ? m.frameMs : null))).toEqual([[17, 120], [17, 150]]);
  });

  test('a player away DROP_AFTER_MS after it was last heard is dropped: its next batch resigns it, then empty ones', () => {
    let clock = 0;
    const timers: { fn: () => void; at: number }[] = [];
    const registry = new RoomRegistry({ generateSeed: () => 1, now: () => clock, generateToken: () => 't', schedule: (fn, ms) => {
      const timer = { fn, at: clock + ms };
      timers.push(timer);
      return () => timers.splice(timers.indexOf(timer), 1);
    } });
    const peers = [new FakePeer(), new FakePeer()];
    registry.handle(peers[0]!, { t: 'create', name: 'A' });
    const code = peers[0]!.take('lobby')[0]!.code;
    registry.handle(peers[1]!, { t: 'join', code, name: 'B' });
    for (const p of peers) registry.handle(p, { t: 'ready', ready: true });
    registry.handle(peers[0]!, { t: 'start' });
    registry.handle(peers[1]!, { t: 'turn', turn: 0, commands: [] });
    clock = 500;
    registry.disconnect(peers[1]!, true);
    expect(timers.map((t) => t.at)).toEqual([DROP_AFTER_MS]);
    registry.handle(peers[0]!, { t: 'turn', turn: 0, commands: [] });
    registry.handle(peers[0]!, { t: 'turn', turn: 1, commands: [] });
    expect(peers[0]!.take('turn').map((m) => m.turn)).toEqual([0]);
    clock = DROP_AFTER_MS;
    timers[0]!.fn();
    expect(peers[0]!.take('dropped')).toEqual([{ t: 'dropped', slot: 1 }]);
    registry.handle(peers[0]!, { t: 'turn', turn: 2, commands: [] });
    expect(peers[0]!.take('turn').map((m) => m.batches[1])).toEqual([
      { slot: 1, commands: [{ type: 'resign' }] },
      { slot: 1, commands: [] },
    ]);
    const late = new FakePeer();
    registry.handle(late, { t: 'rejoin', code, slot: 1, token: 't', received: 0 });
    expect(late.take('error')).toMatchObject([{ code: 'bad-rejoin' }]);
    // Its hashes are no longer awaited.
    registry.handle(peers[0]!, { t: 'hash', turn: 2, hash: 5 });
    expect(peers[0]!.take('desync')).toEqual([]);
  });

  test('a room whose players are all away is closed when the first drop falls due', () => {
    const timers: (() => void)[] = [];
    const registry = new RoomRegistry({ generateSeed: () => 1, now: () => 0, schedule: (fn) => (timers.push(fn), () => undefined) });
    const peers = [new FakePeer(), new FakePeer()];
    registry.handle(peers[0]!, { t: 'create', name: 'A' });
    const code = peers[0]!.take('lobby')[0]!.code;
    registry.handle(peers[1]!, { t: 'join', code, name: 'B' });
    for (const p of peers) registry.handle(p, { t: 'ready', ready: true });
    registry.handle(peers[0]!, { t: 'start' });
    for (const p of peers) registry.disconnect(p, true);
    timers[0]!();
    expect(registry.rooms.has(code)).toBe(false);
  });

  test('the change agreed at boundary T rides on the release of turn T - 1, for turn T + 2', () => {
    const clock = 0;
    const { registry, peers, room } = started(() => clock);
    for (const p of peers) registry.handle(p, { t: 'pong', n: 1 });
    for (let turn = 0; turn < 40; turn++) {
      for (const p of peers) registry.handle(p, { t: 'turn', turn, commands: [], frameMs: 17 });
    }
    // Example 7.4: boundaries 22 and 28 (releases of turns 21 and 27).
    expect(room.log.filter((r) => r.speed)).toEqual([
      { turn: 21, batches: expect.any(Array), speed: { turn: 24, granularity: 20, frames: 9 } },
      { turn: 27, batches: expect.any(Array), speed: { turn: 30, granularity: 20, frames: 13 } },
    ]);
    expect(peers[1]!.take('turn').filter((m) => m.speed).map((m) => m.speed!.turn)).toEqual([24, 30]);
  });
});

describe('room mode and single-player control (C01-C03)', () => {
  test('C01: multiplayer is default and spoofing Computer name or difficulty does not grant single-player', async () => {
    const host = await connect();
    const guest = await connect();
    host.send({ t: 'create', name: 'Computer (Hard)' });
    const hostLobby = await host.expect('lobby');
    expect(hostLobby.mode).toBe('multiplayer');
    expect(hostLobby.difficulty).toBeUndefined();
    expect(hostLobby.botToken).toBeUndefined();

    guest.send({ t: 'join', code: hostLobby.code, name: 'Computer', botToken: 'forged-token' });
    const guestLobby = await guest.expect('lobby');
    const updatedHost = await host.expect('lobby');
    expect(guestLobby.mode).toBe('multiplayer');
    expect(guestLobby.difficulty).toBeUndefined();
    expect(guestLobby.botToken).toBeUndefined();
    expect(updatedHost.mode).toBe('multiplayer');

    const room = rooms.rooms.get(hostLobby.code)!;
    expect(room.mode).toBe('multiplayer');
    expect(room.difficulty).toBeUndefined();
    expect(room.botToken).toBeUndefined();

    // Direct registry create with mode:'multiplayer' + difficulty:'hard' stays multiplayer with no difficulty
    const host2 = await connect();
    host2.send({ t: 'create', name: 'Alice', mode: 'multiplayer', difficulty: 'hard' });
    const lobby2 = await host2.expect('lobby');
    expect(lobby2.mode).toBe('multiplayer');
    expect(lobby2.difficulty).toBeUndefined();
    expect(lobby2.botToken).toBeUndefined();
  });

  test('C01/C03: single-player issues botToken only to slot 0 host and protects slot 1 from unauthorized join', async () => {
    const host = await connect();
    const intruder = await connect();
    const emptyToken = await connect();
    const bot = await connect();

    host.send({ t: 'create', name: 'Human', mode: 'single-player', difficulty: 'hard' });
    const created = await host.expect('lobby');
    expect(created.mode).toBe('single-player');
    expect(created.difficulty).toBe('hard');
    expect(created.botToken).toMatch(/^[0-9a-f]{32}$/);

    // Host readies up before bot joins; failed joins must not disturb host or room
    host.send({ t: 'ready', ready: true });
    await host.expect('lobby');

    intruder.send({ t: 'join', code: created.code, name: 'Computer (Hard)' });
    expect((await intruder.expect('error')).code).toBe('unauthorized');

    emptyToken.send({ t: 'join', code: created.code, name: 'Computer (Hard)', botToken: '' });
    expect((await emptyToken.expect('error')).code).toBe('unauthorized');

    intruder.send({ t: 'join', code: created.code, name: 'Computer (Hard)', botToken: 'wrong-token' });
    expect((await intruder.expect('error')).code).toBe('unauthorized');

    await host.expectSilence();
    const room = rooms.rooms.get(created.code)!;
    expect(room.members).toHaveLength(1);
    expect(room.members[0]!.ready).toBe(true);
    // Rejected peers were not added to byPeer and can create their own rooms cleanly
    expect(rooms.roomOf(intruder as unknown as Peer)).toBeUndefined();

    // Bot joins with valid botToken; bot does NOT receive botToken in lobby message
    bot.send({ t: 'join', code: created.code, name: 'Computer (Hard)', botToken: created.botToken });
    const botLobby = await bot.expect('lobby');
    const hostLobby = await host.expect('lobby');
    expect(botLobby.you).toBe(1);
    expect(botLobby.mode).toBe('single-player');
    expect(botLobby.difficulty).toBe('hard');
    expect(botLobby.botToken).toBeUndefined();
    expect(hostLobby.you).toBe(0);
    expect(hostLobby.botToken).toBe(created.botToken);
  });

  test('C02: single-player defaults difficulty to medium when omitted and preserves mode/difficulty across start and rejoin', async () => {
    const host = await connect();
    const bot = await connect();

    host.send({ t: 'create', name: 'Human', mode: 'single-player' });
    const created = await host.expect('lobby');
    expect(created.mode).toBe('single-player');
    expect(created.difficulty).toBe('medium');
    expect(created.botToken).toBeTruthy();

    bot.send({ t: 'join', code: created.code, name: 'Bot', botToken: created.botToken });
    await bot.expect('lobby');
    await host.expect('lobby');

    host.send({ t: 'ready', ready: true });
    bot.send({ t: 'ready', ready: true });
    for (const c of [host, bot]) {
      await c.expect('lobby');
      await c.expect('lobby');
    }

    host.send({ t: 'start' });
    const hostStart = await host.expect('start');
    const botStart = await bot.expect('start');
    expect(hostStart.mode).toBe('single-player');
    expect(hostStart.difficulty).toBe('medium');
    expect(botStart.mode).toBe('single-player');
    expect(botStart.difficulty).toBe('medium');

    // Run turn 0, then disconnect host and rejoin -> mode & difficulty preserved
    host.send({ t: 'turn', turn: 0, commands: [] });
    bot.send({ t: 'turn', turn: 0, commands: [] });
    await host.expect('turn');
    await bot.expect('turn');

    host.terminate();
    const reconnected = await connect();
    reconnected.send({ t: 'rejoin', code: created.code, slot: 0, token: hostStart.token, received: 1 });
    const rejoined = await reconnected.expect('rejoined');
    expect(rejoined).toEqual({ t: 'rejoined', nextTurn: 1, mode: 'single-player', difficulty: 'medium', capacity: 2, hostSlot: 0, versions: DEFAULT_COMPATIBILITY_VERSIONS, manifest: rooms.rooms.get(created.code)!.manifest });
  });

  test('C03: boundary validation rejects invalid mode/difficulty/settings/civ and leaves no half-room', async () => {
    class FakePeer implements Peer {
      messages: ServerMessage[] = [];
      send(m: ServerMessage): void {
        this.messages.push(m);
      }
      take<T extends ServerMessage['t']>(t: T): Extract<ServerMessage, { t: T }>[] {
        const out = this.messages.filter((m): m is Extract<ServerMessage, { t: T }> => m.t === t);
        this.messages = this.messages.filter((m) => m.t !== t);
        return out;
      }
    }

    const registry = new RoomRegistry({ generateCode: () => 'ABC23', generateSeed: () => 42 });
    const p1 = new FakePeer();
    const p2 = new FakePeer();

    // Invalid mode or difficulty on direct handle() creates no room and no byPeer mapping
    registry.handle(p1, { t: 'create', name: 'P1', mode: 'invalid' as never });
    expect(p1.take('error')).toMatchObject([{ code: 'invalid-settings' }]);
    expect(registry.rooms.size).toBe(0);
    expect(registry.roomOf(p1)).toBeUndefined();

    registry.handle(p1, { t: 'create', name: 'P1', mode: 'single-player', difficulty: 'extreme' as never });
    expect(p1.take('error')).toMatchObject([{ code: 'invalid-settings' }]);
    expect(registry.rooms.size).toBe(0);
    expect(registry.roomOf(p1)).toBeUndefined();

    // Valid single-player room creation after failed attempts
    registry.handle(p1, { t: 'create', name: 'P1', mode: 'single-player', difficulty: 'easy' });
    const lobby = p1.take('lobby')[0]!;
    expect(lobby.mode).toBe('single-player');
    expect(lobby.difficulty).toBe('easy');

    // Failed join leaves no stray byPeer mapping on p2
    registry.handle(p2, { t: 'join', code: 'ABC23', name: 'Intruder' });
    expect(p2.take('error')).toMatchObject([{ code: 'unauthorized' }]);
    expect(registry.roomOf(p2)).toBeUndefined();

    // Invalid civ & invalid settings rejected at server boundary without mutating state
    registry.handle(p1, { t: 'civ', civ: 99 });
    expect(p1.take('error')).toMatchObject([{ code: 'invalid-settings' }]);
    registry.handle(p1, { t: 'settings', settings: { ...lobby.settings, mapType: 999 } });
    expect(p1.take('error')).toMatchObject([{ code: 'invalid-settings' }]);
    expect(registry.rooms.get('ABC23')!.settings).toEqual(lobby.settings);

    // Ready locks civ and settings
    registry.handle(p1, { t: 'ready', ready: true });
    p1.take('lobby');
    registry.handle(p1, { t: 'civ', civ: 1 });
    expect(p1.take('error')).toMatchObject([{ code: 'locked' }]);
    registry.handle(p1, { t: 'settings', settings: { ...lobby.settings, mapSize: 96 } });
    expect(p1.take('error')).toMatchObject([{ code: 'locked' }]);

    // Unready unlocks; once started, settings/civ/ready rejected with room-started
    registry.handle(p1, { t: 'ready', ready: false });
    p1.take('lobby');
    registry.handle(p2, { t: 'join', code: 'ABC23', name: 'Bot', botToken: lobby.botToken });
    p1.take('lobby');
    p2.take('lobby');
    registry.handle(p1, { t: 'ready', ready: true });
    registry.handle(p2, { t: 'ready', ready: true });
    registry.handle(p1, { t: 'start' });
    registry.handle(p1, { t: 'settings', settings: { ...lobby.settings, mapSize: 96 } });
    expect(p1.take('error')).toMatchObject([{ code: 'room-started' }]);
    registry.handle(p2, { t: 'civ', civ: 3 });
    expect(p2.take('error')).toMatchObject([{ code: 'room-started' }]);
  });
});

describe('synchronized pause channel (Q01-Q05)', () => {
  class FakePeer implements Peer {
    messages: ServerMessage[] = [];
    send(m: ServerMessage): void {
      this.messages.push(m);
    }
    take<T extends ServerMessage['t']>(t: T): Extract<ServerMessage, { t: T }>[] {
      const out = this.messages.filter((m): m is Extract<ServerMessage, { t: T }> => m.t === t);
      this.messages = this.messages.filter((m) => m.t !== t);
      return out;
    }
  }

  function startedSinglePlayer(options: { now?: () => number; schedule?: (fn: () => void, ms: number) => () => void; dropAfterMs?: number } = {}) {
    const registry = new RoomRegistry({
      generateCode: () => 'SP222',
      generateSeed: () => 99,
      generateToken: () => 'tok',
      ...options,
    });
    const host = new FakePeer();
    const bot = new FakePeer();
    registry.handle(host, { t: 'create', name: 'Human', mode: 'single-player', difficulty: 'medium' });
    const lobby = host.take('lobby')[0]!;
    registry.handle(bot, { t: 'join', code: lobby.code, name: 'Computer', botToken: lobby.botToken });
    host.take('lobby');
    bot.take('lobby');
    registry.handle(host, { t: 'ready', ready: true });
    registry.handle(bot, { t: 'ready', ready: true });
    host.take('lobby');
    bot.take('lobby');
    registry.handle(host, { t: 'start' });
    const hostStart = host.take('start')[0]!;
    const botStart = bot.take('start')[0]!;
    host.take('ping');
    bot.take('ping');
    return { registry, host, bot, code: lobby.code, room: registry.rooms.get(lobby.code)!, hostStart, botStart };
  }

  test('Q01: pause at startup computes boundary = 2, holds batches 0 & 1 during pause, and releases cleanly on resume', () => {
    const { registry, host, bot, room } = startedSinglePlayer();

    registry.handle(host, { t: 'pause', paused: true, epoch: 0 });
    expect(host.take('paused')).toEqual([{ t: 'paused', paused: true, boundary: 2, epoch: 1 }]);
    expect(bot.take('paused')).toEqual([{ t: 'paused', paused: true, boundary: 2, epoch: 1 }]);
    expect(room.paused).toBe(true);
    expect(room.pauseBoundary).toBe(2);
    expect(room.pauseEpoch).toBe(1);

    // Peers coast through turns 0 and 1, submitting their batches
    registry.handle(host, { t: 'turn', turn: 0, commands: [{ type: 'test', x: 1, y: 2 }] });
    registry.handle(bot, { t: 'turn', turn: 0, commands: [] });
    registry.handle(host, { t: 'turn', turn: 1, commands: [] });
    registry.handle(bot, { t: 'turn', turn: 1, commands: [{ type: 'noop' }] });

    // Turns 0 & 1 are held at the pause boundary until resume
    expect(host.take('turn')).toEqual([]);
    expect(bot.take('turn')).toEqual([]);
    expect(room.log).toHaveLength(0);

    // Resume releases turns 0 & 1 in order without dropping or duplicating commands
    registry.handle(host, { t: 'pause', paused: false, epoch: 1 });
    expect(host.take('paused')).toEqual([{ t: 'paused', paused: false, boundary: 2, epoch: 2 }]);
    expect(bot.take('paused')).toEqual([{ t: 'paused', paused: false, boundary: 2, epoch: 2 }]);
    const releasedHost = host.take('turn');
    const releasedBot = bot.take('turn');
    expect(releasedHost).toHaveLength(2);
    expect(releasedBot).toHaveLength(2);
    expect(releasedHost.map((m) => m.turn)).toEqual([0, 1]);
    expect(releasedHost[0]!.batches[0]!.commands).toEqual([{ type: 'test', x: 1, y: 2 }]);
    expect(releasedHost[1]!.batches[1]!.commands).toEqual([{ type: 'noop' }]);
  });

  test('Q01: pause with released turns computes boundary = log.length + COMMAND_DELAY_TURNS', () => {
    const { registry, host, bot, room } = startedSinglePlayer();
    for (let t = 0; t < 4; t++) {
      registry.handle(host, { t: 'turn', turn: t, commands: [] });
      registry.handle(bot, { t: 'turn', turn: t, commands: [] });
    }
    host.take('turn');
    bot.take('turn');
    expect(room.log).toHaveLength(4);

    registry.handle(host, { t: 'pause', paused: true });
    expect(host.take('paused')).toEqual([{ t: 'paused', paused: true, boundary: 6, epoch: 1 }]);
    expect(bot.take('paused')).toEqual([{ t: 'paused', paused: true, boundary: 6, epoch: 1 }]);

    // Turns 4 and 5 submitted while coasting to boundary 6 are held until resume
    for (let t = 4; t < 6; t++) {
      registry.handle(host, { t: 'turn', turn: t, commands: [{ type: 'noop' }] });
      registry.handle(bot, { t: 'turn', turn: t, commands: [] });
    }
    expect(host.take('turn')).toEqual([]);
    expect(room.log).toHaveLength(4);

    registry.handle(host, { t: 'pause', paused: false });
    expect(host.take('paused')).toEqual([{ t: 'paused', paused: false, boundary: 6, epoch: 2 }]);
    expect(host.take('turn').map((m) => m.turn)).toEqual([4, 5]);
  });

  test('Q02: ping/pong/chat work during pause and false drop escalation is suppressed while paused', () => {
    let clock = 1000;
    const timers: { fn: () => void; at: number }[] = [];
    const { registry, host, bot } = startedSinglePlayer({
      now: () => clock,
      dropAfterMs: 40_000,
      schedule: (fn, ms) => {
        const timer = { fn, at: clock + ms };
        timers.push(timer);
        return () => {
          const idx = timers.indexOf(timer);
          if (idx >= 0) timers.splice(idx, 1);
        };
      },
    });

    registry.handle(host, { t: 'pause', paused: true });
    host.take('paused');
    bot.take('paused');

    // Ping/pong and chat stay functional during pause
    clock += PING_INTERVAL_MS + 1;
    registry.handle(host, { t: 'chat', text: 'paused check', to: [0, 1] });
    expect(bot.take('chat')).toEqual([{ t: 'chat', from: 0, text: 'paused check' }]);
    const pings = host.take('ping');
    expect(pings).toHaveLength(1);
    clock += 25;
    registry.handle(host, { t: 'pong', n: pings[0]!.n });
    expect(host.take('rtt')).toEqual([{ t: 'rtt', rtt: [25, 0], frameMs: [0, 0] }]);

    // Bot socket drops while paused; even if DROP_AFTER_MS fires during pause, bot is NOT dropped while paused
    registry.disconnect(bot, true);
    expect(timers).toHaveLength(1);
    clock += 100_000;
    timers.shift()!.fn();
    expect(host.take('dropped')).toEqual([]);

    // On resume, drop timer is cleanly re-armed for a full dropAfterMs grace window
    registry.handle(host, { t: 'pause', paused: false });
    host.take('paused');
    expect(timers).toHaveLength(1);
    expect(timers[0]!.at).toBe(clock + 40_000);
  });

  test('Q04: rejects multiplayer, bot slot, pre-start, and game-over; ignores duplicate/stale epoch toggles', () => {
    const preRegistry = new RoomRegistry({ generateCode: () => 'PRE22', generateSeed: () => 1 });
    const preHost = new FakePeer();
    preRegistry.handle(preHost, { t: 'create', name: 'Human', mode: 'single-player' });
    preHost.take('lobby');
    preRegistry.handle(preHost, { t: 'pause', paused: true });
    expect(preHost.take('error')).toMatchObject([{ code: 'not-started' }]);
    expect(preHost.take('paused')).toEqual([]);

    const mpRegistry = new RoomRegistry({ generateCode: () => 'MP222', generateSeed: () => 1 });
    const mpHost = new FakePeer();
    const mpGuest = new FakePeer();
    mpRegistry.handle(mpHost, { t: 'create', name: 'Alice' });
    mpRegistry.handle(mpGuest, { t: 'join', code: 'MP222', name: 'Bob' });
    mpRegistry.handle(mpHost, { t: 'ready', ready: true });
    mpRegistry.handle(mpGuest, { t: 'ready', ready: true });
    mpRegistry.handle(mpHost, { t: 'start' });
    mpHost.take('start');
    mpRegistry.handle(mpHost, { t: 'pause', paused: true });
    expect(mpHost.take('error')).toMatchObject([{ code: 'unauthorized' }]);

    const { registry, host, bot, room } = startedSinglePlayer();

    // Bot (slot 1, isBot: true) cannot pause
    registry.handle(bot, { t: 'pause', paused: true });
    expect(bot.take('error')).toMatchObject([{ code: 'unauthorized' }]);
    expect(host.take('paused')).toEqual([]);

    // Valid pause -> epoch 1
    registry.handle(host, { t: 'pause', paused: true, epoch: 0 });
    expect(host.take('paused')).toEqual([{ t: 'paused', paused: true, boundary: 2, epoch: 1 }]);
    bot.take('paused');

    // Duplicate paused: true -> idempotent no-op
    registry.handle(host, { t: 'pause', paused: true, epoch: 1 });
    expect(host.take('paused')).toEqual([]);
    expect(host.take('error')).toEqual([]);
    expect(room.pauseEpoch).toBe(1);

    // Stale epoch 0 on resume -> idempotent no-op
    registry.handle(host, { t: 'pause', paused: false, epoch: 0 });
    expect(host.take('paused')).toEqual([]);
    expect(room.paused).toBe(true);
    expect(room.pauseEpoch).toBe(1);

    // Resume then resign -> pause after resign rejected
    registry.handle(host, { t: 'pause', paused: false, epoch: 1 });
    host.take('paused');
    bot.take('paused');
    registry.handle(host, { t: 'turn', turn: 0, commands: [{ type: 'resign' }] });
    registry.handle(host, { t: 'pause', paused: true });
    expect(host.take('error')).toMatchObject([{ code: 'locked' }]);
  });

  test('Q04: resigning while paused releases the barrier so the remaining peer can finish the game', () => {
    const { registry, host, bot, room } = startedSinglePlayer();
    registry.handle(host, { t: 'pause', paused: true, epoch: 0 });
    host.take('paused');
    bot.take('paused');
    for (let turn = 0; turn < 2; turn++) {
      registry.handle(host, { t: 'turn', turn, commands: [] });
      registry.handle(bot, { t: 'turn', turn, commands: [] });
    }
    expect(room.log).toHaveLength(0);

    // Quit sends its resign even though the simulation has reached the pause barrier.
    registry.handle(host, { t: 'turn', turn: 2, commands: [{ type: 'resign' }] });
    expect(room.gameOver).toBe(false);
    expect(room.members[0]!.resigned).toBe(true);
    expect(room.paused).toBe(false);
    expect(bot.take('paused')).toEqual([{ t: 'paused', paused: false, boundary: 2, epoch: 2 }]);
    expect(bot.take('turn').map((m) => m.turn)).toEqual([0, 1]);

    registry.disconnect(host);
    registry.handle(bot, { t: 'turn', turn: 2, commands: [] });
    expect(bot.take('turn')[0]!.batches[0]!.commands).toEqual([{ type: 'resign' }]);
    expect(bot.take('error')).toEqual([]);
  });

  test('Q05: rejoined restores active pause snapshot and post-resume pause snapshot', () => {
    const { registry, host, bot, code, botStart } = startedSinglePlayer();
    registry.handle(host, { t: 'turn', turn: 0, commands: [] });
    registry.handle(bot, { t: 'turn', turn: 0, commands: [] });
    host.take('turn');
    bot.take('turn');

    registry.handle(host, { t: 'pause', paused: true });
    host.take('paused');
    bot.take('paused');

    registry.disconnect(bot, true);
    const bot2 = new FakePeer();
    registry.handle(bot2, { t: 'rejoin', code, slot: 1, token: botStart.token, received: 1 });
    expect(bot2.take('rejoined')).toEqual([
      {
        t: 'rejoined',
        capacity: 2,
        hostSlot: 0,
        versions: DEFAULT_COMPATIBILITY_VERSIONS,
        manifest: botStart.manifest,
        nextTurn: 1,
        mode: 'single-player',
        difficulty: 'medium',
        paused: true,
        pauseBoundary: 3,
        pauseEpoch: 1,
      },
    ]);

    registry.handle(host, { t: 'pause', paused: false });
    host.take('paused');
    bot2.take('paused');
    registry.disconnect(bot2, true);
    const bot3 = new FakePeer();
    registry.handle(bot3, { t: 'rejoin', code, slot: 1, token: botStart.token, received: 1 });
    expect(bot3.take('rejoined')).toEqual([
      {
        t: 'rejoined',
        capacity: 2,
        hostSlot: 0,
        versions: DEFAULT_COMPATIBILITY_VERSIONS,
        manifest: botStart.manifest,
        nextTurn: 1,
        mode: 'single-player',
        difficulty: 'medium',
        paused: false,
        pauseBoundary: 3,
        pauseEpoch: 2,
      },
    ]);
  });
});

describe('server-side game speed validation (S02, S03)', () => {
  test('S02: multiplayer enforces [1, 1.5, 2] server-side and rejects single-player/invalid speeds without advancing nextTurn', async () => {
    const { host, guest } = await pair();
    await startGame(host, guest);

    // Non-whitelist speeds pass wire codec if in [0.5, 4.0], but RoomRegistry rejects them in multiplayer
    for (const badMpSpeed of [0.5, 0.75, 1.25, 2.5, 3, 4]) {
      host.send({ t: 'turn', turn: 0, commands: [{ type: 'game-speed', speed: badMpSpeed }] });
      expect((await host.expect('error')).code).toBe('invalid-settings');
    }

    // Out-of-range / zero / negative / NaN / Infinity are rejected at wire codec too
    for (const badWireSpeed of [0, -1, 0.25, 4.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      host.send({ t: 'turn', turn: 0, commands: [{ type: 'game-speed', speed: badWireSpeed }] });
      expect((await host.expect('error')).code).toBe('bad-message');
    }

    // Valid multiplayer speed 1.5 at turn 0 still succeeds (nextTurn was not corrupted by rejections)
    host.send({ t: 'turn', turn: 0, commands: [{ type: 'game-speed', speed: 1.5 }] });
    guest.send({ t: 'turn', turn: 0, commands: [] });
    expect((await host.expect('turn')).batches[0]!.commands).toEqual([{ type: 'game-speed', speed: 1.5 }]);
    expect((await guest.expect('turn')).batches[0]!.commands).toEqual([{ type: 'game-speed', speed: 1.5 }]);
  });

  test('S02/S03: single-player allows bounded [0.5, 4.0] from host, rejects bot & invalid speeds, and relays speed across pause', async () => {
    const host = await connect();
    const bot = await connect();
    host.send({ t: 'create', name: 'Human', mode: 'single-player', difficulty: 'medium' });
    const lobby = await host.expect('lobby');
    bot.send({ t: 'join', code: lobby.code, name: 'Computer', botToken: lobby.botToken });
    await bot.expect('lobby');
    await host.expect('lobby');
    host.send({ t: 'ready', ready: true });
    bot.send({ t: 'ready', ready: true });
    for (const c of [host, bot]) {
      await c.expect('lobby');
      await c.expect('lobby');
    }
    host.send({ t: 'start' });
    await host.expect('start');
    await bot.expect('start');

    // Bot cannot send game-speed
    bot.send({ t: 'turn', turn: 0, commands: [{ type: 'game-speed', speed: 2 }] });
    expect((await bot.expect('error')).code).toBe('unauthorized');

    // Direct registry check for NaN/Infinity/0/negative/out-of-range in single-player
    class FakePeer implements Peer {
      messages: ServerMessage[] = [];
      send(m: ServerMessage): void {
        this.messages.push(m);
      }
    }
    const reg = new RoomRegistry({ generateCode: () => 'SP999', generateSeed: () => 1, generateToken: () => 'tok' });
    const fpHost = new FakePeer();
    const fpBot = new FakePeer();
    reg.handle(fpHost, { t: 'create', name: 'Human', mode: 'single-player' });
    reg.handle(fpBot, { t: 'join', code: 'SP999', name: 'Bot', botToken: 'tok' });
    reg.handle(fpHost, { t: 'ready', ready: true });
    reg.handle(fpBot, { t: 'ready', ready: true });
    reg.handle(fpHost, { t: 'start' });
    fpHost.messages = [];
    for (const invalid of [0, -0.5, 0.49, 4.01, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      reg.handle(fpHost, { t: 'turn', turn: 0, commands: [{ type: 'game-speed', speed: invalid }] });
      expect(fpHost.messages.at(-1)).toMatchObject({ t: 'error', code: 'invalid-settings' });
    }

    // Host in single-player pauses, submits bounded speeds 0.5 and 3.75 while coasting, and resumes -> both receive them
    host.send({ t: 'pause', paused: true, epoch: 0 });
    expect(await host.expect('paused')).toEqual({ t: 'paused', paused: true, boundary: 2, epoch: 1 });
    expect(await bot.expect('paused')).toEqual({ t: 'paused', paused: true, boundary: 2, epoch: 1 });

    host.send({ t: 'turn', turn: 0, commands: [{ type: 'game-speed', speed: 0.5 }] });
    bot.send({ t: 'turn', turn: 0, commands: [] });
    host.send({ t: 'turn', turn: 1, commands: [{ type: 'game-speed', speed: 3.75 }] });
    bot.send({ t: 'turn', turn: 1, commands: [] });
    await host.expectSilence();
    await bot.expectSilence();

    host.send({ t: 'pause', paused: false, epoch: 1 });
    expect(await host.expect('paused')).toEqual({ t: 'paused', paused: false, boundary: 2, epoch: 2 });
    expect(await bot.expect('paused')).toEqual({ t: 'paused', paused: false, boundary: 2, epoch: 2 });

    for (const expectedSpeed of [0.5, 3.75]) {
      const hTurn = await host.expect('turn');
      const bTurn = await bot.expect('turn');
      expect(hTurn.batches[0]!.commands).toEqual([{ type: 'game-speed', speed: expectedSpeed }]);
      expect(bTurn.batches[0]!.commands).toEqual([{ type: 'game-speed', speed: expectedSpeed }]);
    }
  });
});
