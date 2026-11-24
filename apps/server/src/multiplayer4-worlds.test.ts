import { describe, expect, test } from 'vitest';
import { DEFAULT_COMPATIBILITY_VERSIONS as versions, type Command, type ServerMessage } from '@aoe/protocol';
import { CIV_RANDOM, lobbyWorldOptions, World } from '@aoe/sim';
import { RoomRegistry, type Peer } from './rooms';

class WorldPeer implements Peer {
  messages: ServerMessage[] = [];
  send(message: ServerMessage): void { this.messages.push(message); }
  start(): Extract<ServerMessage, { t: 'start' }> {
    return this.messages.find((message) => message.t === 'start') as Extract<ServerMessage, { t: 'start' }>;
  }
}

function game(seed: number) {
  const registry = new RoomRegistry({ generateCode: () => 'ABCDE', generateSeed: () => seed, generateCiv: () => 1 });
  const peers = Array.from({ length: 4 }, () => new WorldPeer());
  registry.handle(peers[0]!, { t: 'create', name: 'P0', capacity: 4, versions });
  for (let slot = 1; slot < 4; slot++) registry.handle(peers[slot]!, { t: 'join', code: 'ABCDE', name: `P${slot}`, versions });
  for (const [slot, peer] of peers.entries()) {
    registry.handle(peer, { t: 'civ', civ: slot === 3 ? CIV_RANDOM : slot + 1 });
    registry.handle(peer, { t: 'ready', ready: true });
  }
  registry.handle(peers[0]!, { t: 'start' });
  const worlds = peers.map((peer) => {
    const start = peer.start();
    expect(start?.manifest?.players).toHaveLength(4);
    const manifest = start.manifest!;
    return new World(lobbyWorldOptions(manifest.seed, manifest.settings, manifest.players.map((player) => player.civ), true));
  });
  const room = registry.rooms.get('ABCDE')!;
  let consumed = 0;
  function tick(commands: Command[][] = [[], [], [], []]): number {
    for (const release of room.log.slice(consumed)) {
      for (const world of worlds) {
        for (const batch of release.batches) world.addBatch(release.turn, batch.slot + 1, batch.commands);
        if (release.speed) world.setSpeedChange(release.speed);
      }
    }
    consumed = room.log.length;
    for (const world of worlds) world.runTurn();
    const turn = worlds[0]!.turn - 1;
    const hashes = worlds.map((world) => world.syncChecksum());
    expect(new Set(hashes).size, `seed ${seed}, turn ${turn}`).toBe(1);
    // Different socket arrival order must not change batch/player order or sim behavior.
    for (const slot of [3, 1, 0, 2]) {
      const peer = peers[slot]!;
      if (turn % 4 === 0) registry.handle(peer, { t: 'hash', turn, hash: hashes[slot]! });
      registry.handle(peer, { t: 'turn', turn, commands: commands[slot]!, frameMs: 16 + slot });
    }
    return turn;
  }
  return { registry, peers, worlds, room, tick };
}

describe('M03/M04 four-world relay integration', () => {
  test.each([77, 1234])('four seeded worlds execute ordered batches from the real relay with equal hashes (seed %s)', (seed) => {
    const { peers, worlds, room, tick } = game(seed);
    expect(worlds.map((world) => world.players)).toEqual([5, 5, 5, 5]);
    expect(worlds.every((world) => JSON.stringify(world.civs) === JSON.stringify(worlds[0]!.civs))).toBe(true);
    const villagers = [...worlds[0]!.entities.all()].filter((entity) => entity.type === 83);
    const first = Array.from({ length: 4 }, (_, slot) => villagers.find((entity) => entity.owner === slot + 1)!);
    const initial = first.map((entity) => ({ x: entity.x, y: entity.y }));
    const commands: Command[][] = first.map((entity) => [{ type: 'move', units: [entity.id], x: entity.x + 2, y: entity.y + 2 }]);
    tick(commands);
    for (let turn = 1; turn < 24; turn++) tick();
    expect(room.log).toHaveLength(24);
    expect(room.log[0]!.batches.map((batch) => batch.slot)).toEqual([0, 1, 2, 3]);
    expect(room.log[0]!.batches.map((batch) => batch.commands)).toEqual(commands);
    expect(room.desyncs).toEqual([]);
    for (const [slot, entity] of first.entries()) expect([entity.x, entity.y]).not.toEqual([initial[slot]!.x, initial[slot]!.y]);
    for (const peer of peers) expect(peer.messages.filter((message) => message.t === 'turn').map((message) => message.turn)).toEqual(Array.from({ length: 24 }, (_, i) => i));
  });

  test('two resignations leave the other two playing; only the final sim victory completes the relay session', () => {
    const { registry, peers, worlds, room, tick } = game(77);
    tick([[{ type: 'resign' }], [], [], []]);
    tick([[], [{ type: 'resign' }], [], []]);
    for (let turn = 2; turn < 8; turn++) tick();
    expect(worlds.every((world) => world.playerStatus(1) === 2 && world.playerStatus(2) === 2)).toBe(true);
    expect(worlds.every((world) => world.gameResult() === null)).toBe(true);
    expect(room.gameOver).toBe(false);
    expect(registry.rooms.get('ABCDE')).toBe(room);
    expect(peers.every((peer) => !peer.messages.some((message) => message.t === 'ended'))).toBe(true);
    tick([[], [], [{ type: 'resign' }], []]);
    for (let turn = 9; turn < 16; turn++) tick();
    expect(worlds.every((world) => JSON.stringify(world.gameResult()?.winners) === '[4]')).toBe(true);
    const turn = worlds[3]!.turn - 1;
    registry.handle(peers[3]!, { t: 'result', turn, hash: worlds[3]!.syncChecksum(), winners: [4] });
    expect(registry.rooms.size).toBe(0);
    for (const peer of peers) expect(peer.messages).toContainEqual({ t: 'ended', reason: 'completed', result: { turn, hash: worlds[3]!.syncChecksum(), winners: [4] } });
  });
});
