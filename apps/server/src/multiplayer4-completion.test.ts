import { describe, expect, test } from 'vitest';
import { COMMAND_DELAY_TURNS, DEFAULT_COMPATIBILITY_VERSIONS as versions, type Command, type ServerMessage } from '@aoe/protocol';
import { lobbyWorldOptions, World } from '@aoe/sim';
import { RoomRegistry, type Peer } from './rooms';

class Client implements Peer {
  messages: ServerMessage[] = [];
  send(message: ServerMessage): void { this.messages.push(message); }
  all<T extends ServerMessage['t']>(tag: T): Extract<ServerMessage, { t: T }>[] {
    return this.messages.filter(message => message.t === tag) as Extract<ServerMessage, { t: T }>[];
  }
}

function game() {
  const registry = new RoomRegistry({ generateCode: () => 'ABCDE', generateSeed: () => 77, generateCiv: () => 1 });
  const peers = Array.from({ length: 4 }, () => new Client());
  registry.handle(peers[0]!, { t: 'create', name: 'P0', capacity: 4, versions });
  for (const slot of [1, 2, 3]) registry.handle(peers[slot]!, { t: 'join', name: `P${slot}`, code: 'ABCDE', versions });
  for (const peer of peers) registry.handle(peer, { t: 'ready', ready: true });
  registry.handle(peers[0]!, { t: 'start' });
  return { registry, peers, room: registry.roomOf(peers[0]!)! };
}

describe('M04 backend completion boundaries', () => {
  test('all resigned clients can agree on the actual terminal World result without synthesizing more turns', () => {
    const { registry, peers, room } = game();
    const worlds = peers.map(peer => {
      const manifest = peer.all('start')[0]!.manifest!;
      return new World(lobbyWorldOptions(manifest.seed, manifest.settings, manifest.players.map(player => player.civ), true));
    });
    for (const peer of peers) registry.handle(peer, { t: 'turn', turn: 0, commands: [{ type: 'resign' }] });
    expect(room.log).toHaveLength(1);
    for (const world of worlds) {
      for (const batch of room.log[0]!.batches) world.addBatch(0, batch.slot + 1, batch.commands);
      for (let turn = 0; turn <= COMMAND_DELAY_TURNS; turn++) world.runTurn();
      expect(world.gameResult()).not.toBeNull();
    }
    const reports = worlds.map(world => ({ t: 'result' as const, turn: world.turn - 1, hash: world.syncChecksum(), winners: world.gameResult()!.winners }));
    for (const [slot, peer] of peers.entries()) {
      registry.handle(peer, { t: 'turn', turn: COMMAND_DELAY_TURNS, commands: [] });
      registry.handle(peer, reports[slot]!);
      if (slot < 3) expect(registry.rooms.size).toBe(1);
    }
    expect(registry.rooms.size).toBe(0);
    expect(room.log).toHaveLength(1);
    for (const peer of peers) expect(peer.all('ended')).toEqual([{ t: 'ended', reason: 'completed', result: { turn: reports[0]!.turn, hash: reports[0]!.hash, winners: reports[0]!.winners } }]);
  });

  test('a fresh vote after a quorum change cannot precede the turn that executes the resignation', () => {
    const { registry, peers, room } = game();
    for (const peer of peers) registry.handle(peer, { t: 'turn', turn: 0, commands: [] });
    for (const peer of peers.slice(1)) registry.handle(peer, { t: 'turn', turn: 1, commands: [{ type: 'resign' }] });
    registry.handle(peers[0]!, { t: 'result', turn: 0, hash: 5, winners: [1] });
    expect(registry.rooms.size).toBe(1);
    expect(peers[0]!.all('error').at(-1)?.code).toBe('bad-result');
    for (let turn = 1; turn <= 1 + COMMAND_DELAY_TURNS; turn++) registry.handle(peers[0]!, { t: 'turn', turn, commands: [] });
    registry.handle(peers[0]!, { t: 'result', turn: 1 + COMMAND_DELAY_TURNS, hash: 9, winners: [1] });
    expect(registry.rooms.size).toBe(0);
    expect(room.gameOver).toBe(true);
  });

  test('rejected duplicate or invalid speed batches cannot alter the relay frame-time telemetry', () => {
    const { registry, peers, room } = game();
    registry.handle(peers[0]!, { t: 'turn', turn: 0, commands: [], frameMs: 16 });
    registry.handle(peers[0]!, { t: 'turn', turn: 0, commands: [], frameMs: 255 });
    expect(peers[0]!.all('error').at(-1)?.code).toBe('bad-turn');
    expect(room.members[0]!.frameMs).toBe(16);
    registry.handle(peers[0]!, { t: 'turn', turn: 1, commands: [{ type: 'game-speed', speed: 3 } as Command], frameMs: 200 });
    expect(peers[0]!.all('error').at(-1)?.code).toBe('invalid-settings');
    expect(room.members[0]!.frameMs).toBe(16);
  });

  test('retired observers cannot acknowledge an impossible future turn to vote a premature result', () => {
    const { registry, peers } = game();
    for (const peer of peers) registry.handle(peer, { t: 'turn', turn: 0, commands: [{ type: 'resign' }] });
    for (const peer of peers) {
      registry.handle(peer, { t: 'turn', turn: 40, commands: [] });
      registry.handle(peer, { t: 'result', turn: 40, hash: 0, winners: [] });
    }
    expect(registry.rooms.size).toBe(1);
    for (const peer of peers) expect(peer.all('error').at(-1)?.code).toBe('bad-result');
  });

  test('completed checksum rounds still constrain later result reports', () => {
    const { registry, peers } = game();
    for (const peer of peers) registry.handle(peer, { t: 'hash', turn: 0, hash: 5 });
    for (const peer of peers) registry.handle(peer, { t: 'turn', turn: 0, commands: [] });
    for (const peer of peers) {
      registry.handle(peer, { t: 'result', turn: 0, hash: 9, winners: [1] });
      expect(peer.all('error').at(-1)?.code).toBe('bad-result');
    }
    expect(registry.rooms.size).toBe(1);
    for (const peer of peers) registry.handle(peer, { t: 'result', turn: 0, hash: 5, winners: [1] });
    expect(registry.rooms.size).toBe(0);
  });

  test('terminal nonvoter departure completes existing matching votes without waiting for an impossible next turn', () => {
    const { registry, peers, room } = game();
    const report = { t: 'result' as const, turn: COMMAND_DELAY_TURNS, hash: 5, winners: [] };
    for (const peer of peers) registry.handle(peer, { t: 'turn', turn: 0, commands: [{ type: 'resign' }] });
    for (const peer of peers) registry.handle(peer, { t: 'turn', turn: COMMAND_DELAY_TURNS, commands: [] });
    for (const peer of peers.slice(0, 3)) registry.handle(peer, report);
    expect(registry.rooms.size).toBe(1);
    registry.disconnect(peers[3]!);
    expect(registry.rooms.size).toBe(0);
    expect(room.log).toHaveLength(1);
    for (const peer of peers.slice(0, 3)) expect(peer.all('ended')).toHaveLength(1);
  });
});
