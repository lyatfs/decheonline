import { describe, expect, test } from 'vitest';
import type { ClientMessage, Command, ServerMessage, SpeedChange } from '@aoe/protocol';
import {
  AGE_TOOL,
  ATTR_FOOD,
  ATTR_POPULATION_LIMIT,
  CIV_RANDOM,
  DEFAULT_GAME_SETTINGS,
  DEFAULT_RANDOM_MAP,
  MAP_HILLY,
  RESOURCES_MEDIUM,
  resolveCivs,
  TECH_DONE,
  TOOL_AGE,
  VICTORY_TIME_LIMIT,
  World,
} from '@aoe/sim';
import type { Link } from '../net/link';
import { Lockstep, NOT_RESPONDING_MS, SYNC_INTERVAL_TURNS, type Timers } from './lockstep';

class FakeLink implements Link {
  sent: ClientMessage[] = [];
  handlers: ((m: ServerMessage) => void)[] = [];
  send(m: ClientMessage): void {
    this.sent.push(m);
  }
  onMessage(h: (m: ServerMessage) => void): () => void {
    this.handlers.push(h);
    return () => undefined;
  }
  onClose(): void {}
  close(): void {}
  setResume?: (resume: (() => ClientMessage) | null) => void;
  receive(m: ServerMessage): void {
    for (const h of this.handlers) h(m);
  }
}

/** Timers on a fake clock: `next` jumps the clock to the earliest timer and runs it. */
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

const start = { seed: 77, commandDelay: 2, playerCount: 2 };
const FRAME_MS = 16;

function setup() {
  const link = new FakeLink();
  const timers = new FakeTimers();
  const lockstep = new Lockstep({ link, start, timers, now: () => timers.clock, frameMs: () => FRAME_MS });
  return { link, timers, lockstep };
}

const release = (turn: number, commands: [Command[], Command[]] = [[], []], speed?: SpeedChange): ServerMessage => ({
  t: 'turn',
  turn,
  batches: commands.map((c, slot) => ({ slot, commands: c })),
  ...(speed && { speed }),
});

/** Run timers until `lockstep` has finished `turn`, releasing every submitted turn as the relay would. */
function runThrough(link: FakeLink, timers: FakeTimers, lockstep: Lockstep, turn: number): void {
  while (lockstep.turn <= turn) {
    timers.next();
    for (const m of link.sent.splice(0)) if (m.t === 'turn') link.receive(release(m.turn));
  }
}

