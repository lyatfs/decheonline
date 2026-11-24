import { describe, expect, test } from 'vitest';
import type { ClientMessage, Command, ServerMessage } from '@aoe/protocol';
import {
  ATTR_FOOD,
  ATTR_GOLD,
  ATTR_HEADROOM,
  ATTR_WOOD,
  BARRACKS,
  CIV_EGYPTIAN,
  CIV_GREEK,
  CLUBMAN,
  COMMAND_DELAY_TURNS,
  DEFAULT_GAME_SETTINGS,
  FORAGE,
  GRANARY,
  HOUSE,
  ObjectState,
  startingObjects,
  TECH_DONE,
  TileMap,
  TOOL_AGE,
  TOWN_CENTER,
  VICTORY_SPECIAL,
  VILLAGER,
  World,
  type StartUnit,
} from '@aoe/sim';
import { Lockstep, type Timers } from '../lockstep';
import type { Link } from '../net/link';
import {
  AiBot,
  BOT_CONTRACT_VERSION,
  createArbiterState,
  createBotObservation,
  createEconomyPlanner,
  createProgressionPlanner,
  createResearchPlanner,
  createSquadPlanner,
  getBotProfile,
  shouldThinkAtTime,
} from './index';

function economyWorld(villagers = 3): World {
  const units: StartUnit[] = [
    { owner: 2, type: TOWN_CENTER, x: 10.5, y: 10.5 },
    { owner: 2, type: HOUSE, x: 6.5, y: 10.5 },
    { owner: 0, type: FORAGE, x: 14.5, y: 10.5 },
  ];
  for (let i = 0; i < villagers; i++) units.push({ owner: 2, type: VILLAGER, x: 8.5, y: 12.5 + i });
  const world = new World({ players: 3, map: new TileMap(48, 48), units, victory: { type: VICTORY_SPECIAL } });
  world.attributes[2]![ATTR_HEADROOM] = 30;
  return world;
}

describe('AiBot Phase 2 integration', () => {
  test('uses the selected profile to cap actual villager production', () => {
    const world = economyWorld(14);
    world.attributes[2]![ATTR_FOOD] = 100;
    world.attributes[2]![ATTR_WOOD] = 0;
    const easy = new AiBot('', { difficulty: 'easy' });
    const hard = new AiBot('', { difficulty: 'hard' });
    expect(easy.step(world).some((c) => c.type === 'queue' && c.unit === VILLAGER)).toBe(false);
    expect(hard.step(world).some((c) => c.type === 'queue' && c.unit === VILLAGER)).toBe(true);
  });

  test('reserves production through real command delay without issuing duplicates', () => {
    const world = economyWorld();
    world.attributes[2]![ATTR_WOOD] = 0;
    const bot = new AiBot('', { difficulty: 'hard' });
    const first = bot.step(world);
    const queued = first.filter((c) => c.type === 'queue');
    expect(queued).toHaveLength(1);
    world.addBatch(world.turn, 2, first);
    expect(bot.step(world)).toHaveLength(0);
    for (let i = 0; i < COMMAND_DELAY_TURNS; i++) {
      world.runTurn();
      expect(bot.step(world).some((c) => c.type === 'queue')).toBe(false);
    }
    world.runTurn();
    const tc = [...world.entities.ofPlayer(2)].find((e) => e.type === TOWN_CENTER)!;
    expect(tc.train).not.toBeNull();
    expect(world.attributes[2]![ATTR_FOOD]).toBeLessThan(200);
  });

  test('keeps an undersized Easy squad forming while Hard launches the same army', () => {
    const world = new World({ players: 3, map: new TileMap(48, 48), units: [
      { owner: 2, type: TOWN_CENTER, x: 10.5, y: 10.5 },
      ...[0, 1, 2].map((i) => ({ owner: 2, type: CLUBMAN, x: 13.5, y: 10.5 + i })),
      { owner: 1, type: TOWN_CENTER, x: 40.5, y: 10.5 },
    ], victory: { type: VICTORY_SPECIAL } });
    world.visibility.exploreAll(2);
    world.visibility.exploreRect(2, 37, 8, 44, 14);

    const easy = new AiBot('', { difficulty: 'easy' });
    const hard = new AiBot('', { difficulty: 'hard' });
    const easyCommands = easy.step(world);
    const hardCommands = hard.step(world);
    expect(easyCommands.some((c) => c.type === 'attack')).toBe(false);
    expect(hardCommands.some((c) => c.type === 'attack')).toBe(true);
    expect([...world.entities.ofPlayer(2)].every((e) => e.state === ObjectState.Active)).toBe(true);
  });

  test('saves food for an available age instead of endlessly extending the villager queue', () => {
    const world = economyWorld(10);
    world.techs[2]![101] = 1;
    world.attributes[2]![ATTR_FOOD] = 100;
    world.attributes[2]![ATTR_WOOD] = 0;
    const bot = new AiBot('', { difficulty: 'hard' });
    expect(bot.step(world).some((c) => c.type === 'queue' && c.unit === VILLAGER)).toBe(false);
  });

  test('destroy prevents later evaluations from producing commands', () => {
    const bot = new AiBot('', { difficulty: 'hard' });
    const world = economyWorld();
    expect(bot.step(world).length).toBeGreaterThan(0);
    bot.destroy();
    expect(bot.step(world)).toEqual([]);
  });
});

