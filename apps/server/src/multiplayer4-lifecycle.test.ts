import { describe, expect, test } from 'vitest';
import { DEFAULT_COMPATIBILITY_VERSIONS as versions, MAX_TURNS_AHEAD, type ServerMessage } from '@aoe/protocol';
import { RoomRegistry, type Peer } from './rooms';
class Client implements Peer {
  messages: ServerMessage[] = [];
  send(m: ServerMessage): void { this.messages.push(m); }
  all<T extends ServerMessage['t']>(t: T): Extract<ServerMessage, { t: T }>[] { return this.messages.filter(m => m.t === t) as Extract<ServerMessage, { t: T }>[]; }
}
function game(capacity: 2 | 4 = 4) {
  const timers = new Set<() => void>();
  const registry = new RoomRegistry({ generateCode: () => 'ABCDE', generateSeed: () => 77, now: () => 0, schedule: fn => { const fire = () => { timers.delete(fire); fn(); }; timers.add(fire); return () => { timers.delete(fire); }; } });
  const peers = Array.from({ length: capacity }, () => new Client());
  registry.handle(peers[0]!, { t: 'create', name: 'P0', capacity, versions });
  for (let slot = 1; slot < capacity; slot++) registry.handle(peers[slot]!, { t: 'join', code: 'ABCDE', name: `P${slot}`, versions });
  for (const peer of peers) registry.handle(peer, { t: 'ready', ready: true });
  registry.handle(peers[0]!, { t: 'start' });
  return { registry, peers, timers, room: registry.roomOf(peers[0]!)! };
}
describe('multiplayer4 lifecycle', () => {
  test('two resignations preserve queued commands and leave two active peers playing', () => {
    const { registry, peers, room } = game();
    registry.handle(peers[0]!, { t: 'turn', turn: 0, commands: [{ type: 'noop' }] });
    registry.handle(peers[0]!, { t: 'turn', turn: 1, commands: [{ type: 'resign' }] });
    registry.handle(peers[1]!, { t: 'turn', turn: 0, commands: [{ type: 'resign' }] });
    for (const p of peers.slice(2)) for (let turn = 0; turn < 4; turn++) registry.handle(p, { t: 'turn', turn, commands: [] });
    expect(room.log).toHaveLength(4); expect(room.log[0]!.batches[0]!.commands).toEqual([{ type: 'noop' }]); expect(room.log[1]!.batches[0]!.commands).toEqual([{ type: 'resign' }]);
    expect(room.gameOver).toBe(false); expect(registry.rooms.size).toBe(1); expect(peers[0]!.all('turn')).toHaveLength(4);
    registry.handle(peers[0]!, { t: 'turn', turn: 4, commands: [] }); registry.handle(peers[0]!, { t: 'hash', turn: 4, hash: 5 }); expect(peers[0]!.all('error')).toEqual([]);
    registry.handle(peers[0]!, { t: 'turn', turn: 4, commands: [{ type: 'noop' }] }); expect(peers[0]!.all('error').at(-1)?.code).toBe('locked'); expect(room.log).toHaveLength(4);
  });
  test.each(['leave', 'timeout'] as const)('%s injects resign after accepted pending batches without losing commands', kind => {
    const { registry, peers, room, timers } = game();
    const commands = [{ type: 'test' as const, x: 1, y: 2 }];
    registry.handle(peers[0]!, { t: 'turn', turn: 0, commands }); commands[0]!.x = 999;
    registry.handle(peers[0]!, { t: 'turn', turn: 1, commands: [{ type: 'noop' }] });
    if (kind === 'leave') registry.handle(peers[0]!, { t: 'leave' }); else { registry.disconnect(peers[0]!, true); for (const fire of [...timers]) fire(); }
    for (const p of peers.slice(1)) for (let turn = 0; turn < 4; turn++) registry.handle(p, { t: 'turn', turn, commands: [] });
    expect(room.log.map(r => r.batches[0]!.commands)).toEqual([[{ type: 'test', x: 1, y: 2 }], [{ type: 'noop' }], [{ type: 'resign' }], []]);
    expect(room.hostSlot).toBe(1); expect(room.gameOver).toBe(false); expect(room.manifest!.hostSlot).toBe(0); expect(peers[1]!.all('ended')).toEqual([]);
  });
  test('resign removes slow peer from RTT and hash wait sets while retaining observer connection', () => {
    const { registry, peers, room } = game(); room.members[0]!.rtt = 2000; room.members[0]!.frameMs = 200;
    for (const p of peers.slice(1)) registry.handle(p, { t: 'hash', turn: 0, hash: p === peers[3] ? 3 : 0 });
    registry.handle(peers[0]!, { t: 'turn', turn: 0, commands: [{ type: 'resign' }] });
    expect(peers[1]!.all('desync')).toEqual([{ t: 'desync', turn: 0, hashes: [0, 0, 0, 3] }]); expect(room.rttMessage()).toEqual({ t: 'rtt', rtt: [0, 0, 0, 0], frameMs: [0, 0, 0, 0] });
    const back = new Client(); registry.handle(back, { t: 'rejoin', code: 'ABCDE', slot: 0, token: peers[0]!.all('start')[0]!.token, received: 0 }); expect(back.all('error')[0]?.code).toBe('bad-rejoin');
  });
  test('last broken socket closes immediately and cancels every grace timer', () => {
    const { registry, peers, timers, room } = game();
    for (const p of peers) registry.disconnect(p, true);
    expect(registry.rooms.size).toBe(0); expect(timers.size).toBe(0); for (const p of peers) expect(registry.roomOf(p)).toBeUndefined(); expect(room.members.every(m => m.cancelDrop === null)).toBe(true);
  });
  test('all inactive observers release finitely and empty keepalives do not synthesize forever', () => {
    const { registry, peers, room } = game();
    for (const p of peers) registry.handle(p, { t: 'turn', turn: 0, commands: [{ type: 'resign' }] });
    expect(room.log).toHaveLength(1); for (const p of peers) registry.handle(p, { t: 'turn', turn: 1, commands: [] }); expect(room.log).toHaveLength(1); expect(room.gameOver).toBe(false);
  });
  test('matching reports from every active peer complete exactly once with normalized winners', () => {
    const { registry, peers, room } = game(); for (const p of peers) registry.handle(p, { t: 'turn', turn: 0, commands: [] });
    for (const p of peers.slice(0, 3)) registry.handle(p, { t: 'result', turn: 0, hash: 0, winners: [4, 2] });
    expect(registry.rooms.size).toBe(1); registry.handle(peers[3]!, { t: 'result', turn: 0, hash: 0, winners: [2, 4] });
    expect(registry.rooms.size).toBe(0); expect(room.gameOver).toBe(true);
    for (const p of peers) { expect(p.all('ended')).toEqual([{ t: 'ended', reason: 'completed', result: { turn: 0, hash: 0, winners: [2, 4] } }]); expect(registry.roomOf(p)).toBeUndefined(); }
    registry.handle(peers[3]!, { t: 'result', turn: 0, hash: 0, winners: [2, 4] }); expect(peers[3]!.all('ended')).toHaveLength(1);
  });
  test('different result turns, hashes or winners never form consensus', () => {
    const { registry, peers } = game(); for (const p of peers) for (let turn = 0; turn < 2; turn++) registry.handle(p, { t: 'turn', turn, commands: [] });
    registry.handle(peers[0]!, { t: 'result', turn: 0, hash: 3, winners: [1] }); registry.handle(peers[1]!, { t: 'result', turn: 1, hash: 3, winners: [1] });
    registry.handle(peers[2]!, { t: 'result', turn: 0, hash: 4, winners: [1] }); registry.handle(peers[3]!, { t: 'result', turn: 0, hash: 3, winners: [2] }); expect(registry.rooms.size).toBe(1);
  });
  test('asynchronous result rounds retain a common earlier turn across faster peer reports', () => {
    const { registry, peers } = game(); for (const p of peers) for (let turn = 0; turn < 3; turn++) registry.handle(p, { t: 'turn', turn, commands: [] });
    for (const p of peers.slice(0, 3)) { registry.handle(p, { t: 'result', turn: 0, hash: 10, winners: [1] }); registry.handle(p, { t: 'result', turn: 1, hash: 11, winners: [1] }); }
    registry.handle(peers[3]!, { t: 'result', turn: 0, hash: 10, winners: [1] }); expect(registry.rooms.size).toBe(0);
  });
  test('quorum changes discard old reports and require fresh agreement from remaining active peers', () => {
    const { registry, peers } = game(); for (const p of peers) registry.handle(p, { t: 'turn', turn: 0, commands: [] });
    for (const p of peers.slice(0, 3)) registry.handle(p, { t: 'result', turn: 0, hash: 5, winners: [1] }); registry.handle(peers[3]!, { t: 'leave' }); expect(registry.rooms.size).toBe(1);
    registry.handle(peers[0]!, { t: 'result', turn: 0, hash: 5, winners: [1] });
    expect(peers[0]!.all('error').at(-1)?.code).toBe('bad-result');
    // The injected resignation is issued on turn 1 and executes on turn 3.
    for (const p of peers.slice(0, 3)) for (let turn = 1; turn <= 3; turn++) registry.handle(p, { t: 'turn', turn, commands: [] });
    registry.handle(peers[0]!, { t: 'result', turn: 3, hash: 5, winners: [1] }); expect(registry.rooms.size).toBe(1);
    for (const p of peers.slice(1, 3)) registry.handle(p, { t: 'result', turn: 3, hash: 5, winners: [1] }); expect(registry.rooms.size).toBe(0);
  });
  test('rejects unsubmitted, distant, invalid winners and contradictory own checksum reports', () => {
    const { registry, peers, room } = game(2); const p = peers[0]!;
    registry.handle(p, { t: 'result', turn: 0, hash: 1, winners: [1] }); expect(p.all('error').at(-1)?.code).toBe('bad-result');
    registry.handle(p, { t: 'turn', turn: 0, commands: [] }); registry.handle(p, { t: 'hash', turn: 0, hash: 0 });
    for (const report of [{ turn: 0, hash: 1, winners: [1] }, { turn: 0, hash: 0, winners: [3] }, { turn: 0, hash: 0, winners: [1, 1] }, { turn: 3, hash: 0, winners: [1] }]) { registry.handle(p, { t: 'result', ...report }); expect(p.all('error').at(-1)?.code).toBe('bad-result'); }
    expect(room.gameOver).toBe(false); expect(registry.rooms.size).toBe(1);
  });
  test('old singleton votes cannot close a room after other active voters resign', () => {
    const { registry, peers } = game(); for (const p of peers) registry.handle(p, { t: 'turn', turn: 0, commands: [] });
    registry.handle(peers[0]!, { t: 'result', turn: 0, hash: 5, winners: [1] });
    for (const p of peers.slice(1)) registry.handle(p, { t: 'turn', turn: 1, commands: [{ type: 'resign' }] });
    expect(registry.rooms.size).toBe(1); expect(peers[0]!.all('ended')).toEqual([]);
    registry.handle(peers[0]!, { t: 'result', turn: 0, hash: 5, winners: [1] }); expect(registry.rooms.size).toBe(1);
    expect(peers[0]!.all('error').at(-1)?.code).toBe('bad-result');
    for (let turn = 1; turn <= 3; turn++) registry.handle(peers[0]!, { t: 'turn', turn, commands: [] });
    registry.handle(peers[0]!, { t: 'result', turn: 3, hash: 5, winners: [1] }); expect(registry.rooms.size).toBe(0);
  });
  test('duplicate votes cannot replace other participants and stale rounds cannot be resurrected', () => {
    const { registry, peers } = game(); for (const p of peers) registry.handle(p, { t: 'turn', turn: 0, commands: [] });
    for (let repeat = 0; repeat < 4; repeat++) registry.handle(peers[0]!, { t: 'result', turn: 0, hash: 5, winners: [1] });
    expect(registry.rooms.size).toBe(1);
    registry.handle(peers[0]!, { t: 'result', turn: 0, hash: 6, winners: [1] }); expect(peers[0]!.all('error').at(-1)?.code).toBe('bad-result');
    for (let turn = 1; turn <= MAX_TURNS_AHEAD + 1; turn++) for (const p of peers) registry.handle(p, { t: 'turn', turn, commands: [] });
    for (const p of peers) registry.handle(p, { t: 'result', turn: 0, hash: 5, winners: [1] });
    expect(registry.rooms.size).toBe(1); for (const p of peers) expect(p.all('error').at(-1)?.code).toBe('bad-result');
  });
  test('result rounds are bounded during prolonged disagreement', () => {
    const { registry, peers, room } = game();
    for (let turn = 0; turn < MAX_TURNS_AHEAD * 3; turn++) { for (const p of peers) registry.handle(p, { t: 'turn', turn, commands: [] }); registry.handle(peers[0]!, { t: 'result', turn, hash: turn, winners: [1] }); }
    expect(room.resultRounds.size).toBeLessThanOrEqual(MAX_TURNS_AHEAD + 1); expect(registry.rooms.size).toBe(1);
  });
});