describe('lockstep', () => {
  test("the world plays the lobby's map type, size, victory, start settings, population limit and civs, Random resolved from the seed", () => {
    const settings = {
      ...DEFAULT_GAME_SETTINGS,
      mapType: MAP_HILLY,
      mapSize: 72,
      victory: { type: VICTORY_TIME_LIMIT, amount: 3000 },
      startingAge: AGE_TOOL,
      resources: RESOURCES_MEDIUM,
      revealMap: true,
      fullTechTree: true,
      populationLimit: 100,
    };
    const lockstep = new Lockstep({ link: new FakeLink(), start: { ...start, settings, civs: [10, CIV_RANDOM] }, timers: new FakeTimers() });
    const { world } = lockstep;
    expect([world.map.width, world.map.height]).toEqual([72, 72]);
    expect(world.civs).toEqual([0, 10, resolveCivs(start.seed, [10, CIV_RANDOM])[1]]);
    expect(world.victory.type).toBe(VICTORY_TIME_LIMIT);
    expect([world.attributes[1]![ATTR_POPULATION_LIMIT], world.attributes[2]![ATTR_POPULATION_LIMIT]]).toEqual([100, 100]);
    expect([world.attributes[1]![ATTR_FOOD], world.techs[2]![TOOL_AGE], world.visibility.explored[1]]).toEqual([500, TECH_DONE, 72 * 72]);
    const startSettings = { startingAge: AGE_TOOL, resourceLevel: RESOURCES_MEDIUM, deathMatch: false, revealMap: true, fullTechTree: true };
    const options = { players: 3, randomSeed: start.seed, randomMap: { type: MAP_HILLY, size: 72 }, civs: world.civs, victory: settings.victory, populationLimit: 100, ...startSettings };
    expect(world.hash()).toBe(new World(options).hash());
    lockstep.stop();
  });

  test('turns 0 and 1 need no batch; each sends its hash and the commands issued during it', () => {
    const { link, timers, lockstep } = setup();
    expect(link.sent).toEqual([]);
    lockstep.issue({ type: 'test', x: 1, y: 2 });
    timers.next();
    expect(lockstep.turn).toBe(1);
    const hash = lockstep.hashes.get(0)!;
    expect(link.sent).toEqual([
      { t: 'hash', turn: 0, hash },
      { t: 'turn', turn: 0, commands: [{ type: 'test', x: 1, y: 2 }], frameMs: FRAME_MS },
    ]);
    timers.next();
    expect(lockstep.turn).toBe(2);
    expect(timers.clock).toBe(FRAME_MS);
  });

  test('a checksum goes out on every 4th turn only', () => {
    const { link, timers, lockstep } = setup();
    const sent: number[] = [];
    const send = link.send.bind(link);
    link.send = (m) => {
      if (m.t === 'hash') sent.push(m.turn);
      send(m);
    };
    runThrough(link, timers, lockstep, 9);
    expect(sent).toEqual([0, 4, 8]);
    expect([...lockstep.hashes.keys()]).toEqual([0, 4, 8]);
  });

  test('the boundary step of turn N waits for the release of turn N - 2', () => {
    const { link, timers, lockstep } = setup();
    timers.next();
    timers.next();
    timers.next();
    expect(lockstep.turn).toBe(2);
    // Only the not-responding warning is due.
    expect(timers.due.map((t) => t.at - timers.clock)).toEqual([NOT_RESPONDING_MS]);
    link.receive(release(1)); // out of order: turn 0 not released yet
    expect(lockstep.turn).toBe(2);
    link.receive(release(0));
    expect(lockstep.turn).toBe(3);
  });

  test('buffer step k runs k · G ms after the boundary; the next boundary one frame after the last', () => {
    const { link, timers, lockstep } = setup();
    runThrough(link, timers, lockstep, 6);
    const boundary = timers.clock + FRAME_MS;
    timers.next();
    expect([lockstep.turn, lockstep.world.turnStep]).toEqual([7, 2]);
    expect(lockstep.stepMs()).toBe(90);
    const steps: number[] = [];
    while (lockstep.turn === 7) {
      timers.next();
      steps.push(timers.clock - boundary);
    }
    expect(steps).toEqual([90, 180, 270, 360, 450, 540, 630, 720, 810]);
    // After a turn's last step the next one is a frame away.
    expect(lockstep.stepMs()).toBe(FRAME_MS);
    for (const m of link.sent.splice(0)) if (m.t === 'turn') link.receive(release(m.turn));
    timers.next();
    expect(timers.clock - boundary).toBe(810 + FRAME_MS);
    expect(lockstep.turnMs(8)).toBe(810 + FRAME_MS);
  });

  test('a late loop runs every step that is due in one pass; the next turn restarts the clock at its boundary', () => {
    const { link, timers, lockstep } = setup();
    runThrough(link, timers, lockstep, 6);
    timers.next();
    expect([lockstep.turn, lockstep.world.turnStep]).toEqual([7, 2]);
    timers.clock += 5000;
    timers.next();
    expect([lockstep.turn, lockstep.world.turnStep]).toEqual([8, 2]);
    expect(timers.due.map((t) => t.at - timers.clock)).toEqual([90]);
  });

  test('applies both batches and the agreed speed like a World fed the same input', () => {
    const { link, timers, lockstep } = setup();
    const reference = new World({ players: 3, randomSeed: start.seed, randomMap: DEFAULT_RANDOM_MAP, civs: [0, 1, 1] });
    const test = { type: 'test', x: 5, y: 6 } as const;
    const speed = { turn: 12, granularity: 30, frames: 9 };
    for (let turn = 0; turn < 20; turn++) {
      if (turn >= 2) {
        const commands: [Command[], Command[]] = [turn === 3 ? [test] : [], turn === 4 ? [test] : []];
        link.receive(release(turn - 2, commands, turn === 9 ? speed : undefined));
        reference.addBatch(turn - 2, 1, commands[0]);
        reference.addBatch(turn - 2, 2, commands[1]);
        if (turn === 9) reference.setSpeedChange(speed);
      }
      reference.runTurn();
      while (lockstep.turn === turn) timers.next();
      expect(lockstep.hashes.get(turn)).toBe(turn % SYNC_INTERVAL_TURNS === 0 ? reference.syncChecksum() : undefined);
    }
    expect([lockstep.world.granularity, lockstep.world.frames]).toEqual([30, 9]);
    expect(lockstep.turnMs(20)).toBe(8 * 30 + FRAME_MS);
    expect(lockstep.applied.map((c) => c.length)).toEqual([1, 1]);
    expect([...lockstep.world.entities.all()].filter((e) => !e.sprite).map((e) => e.owner)).toEqual([1, 2]);
  });

  test('answers pings, at once or after the debug delay, and keeps the reported round trips', () => {
    const { link, timers, lockstep } = setup();
    link.receive({ t: 'ping', n: 1 });
    expect(link.sent).toEqual([{ t: 'pong', n: 1 }]);
    lockstep.pongDelayMs = 500;
    link.receive({ t: 'ping', n: 2 });
    expect(link.sent).toHaveLength(1);
    while (!link.sent.some((m) => m.t === 'pong' && m.n === 2)) timers.next();
    expect(timers.clock).toBe(500);
    link.receive({ t: 'rtt', rtt: [12, 40], frameMs: [17, 120] });
    expect(lockstep.rtt).toEqual([12, 40]);
    expect(lockstep.frameTimes).toEqual([17, 120]);
  });

  test("a released turn updates every player's frame time", () => {
    const { link, lockstep } = setup();
    link.receive({ t: 'turn', turn: 0, batches: [{ slot: 0, commands: [] }, { slot: 1, commands: [] }], frameMs: [17, 150] });
    expect(lockstep.frameTimes).toEqual([17, 150]);
  });

  test('waiting on a turn warns after 25 s and every 25 s after, until the turn comes', () => {
    const { link, timers, lockstep } = setup();
    let warnings = 0;
    lockstep.onNotResponding = () => warnings++;
    // Turns 0 and 1 run; turn 2 waits for the release of turn 0.
    for (let i = 0; i < 3; i++) timers.next();
    const stalledAt = timers.clock;
    timers.next();
    expect(timers.clock - stalledAt).toBe(NOT_RESPONDING_MS);
    expect(warnings).toBe(1);
    timers.next();
    expect(warnings).toBe(2);
    link.receive(release(0));
    expect(lockstep.turn).toBe(3);
    expect(timers.due.every((t) => t.at - timers.clock < NOT_RESPONDING_MS)).toBe(true);
  });

  test('a rejoin asks for the turns it lacks and sends again the batches the relay never got', () => {
    const link = new FakeLink();
    let resume: (() => ClientMessage) | null = null;
    link.setResume = (r) => (resume = r);
    const timers = new FakeTimers();
    const rejoin = { code: 'ABCD2', slot: 1, token: 'secret' };
    const lockstep = new Lockstep({ link, start: { ...start, rejoin }, timers, now: () => timers.clock, frameMs: () => FRAME_MS });
    for (let i = 0; i < 3; i++) timers.next();
    link.receive(release(0));
    timers.next();
    // Turns 0-2 were sent; only turn 0 was released.
    expect(lockstep.turn).toBe(3);
    expect(resume!()).toEqual({ t: 'rejoin', ...rejoin, received: 1 });
    link.sent.splice(0);
    link.receive({ t: 'rejoined', nextTurn: 2 });
    expect(link.sent).toEqual([{ t: 'turn', turn: 2, commands: [], frameMs: FRAME_MS }]);
    link.receive(release(1));
    link.receive(release(2));
    expect(resume!()).toMatchObject({ received: 3 });
    lockstep.stop();
    expect(resume).toBe(null);
  });

  test('desync and ended stop the loop and notify', () => {
    const { link, timers, lockstep } = setup();
    let desync: number | undefined;
    lockstep.onDesync = (turn) => (desync = turn);
    link.receive({ t: 'desync', turn: 9, hashes: [1, 2] });
    expect(desync).toBe(9);
    expect(timers.due).toEqual([]);
    link.receive(release(0));
    expect(lockstep.turn).toBe(0);
  });

  test('stopping from a turn callback leaves no scheduled steps or later commands', () => {
    const { link, timers, lockstep } = setup();
    lockstep.onTurn = () => lockstep.stop();
    timers.next();
    expect(lockstep.turn).toBe(1);
    expect(timers.due).toEqual([]);
    expect(link.sent.filter((m) => m.t === 'turn').map((m) => m.turn)).toEqual([0]);
  });

  test('quit sends the batch of the turn under way with the queued commands and the resign, then stops', () => {
    const { link, timers, lockstep } = setup();
    runThrough(link, timers, lockstep, 2);
    link.sent.splice(0);
    lockstep.issue({ type: 'test', x: 1, y: 2 });
    lockstep.quit([{ type: 'resign' }]);
    expect(link.sent).toEqual([{ t: 'turn', turn: 3, commands: [{ type: 'test', x: 1, y: 2 }, { type: 'resign' }] }]);
    expect(timers.due).toEqual([]);
    lockstep.quit([{ type: 'resign' }]);
    expect(link.sent).toHaveLength(1);
  });
});