class FakeLink implements Link {
  sent: ClientMessage[] = [];
  private handlers: ((m: ServerMessage) => void)[] = [];
  private resumeFn: (() => ClientMessage) | null = null;
  send(m: ClientMessage): void {
    this.sent.push(m);
  }
  onMessage(h: (m: ServerMessage) => void): () => void {
    this.handlers.push(h);
    return () => {
      this.handlers = this.handlers.filter((fn) => fn !== h);
    };
  }
  onClose(): void {}
  close(): void {}
  setResume(resume: (() => ClientMessage) | null): void {
    this.resumeFn = resume;
  }
  triggerResume(): ClientMessage | null {
    return this.resumeFn ? this.resumeFn() : null;
  }
  receive(m: ServerMessage): void {
    for (const h of this.handlers) h(m);
  }
}

class FakeTimers implements Timers {
  clock = 0;
  due: { fn: () => void; at: number }[] = [];
  set(fn: () => void, ms: number): unknown {
    const t = { fn, at: this.clock + ms };
    this.due.push(t);
    return t;
  }
  clear(handle: unknown): void {
    this.due = this.due.filter((t) => t !== handle);
  }
  next(): void {
    const t = this.due.reduce((a, b) => (b.at < a.at ? b : a));
    this.due = this.due.filter((x) => x !== t);
    this.clock = Math.max(this.clock, t.at);
    t.fn();
  }
}

function flushRelayTurns(
  hostLink: FakeLink,
  guestLink: FakeLink,
  sentBySlot: [Map<number, Command[]>, Map<number, Command[]>],
  log: ServerMessage[],
  nextRelease: number,
): number {
  for (const m of hostLink.sent.splice(0)) {
    if (m.t === 'turn') sentBySlot[0]!.set(m.turn, m.commands);
  }
  for (const m of guestLink.sent.splice(0)) {
    if (m.t === 'turn') sentBySlot[1]!.set(m.turn, m.commands);
  }
  while (sentBySlot[0]!.has(nextRelease) && sentBySlot[1]!.has(nextRelease)) {
    const b0 = sentBySlot[0]!.get(nextRelease)!;
    const b1 = sentBySlot[1]!.get(nextRelease)!;
    const msg: ServerMessage = {
      t: 'turn',
      turn: nextRelease,
      batches: [
        { slot: 0, commands: b0 },
        { slot: 1, commands: b1 },
      ],
    };
    log.push(msg);
    hostLink.receive(msg);
    guestLink.receive(msg);
    nextRelease++;
  }
  return nextRelease;
}

