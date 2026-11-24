import { describe, expect, test } from 'vitest';
import type { ClientMessage, ServerMessage } from '@aoe/protocol';
import type { Link } from '../net/link';
import { Lockstep, type Timers } from './lockstep';

class TestLink implements Link {
  sent: ClientMessage[] = [];
  handler: (message: ServerMessage) => void = () => {};
  send(message: ClientMessage): void { this.sent.push(message); }
  onMessage(handler: (message: ServerMessage) => void): () => void {
    this.handler = handler;
    return () => { this.handler = () => {}; };
  }
  onClose(): void {}
  close(): void {}
}

class Clock implements Timers {
  now = 0;
  pending: { fn: () => void; at: number }[] = [];
  set(fn: () => void, ms: number): unknown {
    const entry = { fn, at: this.now + ms };
    this.pending.push(entry);
    return entry;
  }
  clear(handle: unknown): void { this.pending = this.pending.filter((entry) => entry !== handle); }
  next(): void {
    const entry = this.pending.reduce((a, b) => a.at <= b.at ? a : b);
    this.pending = this.pending.filter((candidate) => candidate !== entry);
    this.now = entry.at;
    entry.fn();
  }
}

function setup() {
  const link = new TestLink();
  const clock = new Clock();
  const loop = new Lockstep({
    link, timers: clock, now: () => clock.now, frameMs: () => 16,
    start: { seed: 77, commandDelay: 2, playerCount: 4, slot: 3, testMap: true },
  });
  return { link, clock, loop };
}

describe('M04 client result agreement', () => {
  test('a running four-player game does not claim a result', () => {
    const { link, clock, loop } = setup();
    clock.next();
    expect(loop.world.players).toBe(5);
    expect(link.sent.some((message) => message.t === 'result')).toBe(false);
    loop.stop();
  });

  test('reports the actual sim result and same-turn checksum after submitting its turn, and repeats on following turns', () => {
    const { link, clock, loop } = setup();
    // The simulation owns the result; exercise the control channel after it reaches a terminal state.
    loop.world.victory.gameState = 1;
    loop.world.victory.status[4] = 1;
    clock.next();
    const first = link.sent.find((message) => message.t === 'result');
    expect(first).toEqual({ t: 'result', turn: 0, hash: loop.world.syncChecksum(), winners: [4] });
    expect(link.sent.findIndex((message) => message.t === 'turn')).toBeLessThan(link.sent.indexOf(first!));
    clock.next();
    const reports = link.sent.filter((message) => message.t === 'result');
    expect(reports).toHaveLength(2);
    expect(reports[1]).toEqual({ t: 'result', turn: 1, hash: loop.world.syncChecksum(), winners: [4] });
    loop.stop();
  });

  test('rejoin repeats the latest result so a lost vote does not strand an already finished game', () => {
    const { link, clock, loop } = setup();
    loop.world.victory.gameState = 1;
    clock.next();
    link.sent = [];
    link.handler({ t: 'rejoined', nextTurn: 1 });
    expect(link.sent).toContainEqual({ t: 'result', turn: 0, hash: loop.world.syncChecksum(), winners: [] });
    loop.stop();
  });

  test('completed stops timers and networking while preserving the game result screen', () => {
    const { link, clock, loop } = setup();
    const ended: string[] = [];
    loop.onEnded = (reason) => { ended.push(reason); };
    link.handler({ t: 'ended', reason: 'completed', result: { turn: 0, hash: 5, winners: [4] } });
    expect(clock.pending).toEqual([]);
    expect(ended).toEqual([]);
  });

  test('peer-left still notifies the caller of a failed session', () => {
    const { link, loop } = setup();
    const ended: string[] = [];
    loop.onEnded = (reason) => { ended.push(reason); };
    link.handler({ t: 'ended', reason: 'peer-left' });
    expect(ended).toEqual(['peer-left']);
  });
});