describe('lockstep synchronized pause (Q01-Q05)', () => {
  function spSetup(slot = 0, mode: 'single-player' | 'multiplayer' = 'single-player') {
    const link = new FakeLink();
    const timers = new FakeTimers();
    const lockstep = new Lockstep({
      link,
      start: { ...start, mode, slot },
      timers,
      now: () => timers.clock,
      frameMs: () => FRAME_MS,
    });
    return { link, timers, lockstep };
  }

  test('Q01: pause at startup (boundary = 2) halts at turn 2 turnStep 0 with batches 0 & 1 sent', () => {
    const { link, timers, lockstep } = spSetup(0, 'single-player');
    link.receive({ t: 'paused', paused: true, boundary: 2, epoch: 1 });
    expect(lockstep.isPaused()).toBe(true);

    // Run turns 0 and 1
    while (timers.due.length > 0 && lockstep.turn < 2) timers.next();
    // Run any immediate boundary pump
    while (timers.due.length > 0) timers.next();

    expect(lockstep.turn).toBe(2);
    expect(lockstep.world.turnStep).toBe(0);
    expect(link.sent.filter((m) => m.t === 'turn').map((m) => (m.t === 'turn' ? m.turn : -1))).toEqual([0, 1]);
    expect(timers.due).toEqual([]);
  });

  test('Q04: resigning at the pause barrier resumes the control channel and sends the queued resign', () => {
    const { link, timers, lockstep } = spSetup();
    link.receive({ t: 'paused', paused: true, boundary: 2, epoch: 1 });
    while (timers.due.length > 0) timers.next();
    expect(lockstep.turn).toBe(2);
    link.sent = [];

    lockstep.issue({ type: 'resign' });
    expect(link.sent).toEqual([{ t: 'pause', paused: false, epoch: 1 }]);
    link.receive({ t: 'paused', paused: false, boundary: 2, epoch: 2 });
    link.receive(release(0));
    expect(link.sent).toContainEqual({ t: 'turn', turn: 2, commands: [{ type: 'resign' }], frameMs: FRAME_MS });
    lockstep.stop();
  });

  test('Q04: resigning while a pause acknowledgement is pending resumes as soon as pause is confirmed', () => {
    const { link, lockstep } = spSetup();
    expect(lockstep.requestPause(true)).toBe(true);
    lockstep.issue({ type: 'resign' });
    expect(link.sent).toEqual([{ t: 'pause', paused: true, epoch: 0 }]);
    link.receive({ t: 'paused', paused: true, boundary: 2, epoch: 1 });
    expect(link.sent).toEqual([
      { t: 'pause', paused: true, epoch: 0 },
      { t: 'pause', paused: false, epoch: 1 },
    ]);
    lockstep.stop();
  });

  test('Q01/Q02/Q03: long pause suppresses stall warnings, keeps ping/pong alive, avoids catch-up burst, and keeps two peers deterministic', () => {
    const timers = new FakeTimers();
    const hostLink = new FakeLink();
    const botLink = new FakeLink();
    const host = new Lockstep({
      link: hostLink,
      start: { ...start, mode: 'single-player', slot: 0 },
      timers,
      now: () => timers.clock,
      frameMs: () => FRAME_MS,
    });
    const bot = new Lockstep({
      link: botLink,
      start: { ...start, mode: 'single-player', slot: 1 },
      timers,
      now: () => timers.clock,
      frameMs: () => FRAME_MS,
    });

    let hostWarnings = 0;
    let botWarnings = 0;
    host.onNotResponding = () => hostWarnings++;
    bot.onNotResponding = () => botWarnings++;
    const pauseEvents: boolean[] = [];
    host.onPauseChange = (p) => pauseEvents.push(p);

    // Advance both peers through turn 4 (turns 0..4 released, log.length = 5)
    const sentBySlot = [new Map<number, Command[]>(), new Map<number, Command[]>()];
    let nextRelease = 0;
    while (host.turn <= 4 || bot.turn <= 4) {
      timers.next();
      for (const m of hostLink.sent.splice(0)) if (m.t === 'turn') sentBySlot[0]!.set(m.turn, m.commands);
      for (const m of botLink.sent.splice(0)) if (m.t === 'turn') sentBySlot[1]!.set(m.turn, m.commands);
      while (sentBySlot[0]!.has(nextRelease) && sentBySlot[1]!.has(nextRelease)) {
        const msg = release(nextRelease, [sentBySlot[0]!.get(nextRelease)!, sentBySlot[1]!.get(nextRelease)!]);
        hostLink.receive(msg);
        botLink.receive(msg);
        nextRelease++;
      }
    }
    expect(host.turn).toBe(5);
    expect(bot.turn).toBe(5);
    expect(nextRelease).toBe(5);

    // Host issues a command during turn 5 and requests pause
    host.issue({ type: 'test', x: 4, y: 5 });
    expect(host.togglePause()).toBe(true);
    expect(hostLink.sent.some((m) => m.t === 'pause' && m.paused === true && m.epoch === 0)).toBe(true);
    hostLink.sent.splice(0);

    // Server broadcasts paused at boundary = 7 (log.length 5 + COMMAND_DELAY_TURNS 2)
    const pauseMsg: ServerMessage = { t: 'paused', paused: true, boundary: 7, epoch: 1 };
    hostLink.receive(pauseMsg);
    botLink.receive(pauseMsg);
    expect(pauseEvents).toEqual([true]);

    // Coast both peers to turn 7 turnStep 0
    while (timers.due.length > 0) {
      timers.next();
      for (const m of hostLink.sent.splice(0)) if (m.t === 'turn') sentBySlot[0]!.set(m.turn, m.commands);
      for (const m of botLink.sent.splice(0)) if (m.t === 'turn') sentBySlot[1]!.set(m.turn, m.commands);
    }

    expect(host.turn).toBe(7);
    expect(host.world.turnStep).toBe(0);
    expect(bot.turn).toBe(7);
    expect(bot.world.turnStep).toBe(0);
    expect(timers.due).toEqual([]);

    // Q02: Advance fake clock by 5 * NOT_RESPONDING_MS during pause -> zero stall warnings, worldTime frozen, ping/pong still works
    const pausedTime = host.world.worldTime;
    const pausedBase = host.baseTime;
    timers.clock += NOT_RESPONDING_MS * 5;
    expect(hostWarnings).toBe(0);
    expect(botWarnings).toBe(0);
    expect(host.world.worldTime).toBe(pausedTime);
    expect(host.baseTime).toBe(pausedBase);

    hostLink.receive({ t: 'ping', n: 42 });
    expect(hostLink.sent).toEqual([{ t: 'pong', n: 42 }]);
    hostLink.sent.splice(0);

    // Q03: Resume after long pause; release held turns 5 and 6 -> NO catch-up burst!
    const resumeClock = timers.clock;
    const resumeMsg: ServerMessage = { t: 'paused', paused: false, boundary: 7, epoch: 2 };
    hostLink.receive(resumeMsg);
    botLink.receive(resumeMsg);
    expect(pauseEvents).toEqual([true, false]);

    // Release turns 5 & 6 as server does on resume
    for (const t of [5, 6]) {
      const msg = release(t, [sentBySlot[0]!.get(t)!, sentBySlot[1]!.get(t)!]);
      hostLink.receive(msg);
      botLink.receive(msg);
    }

    // Immediately after resume, turn 7 has started step 0 & 1 (turnStep === 2, NO burst of turns 7, 8, 9, ...)
    expect(host.turn).toBe(7);
    expect(host.world.turnStep).toBe(2);
    expect(bot.turn).toBe(7);
    expect(bot.world.turnStep).toBe(2);
    // Next buffer step is scheduled ~90ms in the future from resumeClock (not in the past)
    expect(timers.due.every((t) => t.at >= resumeClock + 90)).toBe(true);

    // Continue both peers through turn 8 and verify matching sync checksums and executed command from turn 5
    while (host.turn <= 8 || bot.turn <= 8) {
      timers.next();
      for (const m of hostLink.sent.splice(0)) if (m.t === 'turn') sentBySlot[0]!.set(m.turn, m.commands);
      for (const m of botLink.sent.splice(0)) if (m.t === 'turn') sentBySlot[1]!.set(m.turn, m.commands);
      for (const t of [7, 8]) {
        if (sentBySlot[0]!.has(t) && sentBySlot[1]!.has(t)) {
          const msg = release(t, [sentBySlot[0]!.get(t)!, sentBySlot[1]!.get(t)!]);
          sentBySlot[0]!.delete(t);
          sentBySlot[1]!.delete(t);
          hostLink.receive(msg);
          botLink.receive(msg);
        }
      }
    }

    expect(host.hashes.get(8)).toBe(bot.hashes.get(8));
    expect([...host.world.entities.all()].filter((e) => !e.sprite).map((e) => e.owner)).toEqual([1]);
    expect([...bot.world.entities.all()].filter((e) => !e.sprite).map((e) => e.owner)).toEqual([1]);
  });

  test('Q04: multiplayer, bot slot, gameOver, and stale/duplicate epochs cannot corrupt pause state', () => {
    const mp = spSetup(0, 'multiplayer');
    expect(mp.lockstep.togglePause()).toBe(false);
    expect(mp.link.sent).toEqual([]);

    const bot = spSetup(1, 'single-player');
    expect(bot.lockstep.togglePause()).toBe(false);
    expect(bot.link.sent).toEqual([]);

    const sp = spSetup(0, 'single-player');
    expect(sp.lockstep.togglePause()).toBe(true);
    // Rapid second F3 while pending does not send a second pause message
    expect(sp.lockstep.togglePause()).toBe(false);
    expect(sp.link.sent).toEqual([{ t: 'pause', paused: true, epoch: 0 }]);

    sp.link.receive({ t: 'paused', paused: true, boundary: 2, epoch: 2 });
    // Stale epoch 1 and duplicate epoch 2 ignored
    sp.link.receive({ t: 'paused', paused: false, boundary: 0, epoch: 1 });
    sp.link.receive({ t: 'paused', paused: false, boundary: 0, epoch: 2 });
    expect(sp.lockstep.isPaused()).toBe(true);

    // Game over blocks toggling pause
    sp.lockstep.world.victory.gameState = 1;
    expect(sp.lockstep.togglePause()).toBe(false);
  });

  test('Q03: pause and unpause arriving mid-turn before reaching boundary preserve turn timing', () => {
    const { link, timers, lockstep } = spSetup(0, 'single-player');
    runThrough(link, timers, lockstep, 6);
    const boundary = timers.clock + FRAME_MS;
    timers.next();
    expect([lockstep.turn, lockstep.world.turnStep]).toEqual([7, 2]);

    // Pause arrives mid-turn at turn 7 with boundary 9, then unpause arrives mid-turn before boundary 9
    link.receive({ t: 'paused', paused: true, boundary: 9, epoch: 1 });
    expect(lockstep.isPaused()).toBe(true);
    timers.next();
    expect([lockstep.turn, lockstep.world.turnStep, timers.clock - boundary]).toEqual([7, 3, 90]);

    link.receive({ t: 'paused', paused: false, boundary: 9, epoch: 2 });
    expect(lockstep.isPaused()).toBe(false);

    const remainingSteps: number[] = [];
    while (lockstep.turn === 7) {
      timers.next();
      remainingSteps.push(timers.clock - boundary);
      for (const m of link.sent.splice(0)) if (m.t === 'turn') link.receive(release(m.turn));
    }
    expect(remainingSteps).toEqual([180, 270, 360, 450, 540, 630, 720, 810]);
    for (const m of link.sent.splice(0)) if (m.t === 'turn') link.receive(release(m.turn));
    timers.next();
    expect(lockstep.turn).toBe(8);
    expect(timers.clock - boundary).toBe(810 + FRAME_MS);

    runThrough(link, timers, lockstep, 10);
    expect(lockstep.turn).toBe(11);
  });

  test('Q04: unrelated server error during in-flight pause keeps pending until paused or pause error arrives', () => {
    const { link, lockstep } = spSetup(0, 'single-player');
    expect(lockstep.togglePause()).toBe(true);
    expect(lockstep.pause.pending).toBe(true);

    // Unrelated error (e.g., bad-turn) must not clear pending or allow a duplicate stale-epoch pause send
    link.receive({ t: 'error', code: 'bad-turn', message: 'unrelated turn error' });
    expect(lockstep.pause.pending).toBe(true);
    expect(lockstep.togglePause()).toBe(false);
    expect(link.sent).toEqual([{ t: 'pause', paused: true, epoch: 0 }]);

    // Server ack clears pending and advances epoch
    link.receive({ t: 'paused', paused: true, boundary: 2, epoch: 1 });
    expect(lockstep.pause.pending).toBe(false);
    expect(lockstep.isPaused()).toBe(true);

    // Pause-specific error (e.g., locked) clears pending cleanly
    expect(lockstep.togglePause()).toBe(true);
    expect(lockstep.pause.pending).toBe(true);
    link.receive({ t: 'error', code: 'locked', message: 'cannot pause after game over' });
    expect(lockstep.pause.pending).toBe(false);
    expect(lockstep.isPaused()).toBe(true);
  });

  test('Q05: rejoined restores pause state and halts/resumes without stall', () => {
    const { link, timers, lockstep } = spSetup(0, 'single-player');
    runThrough(link, timers, lockstep, 3);
    expect(lockstep.turn).toBe(4);

    // Client missed paused message while disconnected; rejoin brings pause snapshot at boundary = 5
    link.receive({
      t: 'rejoined',
      nextTurn: 4,
      mode: 'single-player',
      paused: true,
      pauseBoundary: 5,
      pauseEpoch: 1,
    });
    expect(lockstep.isPaused()).toBe(true);

    while (timers.due.length > 0) {
      timers.next();
      for (const m of link.sent.splice(0)) if (m.t === 'turn' && m.turn < 3) link.receive(release(m.turn));
    }
    expect(lockstep.turn).toBe(5);
    expect(lockstep.world.turnStep).toBe(0);
    expect(timers.due).toEqual([]);

    // Rejoin after resume recovers paused: false and resumes cleanly
    timers.clock += 50_000;
    link.receive({
      t: 'rejoined',
      nextTurn: 5,
      mode: 'single-player',
      paused: false,
      pauseBoundary: 5,
      pauseEpoch: 2,
    });
    expect(lockstep.isPaused()).toBe(false);
    link.receive(release(3));
    expect(lockstep.turn).toBe(6);
    expect(lockstep.world.turnStep).toBe(0);
  });
});