describe('T11 Integration (I01–I04)', () => {
  test('I01: barrel exports and all 4 planners are wired into AiBot.step without mutating World', () => {
    expect(BOT_CONTRACT_VERSION).toBe('phase2-v1');
    expect(createArbiterState().pending).toEqual([]);
    expect(createProgressionPlanner().name).toBe('progression');
    expect(createEconomyPlanner().name).toBe('economy');
    expect(createResearchPlanner().name).toBe('research');
    expect(createSquadPlanner().name).toBe('squads');

    const world = new World({ players: 3, units: startingObjects(3), victory: { type: VICTORY_SPECIAL } });
    world.attributes[2]![ATTR_FOOD] = 2500;
    world.attributes[2]![ATTR_WOOD] = 1500;
    world.attributes[2]![ATTR_GOLD] = 800;
    world.cheats.quickBuild = true;
    world.visibility.exploreAll(2);

    const bot = new AiBot('', { difficulty: 'hard', civ: CIV_GREEK, player: 2 });
    const trace: Command[] = [];
    for (let i = 0; i < 520; i++) {
      if (i % 2 === 0) {
        const checksumBefore = world.syncChecksum();
        const cmds = bot.step(world);
        // AiBot.step must NEVER directly mutate World
        expect(world.syncChecksum()).toBe(checksumBefore);
        if (cmds.length > 0) {
          trace.push(...cmds);
          world.addBatch(world.turn, 2, cmds);
        }
      }
      world.runTurn();
    }

    // Verify all 4 planners produced real World consequences through COMMAND_DELAY_TURNS
    const p2Entities = [...world.entities.ofPlayer(2)].filter((e) => e.state === ObjectState.Active);
    const villagers = p2Entities.filter((e) => e.type === VILLAGER || e.type === 118 || e.type === 120 || e.type === 123 || e.type === 124);
    const military = p2Entities.filter((e) => e.type === CLUBMAN || e.type === 4 || e.type === 75 || e.type === 299 || e.type === 37 || e.type === 93);
    expect(villagers.length).toBeGreaterThan(3); // EconomyPlanner trained villagers
    expect(trace.some((c) => c.type === 'work')).toBe(true); // EconomyPlanner assigned gatherers
    expect(p2Entities.some((e) => e.type === HOUSE)).toBe(true); // ProgressionPlanner built House
    expect(p2Entities.some((e) => e.type === GRANARY)).toBe(true);
    expect(p2Entities.some((e) => e.type === BARRACKS)).toBe(true);
    expect(world.techs[2]![TOOL_AGE]).toBe(TECH_DONE); // ProgressionPlanner researched Tool Age
    expect(trace.some((c) => c.type === 'research')).toBe(true); // ResearchPlanner / ProgressionPlanner researched
    expect(trace.some((c) => c.type === 'queue' && c.unit !== VILLAGER)).toBe(true); // ResearchPlanner trained military
    expect(military.length).toBeGreaterThan(0);
    expect(trace.some((c) => c.type === 'attack' || c.type === 'move')).toBe(true); // SquadPlanner ordered military
    bot.destroy();
  });

  test('I02: seeded human+bot single-player Lockstep flow (economy -> age-up -> squads -> pause -> speed -> resume) stays deterministic', () => {
    const timers = new FakeTimers();
    const humanLink = new FakeLink();
    const botLink = new FakeLink();
    const seed = 20261124;
    const settings = { ...DEFAULT_GAME_SETTINGS, mapSize: 72 };
    const civs = [CIV_EGYPTIAN, CIV_GREEK];

    const human = new Lockstep({
      link: humanLink,
      start: { seed, commandDelay: COMMAND_DELAY_TURNS, playerCount: 2, mode: 'single-player', slot: 0, settings, civs },
      timers,
      now: () => timers.clock,
      frameMs: () => 16,
    });
    const botPeer = new Lockstep({
      link: botLink,
      start: { seed, commandDelay: COMMAND_DELAY_TURNS, playerCount: 2, mode: 'single-player', slot: 1, settings, civs },
      timers,
      now: () => timers.clock,
      frameMs: () => 16,
    });

    const bot = new AiBot('', { difficulty: 'hard', player: 2 });
    const profile = getBotProfile('hard');
    let lastThinkTime = -1;
    let botCommandsWhilePaused = 0;
    const botTrace: Command[] = [];

    let pauseBoundary = Infinity;
    botPeer.onTurn = () => {
      if (botPeer.isPaused()) {
        if (botPeer.turn > pauseBoundary) botCommandsWhilePaused++;
        return;
      }
      const wt = botPeer.world.worldTime;
      if (shouldThinkAtTime(lastThinkTime, wt, profile)) {
        lastThinkTime = wt;
        const cmds = bot.step(botPeer.world);
        for (const c of cmds) {
          botTrace.push(c);
          botPeer.issue(c);
        }
      }
    };

    const sentBySlot: [Map<number, Command[]>, Map<number, Command[]>] = [new Map(), new Map()];
    const log: ServerMessage[] = [];
    let nextRelease = 0;

    // 1. Advance 32 turns: human issues a villager queue, bot runs economy/progression
    human.issue({ type: 'queue', building: [...human.world.entities.ofPlayer(1)].find((e) => e.type === TOWN_CENTER)!.id, unit: VILLAGER, count: 1 });
    while (human.turn < 32 || botPeer.turn < 32) {
      timers.next();
      nextRelease = flushRelayTurns(humanLink, botLink, sentBySlot, log, nextRelease);
    }
    expect(botTrace.length).toBeGreaterThan(0);
    expect(human.hashes.get(28)).toBe(botPeer.hashes.get(28));

    // 2. Host pauses at boundary 34; verify both peers halt at turn 34 with matching checksum
    expect(human.togglePause()).toBe(true);
    expect(botPeer.canPause()).toBe(false);
    pauseBoundary = nextRelease + COMMAND_DELAY_TURNS;
    const pauseMsg: ServerMessage = { t: 'paused', paused: true, boundary: pauseBoundary, epoch: 1 };
    humanLink.receive(pauseMsg);
    botLink.receive(pauseMsg);

    while (timers.due.length > 0) {
      timers.next();
      nextRelease = flushRelayTurns(humanLink, botLink, sentBySlot, log, nextRelease);
    }
    expect(human.turn).toBe(pauseBoundary);
    expect(botPeer.turn).toBe(pauseBoundary);
    expect(human.world.syncChecksum()).toBe(botPeer.world.syncChecksum());

    // 3. Change speed to 2.5x while paused, then resume -> both apply speed 2.5 and stay synced
    human.issue({ type: 'game-speed', speed: 2.5 });
    expect(human.togglePause()).toBe(true);
    const resumeMsg: ServerMessage = { t: 'paused', paused: false, boundary: pauseBoundary, epoch: 2 };
    humanLink.receive(resumeMsg);
    botLink.receive(resumeMsg);

    const targetTurn = pauseBoundary + 12;
    while (human.turn < targetTurn || botPeer.turn < targetTurn) {
      timers.next();
      nextRelease = flushRelayTurns(humanLink, botLink, sentBySlot, log, nextRelease);
    }

    expect(human.world.gameSpeed).toBe(2.5);
    expect(botPeer.world.gameSpeed).toBe(2.5);
    expect(botCommandsWhilePaused).toBe(0);
    expect(human.world.syncChecksum()).toBe(botPeer.world.syncChecksum());
    for (const [turn, hash] of human.hashes.entries()) {
      expect(botPeer.hashes.get(turn)).toBe(hash);
    }

    bot.destroy();
    human.stop();
    botPeer.stop();
  });

  test('I03: 2-player multiplayer mode preserves [1, 1.5, 2] speed, blocks pause, and keeps reconnect checksums synced', () => {
    const timers = new FakeTimers();
    const p1Link = new FakeLink();
    const p2Link = new FakeLink();
    const seed = 9001;

    const p1 = new Lockstep({
      link: p1Link,
      start: {
        seed,
        commandDelay: COMMAND_DELAY_TURNS,
        playerCount: 2,
        mode: 'multiplayer',
        slot: 0,
        rejoin: { code: 'MP01', slot: 0, token: 'tok0' },
      },
      timers,
      now: () => timers.clock,
      frameMs: () => 16,
    });
    const p2 = new Lockstep({
      link: p2Link,
      start: {
        seed,
        commandDelay: COMMAND_DELAY_TURNS,
        playerCount: 2,
        mode: 'multiplayer',
        slot: 1,
        rejoin: { code: 'MP01', slot: 1, token: 'tok1' },
      },
      timers,
      now: () => timers.clock,
      frameMs: () => 16,
    });

    // Neither multiplayer peer can pause
    expect(p1.canPause()).toBe(false);
    expect(p2.canPause()).toBe(false);
    expect(p1.togglePause()).toBe(false);

    const sentBySlot: [Map<number, Command[]>, Map<number, Command[]>] = [new Map(), new Map()];
    const log: ServerMessage[] = [];
    let nextRelease = 0;

    p1.issue({ type: 'game-speed', speed: 1.5 });
    while (p1.turn < 10 || p2.turn < 10) {
      timers.next();
      nextRelease = flushRelayTurns(p1Link, p2Link, sentBySlot, log, nextRelease);
    }
    expect(p1.world.gameSpeed).toBe(1.5);
    expect(p2.world.gameSpeed).toBe(1.5);

    // Simulate p2 reconnect catching up missed turns and resending unreleased batches
    const resumeMsg = p2Link.triggerResume();
    expect(resumeMsg).toMatchObject({ t: 'rejoin', code: 'MP01', slot: 1, token: 'tok1' });
    const receivedBefore = (resumeMsg as Extract<ClientMessage, { t: 'rejoin' }>).received;
    p2Link.receive({ t: 'rejoined', nextTurn: receivedBefore, paused: false, pauseBoundary: 0, pauseEpoch: 0 });
    p1.issue({ type: 'game-speed', speed: 2 });
    while (p1.turn < 20 || p2.turn < 20) {
      timers.next();
      nextRelease = flushRelayTurns(p1Link, p2Link, sentBySlot, log, nextRelease);
    }

    expect(p1.world.gameSpeed).toBe(2);
    expect(p2.world.gameSpeed).toBe(2);
    expect(p1.hashes.get(16)).toBe(p2.hashes.get(16));
    expect(p1.world.syncChecksum()).toBe(p2.world.syncChecksum());

    p1.stop();
    p2.stop();
  });

  test('I04: JSON-roundtripped World snapshot preserves exact checksum and deterministic AiBot continuation', () => {
    const world = new World({ players: 3, units: startingObjects(3), victory: { type: VICTORY_SPECIAL } });
    const botA = new AiBot('', { difficulty: 'medium', player: 2 });

    for (let i = 0; i < 24; i++) {
      if (i % 2 === 0) {
        const cmds = botA.step(world);
        if (i === 8) cmds.push({ type: 'game-speed', speed: 1.5 });
        if (cmds.length > 0) world.addBatch(world.turn, 2, cmds);
      }
      world.runTurn();
    }

    const roundTripped = JSON.parse(JSON.stringify(world.snapshot())) as ReturnType<World['snapshot']>;
    const restored = World.restore(roundTripped);

    expect(restored.turn).toBe(world.turn);
    expect(restored.gameSpeed).toBe(world.gameSpeed);
    expect(restored.worldTime).toBe(world.worldTime);
    expect(restored.syncChecksum()).toBe(world.syncChecksum());

    // Continue both worlds with identical fresh observations/commands -> checksums stay identical
    const botObserveA = createBotObservation(world, 2).observation;
    const botObserveB = createBotObservation(restored, 2).observation;
    expect(botObserveB.resources).toEqual(botObserveA.resources);
    expect(botObserveB.ownUnits.length).toBe(botObserveA.ownUnits.length);

    for (let i = 0; i < 12; i++) {
      if (i % 2 === 0) {
        const cmds = botA.step(world);
        if (cmds.length > 0) {
          world.addBatch(world.turn, 2, cmds);
          restored.addBatch(restored.turn, 2, cmds);
        }
      }
      world.runTurn();
      restored.runTurn();
    }
    expect(restored.syncChecksum()).toBe(world.syncChecksum());
    botA.destroy();
  });
});