describe('lockstep game speed and double-speed regression (S01-S04)', () => {
  function runWithCommands(link: FakeLink, timers: FakeTimers, lockstep: Lockstep, throughTurn: number): void {
    while (lockstep.turn <= throughTurn) {
      timers.next();
      for (const m of link.sent.splice(0)) {
        if (m.t === 'turn') link.receive(release(m.turn, [m.commands, []]));
      }
    }
  }

  test('S01: World applies gameSpeed once; paceScale does not divide by gameSpeed (no gameSpeed²)', () => {
    const { link, timers, lockstep } = setup();
    // Run past SINGLE_STEP_TURNS (0..6) into steady buffered turns (G=90, F=10, FRAME_MS=16).
    runWithCommands(link, timers, lockstep, 7);

    const measureTurns = (count: number) => {
      const startClock = timers.clock;
      const startBase = lockstep.baseTime;
      const startGame = lockstep.world.worldTime;
      const targetTurn = lockstep.turn + count;
      runWithCommands(link, timers, lockstep, targetTurn - 1);
      const dt = timers.clock - startClock;
      const dBase = lockstep.baseTime - startBase;
      const dGame = lockstep.world.worldTime - startGame;
      return { dt, dBase, dGame, baseRate: dBase / dt, gameRate: dGame / dt };
    };

    const base1 = measureTurns(4);
    expect(lockstep.stepMs()).toBe(FRAME_MS);
    expect(lockstep.turnMs(lockstep.turn)).toBe(9 * 90 + FRAME_MS);

    for (const speed of [0.5, 1.5, 2, 4]) {
      lockstep.issue({ type: 'game-speed', speed });
      runWithCommands(link, timers, lockstep, lockstep.turn + 2);
      expect(lockstep.world.gameSpeed).toBe(speed);

      const m = measureTurns(4);
      // baseTime pacing stays unchanged (~1x of 1.0 baseline, NOT shrunk by gameSpeed)
      expect(m.baseRate / base1.baseRate).toBeCloseTo(1, 5);
      // gameTime / realTime scales linearly with gameSpeed (NOT gameSpeed²)
      expect(m.gameRate / base1.gameRate).toBeCloseTo(speed, 5);
      expect(m.dGame / m.dBase).toBeCloseTo(speed, 5);
      expect(lockstep.turnMs(lockstep.turn)).toBe(9 * 90 + FRAME_MS);
    }

    lockstep.stop();
  });

  test('S03: changing speed while paused and mid-game applies at the exact agreed turn boundary for both peers without burst', () => {
    const timers = new FakeTimers();
    const hostLink = new FakeLink();
    const botLink = new FakeLink();
    const host = new Lockstep({
      link: hostLink,
      start: { ...start, mode: 'single-player', slot: 0 },
      timers,
      now: () => timers.clock,
      frameMs: () => FRAME_MS,
    });
    const bot = new Lockstep({
      link: botLink,
      start: { ...start, mode: 'single-player', slot: 1 },
      timers,
      now: () => timers.clock,
      frameMs: () => FRAME_MS,
    });

    const sentBySlot = [new Map<number, Command[]>(), new Map<number, Command[]>()];
    let nextRelease = 0;
    const drainAndRelease = (maxTurn: number) => {
      for (const m of hostLink.sent.splice(0)) if (m.t === 'turn') sentBySlot[0]!.set(m.turn, m.commands);
      for (const m of botLink.sent.splice(0)) if (m.t === 'turn') sentBySlot[1]!.set(m.turn, m.commands);
      while (nextRelease <= maxTurn && sentBySlot[0]!.has(nextRelease) && sentBySlot[1]!.has(nextRelease)) {
        const msg = release(nextRelease, [sentBySlot[0]!.get(nextRelease)!, sentBySlot[1]!.get(nextRelease)!]);
        hostLink.receive(msg);
        botLink.receive(msg);
        nextRelease++;
      }
    };

    while (host.turn <= 7 || bot.turn <= 7) {
      timers.next();
      drainAndRelease(7);
    }
    expect([host.turn, bot.turn]).toEqual([8, 8]);

    // Pause at log.length = 8 -> pauseBoundary = 10
    const pauseMsg: ServerMessage = { t: 'paused', paused: true, boundary: 10, epoch: 1 };
    hostLink.receive(pauseMsg);
    botLink.receive(pauseMsg);

    // Coast to boundary 10 (holding turns 8 and 9)
    while (timers.due.length > 0) {
      timers.next();
      for (const m of hostLink.sent.splice(0)) if (m.t === 'turn') sentBySlot[0]!.set(m.turn, m.commands);
      for (const m of botLink.sent.splice(0)) if (m.t === 'turn') sentBySlot[1]!.set(m.turn, m.commands);
    }
    expect([host.turn, host.world.turnStep, bot.turn, bot.world.turnStep]).toEqual([10, 0, 10, 0]);

    // Change speed while paused at boundary 10 -> queued for turn 10, executes at turn 12 (10 + CTI=2)
    host.issue({ type: 'game-speed', speed: 2.5 });
    timers.clock += 30_000;
    expect(host.world.gameSpeed).toBe(1);
    expect(bot.world.gameSpeed).toBe(1);

    // Resume: release held turns 8 & 9 -> no catch-up burst
    const resumeClock = timers.clock;
    const resumeMsg: ServerMessage = { t: 'paused', paused: false, boundary: 10, epoch: 2 };
    hostLink.receive(resumeMsg);
    botLink.receive(resumeMsg);
    drainAndRelease(9);

    expect([host.turn, host.world.turnStep]).toEqual([10, 2]);
    expect([bot.turn, bot.world.turnStep]).toEqual([10, 2]);
    expect(timers.due.every((t) => t.at >= resumeClock + 90)).toBe(true);

    // Advance through turn 11 (still speed 1.0)
    while (host.turn <= 11 || bot.turn <= 11) {
      timers.next();
      drainAndRelease(11);
    }
    expect(host.world.gameSpeed).toBe(1);
    expect(bot.world.gameSpeed).toBe(1);

    // Boundary step of turn 12 applies 2.5 on both peers simultaneously
    while (host.turn < 12 || host.world.turnStep === 0 || bot.turn < 12 || bot.world.turnStep === 0) {
      timers.next();
      drainAndRelease(12);
    }
    expect(host.world.gameSpeed).toBe(2.5);
    expect(bot.world.gameSpeed).toBe(2.5);

    // Mid-game speed change to 0.75 while running -> applied identically on turn 14
    host.issue({ type: 'game-speed', speed: 0.75 });
    while (host.turn <= 16 || bot.turn <= 16) {
      timers.next();
      drainAndRelease(16);
    }
    expect(host.world.gameSpeed).toBe(0.75);
    expect(bot.world.gameSpeed).toBe(0.75);
    expect(host.world.worldTime).toBe(bot.world.worldTime);
    expect(host.hashes.get(12)).toBe(bot.hashes.get(12));
    expect(host.hashes.get(16)).toBe(bot.hashes.get(16));

    host.stop();
    bot.stop();
  });

  test('S04: debug baseSpeed and server G/F retunes preserve buffer pacing and matching checksums across gameSpeed changes', () => {
    const timers = new FakeTimers();
    const hostLink = new FakeLink();
    const botLink = new FakeLink();
    const debugBaseSpeed = 2;
    const host = new Lockstep({
      link: hostLink,
      start: { ...start, mode: 'single-player', slot: 0 },
      speed: debugBaseSpeed,
      timers,
      now: () => timers.clock,
      frameMs: () => FRAME_MS,
    });
    const bot = new Lockstep({
      link: botLink,
      start: { ...start, mode: 'single-player', slot: 1 },
      speed: debugBaseSpeed,
      timers,
      now: () => timers.clock,
      frameMs: () => FRAME_MS,
    });

    const sentBySlot = [new Map<number, Command[]>(), new Map<number, Command[]>()];
    let nextRelease = 0;
    const retunes = new Map<number, SpeedChange>([
      [21, { turn: 24, granularity: 30, frames: 9 }],
      [27, { turn: 30, granularity: 20, frames: 13 }],
    ]);

    const stepAndRelay = (targetTurn: number) => {
      while (host.turn <= targetTurn || bot.turn <= targetTurn) {
        timers.next();
        for (const m of hostLink.sent.splice(0)) if (m.t === 'turn') sentBySlot[0]!.set(m.turn, m.commands);
        for (const m of botLink.sent.splice(0)) if (m.t === 'turn') sentBySlot[1]!.set(m.turn, m.commands);
        while (sentBySlot[0]!.has(nextRelease) && sentBySlot[1]!.has(nextRelease)) {
          const msg = release(
            nextRelease,
            [sentBySlot[0]!.get(nextRelease)!, sentBySlot[1]!.get(nextRelease)!],
            retunes.get(nextRelease),
          );
          hostLink.receive(msg);
          botLink.receive(msg);
          nextRelease++;
        }
      }
    };

    stepAndRelay(8);
    expect(host.stepMs()).toBe(FRAME_MS / debugBaseSpeed);

    // Measure at 1.0x before retune (G=90, F=10)
    const t0 = timers.clock;
    const b0 = host.baseTime;
    stepAndRelay(12);
    const baseRateBefore = (host.baseTime - b0) / (timers.clock - t0);
    expect(host.turnMs(13)).toBe((9 * 90 + FRAME_MS) / debugBaseSpeed);

    // Change to 3.0x across both retunes (turns 24 -> 30)
    host.issue({ type: 'game-speed', speed: 3 });
    stepAndRelay(31);
    expect([host.world.granularity, host.world.frames, host.world.gameSpeed]).toEqual([20, 13, 3]);
    expect([bot.world.granularity, bot.world.frames, bot.world.gameSpeed]).toEqual([20, 13, 3]);
    expect(host.turnMs(32)).toBe((12 * 20 + FRAME_MS) / debugBaseSpeed);

    // Measure at 3.0x after retune (G=20, F=13): baseTime still scales by debugBaseSpeed (NOT gameSpeed!)
    const t1 = timers.clock;
    const b1 = host.baseTime;
    const g1 = host.world.worldTime;
    stepAndRelay(35);
    const dt = timers.clock - t1;
    const dBase = host.baseTime - b1;
    const dGame = host.world.worldTime - g1;
    // Exact steady-state turn: base = 14 * 20 = 280 ms, wall = (12 * 20 + 16) / 2 = 128 ms -> dBase/dt = 280/128 = 2.1875
    expect(dBase / dt).toBeCloseTo((14 * 20) / ((12 * 20 + FRAME_MS) / debugBaseSpeed), 5);
    expect(dGame / dBase).toBeCloseTo(3, 5);
    expect(dBase / dt).toBeGreaterThan(baseRateBefore * 0.8);
    expect(dBase / dt).toBeLessThan(baseRateBefore * 1.2);

    // Sync checksums match on every sync interval turn
    for (const syncTurn of [0, 4, 8, 12, 16, 20, 24, 28, 32]) {
      expect(host.hashes.get(syncTurn)).toBe(bot.hashes.get(syncTurn));
    }

    host.stop();
    bot.stop();
  });
});
