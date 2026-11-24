import { CIV_EGYPTIAN, COMMAND_DELAY_TURNS, DEFAULT_GAME_SETTINGS, lobbyWorldOptions, SINGLE_STEP_TURNS, World, type Command, type GameSettings } from '@aoe/sim';
import { DEFAULT_ROOM_MODE, type ClientMessage, type EndReason, type ErrorCode, type RoomMode, type SpeedChange, type TurnBatch } from '@aoe/protocol';
import type { Link } from '../net/link';
import { PauseControl, type PauseState } from './pause-control';

export interface LockstepStart {
  seed: number;
  commandDelay: number;
  /** Number of human players; protocol slot s is sim player s + 1 (player 0 is Gaia). */
  playerCount: number;
  /** The host's map type, map size and victory condition; default the original's (Large, Mostly Land, Standard). */
  settings?: GameSettings;
  /** Each slot's civ from the lobby (17 Random is resolved from the seed); default Egyptian. */
  civs?: readonly number[];
  /** Room, slot and token to take the slot back with after a broken socket; without it a broken link ends the game. */
  rejoin?: { code: string; slot: number; token: string };
  /** Authoritative room mode (`'multiplayer'` default). */
  mode?: RoomMode;
  /** Protocol slot of this client (0 host, 1 guest/bot). */
  slot?: number;
  /**
   * Debug only (`?debug=net&map=test`): the fixed test map and its start objects instead of the random map the seed
   * makes. Both clients must ask for it.
   */
  testMap?: boolean;
}

/** How the game ended for this client: the server's reason, or `lost` when the link broke for good (`rejoin` refused). */
export type LockstepEnd = EndReason | 'lost';

/**
 * While the game waits on a turn, every this long it says who it waits for: the original warns of a player it has not
 * heard from for 25 s, and again every 25 s (`COMM_PLAYER_NOT_RESPONDING`, src/com_hand.cpp:565).
 */
export const NOT_RESPONDING_MS = 25_000;

/** The sync check (`World.syncChecksum`) runs on every 4th turn, as the original's `DoChecksum` does (turn-timing.md §9.1). */
export const SYNC_INTERVAL_TURNS = 4;

/** Error codes that can reject an in-flight `pause` request; unrelated errors must not clear `pause.pending`. */
const PAUSE_ERROR_CODES: ReadonlySet<ErrorCode> = new Set(['not-in-room', 'not-started', 'unauthorized', 'locked', 'bad-message']);

export interface Timers {
  set(fn: () => void, ms: number): unknown;
  clear(handle: unknown): void;
}

export interface LockstepOptions {
  link: Link;
  start: LockstepStart;
  /** Pace multiplier (debug/tests); 1 runs at the original's wall pace. */
  speed?: number;
  timers?: Timers;
  /** Wall clock, ms. */
  now?: () => number;
  /** This machine's mean frame time, ms; 0 while unknown (docs/spec/turn-timing.md §3.2). */
  frameMs?: () => number;
}

const browserTimers: Timers = {
  set: (fn, ms) => setTimeout(fn, ms),
  clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

/**
 * Client side of the lockstep loop (docs/spec/turn-timing.md §2, §8.5). A turn is a boundary step plus the world's
 * `frames` buffer steps of `granularity` ms. The boundary step of turn N runs once the relay has released the batches
 * issued during turn N - 2; buffer step k runs once k · G ms of wall time passed since the boundary. After a turn's
 * last step this client reports its hash and submits the commands issued during it, and the next boundary waits for
 * the next frame.
 */
export class Lockstep {
  readonly world: World;
  /**
   * Base time run so far: the sum of the steps' `G`, the ms the loop paces to the wall clock. Game time adds `G` times
   * the game speed per step (lobby.md §8).
   */
  baseTime = 0;
  /** Checksum after each sync-check turn (every `SYNC_INTERVAL_TURNS`th), by turn number. */
  readonly hashes = new Map<number, number>();
  private lastHash = 0;
  /** Resent on rejoin if the result vote was lost with the previous socket. */
  private lastResult: Extract<ClientMessage, { t: 'result' }> | undefined;
  /** Called after each executed turn, with the latest sync-check turn's checksum. */
  onTurn: (turn: number, hash: number) => void = () => {};
  /** Called with each sender's commands for `turn` (player number, as issued) before the step that runs them. */
  onCommands: (turn: number, batches: { player: number; commands: Command[] }[]) => void = () => {};
  onDesync: (turn: number, hashes: number[]) => void = () => {};
  onEnded: (reason: LockstepEnd) => void = () => {};
  /** The game has waited `NOT_RESPONDING_MS` (and every `NOT_RESPONDING_MS` after) for a turn the relay has not released. */
  onNotResponding: () => void = () => {};
  /** The server dropped the player in `slot` (its next batch resigns it). */
  onDropped: (slot: number) => void = () => {};
  /** Called whenever authoritative pause state changes. */
  onPauseChange: (paused: boolean, state: PauseState) => void = () => {};
  /** Total command batches received, per slot (debug and tests). */
  readonly applied: Command[][] = [];
  /** Synchronized pause controller (single-player host only). */
  readonly pause: PauseControl;
  /** Authoritative room mode (`'multiplayer'` default). */
  readonly mode: RoomMode;
  /** Protocol slot of this client (0 host, 1 guest/bot). */
  readonly slot: number;
  /** The server's latest round trip to each slot, ms. */
  rtt: number[] = [];
  /** Each slot's mean frame time as the server last heard it, ms (0 before the first). */
  frameTimes: number[] = [];
  /** Hold each pong this long (debug: fakes a slow link). */
  pongDelayMs = 0;

  private readonly link: Link;
  private readonly baseSpeed: number;
  private readonly timers: Timers;
  private readonly now: () => number;
  private readonly frameMs: () => number;

  private get paceScale(): number {
    return 1 / this.baseSpeed;
  }
  private readonly released = new Map<number, { batches: TurnBatch[]; speed?: SpeedChange }>();
  /** Released turns received so far (the relay releases them in order). */
  private received = 0;
  /** Released turns given to the world so far. */
  private taken = 0;
  /** This client's batches the relay has not released yet, by turn: sent again after a rejoin. */
  private readonly unreleased = new Map<number, ClientMessage>();
  private pending: Command[] = [];
  /** Timer of the next not-responding warning while the loop waits on a batch. */
  private stallTimer: unknown;
  /** Wall time of the current turn's boundary step. */
  private boundaryAt = 0;
  /** Wall time the next boundary step is due: a frame after the last buffer step was due. */
  private nextBoundaryAt = 0;
  private timer: unknown;
  private stopped = false;
  private readonly unsubscribe: () => void;

  constructor({ link, start, speed = 1, timers = browserTimers, now = () => performance.now(), frameMs = () => 0 }: LockstepOptions) {
    if (start.commandDelay !== COMMAND_DELAY_TURNS) {
      throw new Error(`server command delay ${start.commandDelay} != sim's ${COMMAND_DELAY_TURNS}`);
    }
    this.link = link;
    this.timers = timers;
    this.now = now;
    this.frameMs = frameMs;
    this.baseSpeed = Number.isFinite(speed) && speed > 0 ? speed : 1;
    // A random map game with the lobby's settings and civs: both peers build the same map and start objects from the
    // shared seed (docs/spec/random-maps.md, docs/spec/lobby.md §5).
    const civs = start.civs ?? new Array<number>(start.playerCount).fill(CIV_EGYPTIAN);
    this.world = new World(lobbyWorldOptions(start.seed, start.settings ?? DEFAULT_GAME_SETTINGS, civs, start.testMap));
    const mode = start.mode ?? DEFAULT_ROOM_MODE;
    const slot = start.slot ?? start.rejoin?.slot ?? 0;
    this.mode = mode;
    this.slot = slot;
    this.pause = new PauseControl({
      mode,
      isHost: slot === 0,
      send: (msg) => {
        if (!this.stopped) this.link.send(msg);
      },
      isGameOver: () => this.stopped || this.world.gameOver,
      onChange: (state) => this.onPauseChange(state.paused, state),
    });
    this.unsubscribe = link.onMessage((m) => {
      if (this.stopped) return;
      if (m.t === 'turn') {
        if (m.turn < this.taken || this.released.has(m.turn)) return;
        this.received = Math.max(this.received, m.turn + 1);
        this.unreleased.delete(m.turn);
        if (m.frameMs) this.frameTimes = m.frameMs;
        this.released.set(m.turn, m.speed ? { batches: m.batches, speed: m.speed } : { batches: m.batches });
        for (const batch of m.batches) (this.applied[batch.slot] ??= []).push(...batch.commands);
        this.pump();
      } else if (m.t === 'paused') {
        const wasPaused = this.pause.paused;
        if (!this.pause.applyPaused(m)) return;
        this.resumeForResign();
        if (this.pause.paused) {
          if (this.isAtPauseBarrier()) {
            if (this.timer !== undefined) {
              this.timers.clear(this.timer);
              this.timer = undefined;
            }
            this.settle();
          }
        } else if (wasPaused && this.timer === undefined && this.world.turnStep === 0) {
          const now = this.now();
          this.boundaryAt = now;
          this.nextBoundaryAt = now;
          this.pump();
        }
      } else if (m.t === 'rejoined') {
        // The batches sent while the socket was down never arrived.
        for (const [turn, batch] of [...this.unreleased].sort((a, b) => a[0] - b[0])) if (turn >= m.nextTurn) link.send(batch);
        if (this.lastResult) link.send(this.lastResult);
        const wasPaused = this.pause.paused;
        this.pause.applySnapshot(m);
        this.resumeForResign();
        if (this.pause.paused) {
          if (this.isAtPauseBarrier()) {
            if (this.timer !== undefined) {
              this.timers.clear(this.timer);
              this.timer = undefined;
            }
            this.settle();
          }
        } else if (wasPaused && this.timer === undefined && this.world.turnStep === 0) {
          const now = this.now();
          this.boundaryAt = now;
          this.nextBoundaryAt = now;
          this.pump();
        }
      } else if (m.t === 'dropped') {
        this.onDropped(m.slot);
      } else if (m.t === 'ping') {
        const pong = () => link.send({ t: 'pong', n: m.n });
        if (this.pongDelayMs > 0) this.timers.set(pong, this.pongDelayMs);
        else pong();
      } else if (m.t === 'rtt') {
        this.rtt = m.rtt;
        this.frameTimes = m.frameMs;
      } else if (m.t === 'desync') {
        this.stop();
        this.onDesync(m.turn, m.hashes);
      } else if (m.t === 'ended') {
        this.stop();
        // The sim already owns the results UI. A successful agreement only ends transport.
        if (m.reason !== 'completed') this.onEnded(m.reason);
      } else if (m.t === 'error') {
        if (PAUSE_ERROR_CODES.has(m.code)) this.pause.clearPending();
      }
    });
    const rejoin = start.rejoin;
    if (rejoin) link.setResume?.(() => ({ t: 'rejoin', ...rejoin, received: this.received }));
    link.onClose(() => {
      if (this.stopped) return;
      this.stop();
      this.onEnded(rejoin ? 'lost' : 'peer-left');
    });
    // Start on the next pass, once the caller has set its handlers.
    this.wait(0);
  }

  /** Turn the next executed turn will be. */
  get turn(): number {
    return this.world.turn;
  }

  /** Wall time a turn of `turn`'s length takes at the current step size: (F − 1) · G plus a frame (turn-timing.md §2). */
  turnMs(turn: number): number {
    const steps = turn <= SINGLE_STEP_TURNS ? 0 : (this.world.frames - 1) * this.world.granularity;
    return (steps + this.frameMs()) * this.paceScale;
  }

  /**
   * Wall time from the step just run to the next one: `G` within a turn, a frame after a turn's last step (the next
   * boundary waits for the following pass of the game loop, §2).
   */
  stepMs(): number {
    return (this.world.turnStep === 0 ? this.frameMs() : this.world.granularity) * this.paceScale;
  }

  /** Queue a command; it goes out after the current turn and executes COMMAND_DELAY_TURNS later on both clients. */
  issue(command: Command): void {
    this.pending.push(command);
    if (command.type === 'resign') this.resumeForResign();
  }

  /**
   * Leave the game (Quit Game, `disconnect_multiplayer_game`): the batch of the turn under way goes out at once with
   * `last` after the queued commands (the resign, `SendIResignMsg`), and the loop stops.
   */
  quit(last: Command[]): void {
    if (this.stopped) return;
    this.link.send({ t: 'turn', turn: this.world.turn, commands: [...this.pending, ...last] });
    this.pending = [];
    this.stop();
  }

  /** Whether the session is currently paused (authoritative). */
  isPaused(): boolean {
    return this.pause.paused;
  }

  /** Whether this client is allowed to toggle pause right now. */
  canPause(): boolean {
    return this.pause.canToggle();
  }

  /** Snapshot of the pause state. */
  pauseState(): PauseState {
    return this.pause.state;
  }

  /** Request a pause toggle (single-player host only). */
  togglePause(): boolean {
    return this.pause.toggle();
  }

  /** Request an explicit pause or resume (single-player host only). */
  requestPause(paused: boolean): boolean {
    return this.pause.request(paused);
  }

  stop(): void {
    this.stopped = true;
    this.pause.clearPending();
    this.unsubscribe();
    this.link.setResume?.(null);
    if (this.timer !== undefined) {
      this.timers.clear(this.timer);
      this.timer = undefined;
    }
    this.settle();
  }

  /** A menu resign must leave the paused queue, even if its pause acknowledgement arrived late. */
  private resumeForResign(): void {
    if (this.pause.paused && this.pending.some((c) => c.type === 'resign')) this.pause.request(false);
  }

  private isAtPauseBarrier(): boolean {
    return this.pause.paused && this.world.turn >= this.pause.boundary && this.world.turnStep === 0;
  }

  /** Run every step that is due, then wait for the next one's time or batch. A late loop catches up at once. */
  private pump(): void {
    if (this.stopped || this.timer !== undefined) return;
    const world = this.world;
    while (!this.stopped) {
      if (this.isAtPauseBarrier()) {
        this.settle();
        return;
      }
      const due = world.turnStep === 0 ? this.nextBoundaryAt : this.boundaryAt + (world.turnStep - 1) * world.granularity * this.paceScale;
      const wait = due - this.now();
      if (wait > 0) return this.wait(wait);
      if (world.turnStep === 0) {
        if (!this.takeBatches(world.turn)) return this.stall();
        this.settle();
        this.boundaryAt = this.now();
      }
      world.runStep();
      if (!world.gameOver) this.baseTime += world.granularity;
      if (world.turnStep === 0) {
        this.endTurn(world.turn - 1);
        if (this.isAtPauseBarrier()) {
          this.settle();
          return;
        }
        // The next boundary comes on the following pass of the game loop: a frame after the last step was due.
        this.nextBoundaryAt = Math.max(due, this.boundaryAt) + this.frameMs() * this.paceScale;
      }
    }
  }

  /** Give the world the batches issued during `turn - COMMAND_DELAY_TURNS`; false while the relay has not released them. */
  private takeBatches(turn: number): boolean {
    const issued = turn - COMMAND_DELAY_TURNS;
    if (issued < 0) return true;
    const release = this.released.get(issued);
    if (!release) return false;
    this.released.delete(issued);
    this.taken = issued + 1;
    for (const batch of release.batches) this.world.addBatch(issued, batch.slot + 1, batch.commands);
    this.onCommands(turn, release.batches.map((b) => ({ player: b.slot + 1, commands: b.commands })));
    if (release.speed) this.world.setSpeedChange(release.speed);
    return true;
  }

  /** The loop waits on a batch: warn every `NOT_RESPONDING_MS` until it comes. */
  private stall(): void {
    if (this.stallTimer !== undefined) return;
    const warn = () => {
      this.stallTimer = this.timers.set(warn, NOT_RESPONDING_MS);
      this.onNotResponding();
    };
    this.stallTimer = this.timers.set(warn, NOT_RESPONDING_MS);
  }

  private settle(): void {
    if (this.stallTimer !== undefined) this.timers.clear(this.stallTimer);
    this.stallTimer = undefined;
  }

  private endTurn(turn: number): void {
    if (turn % SYNC_INTERVAL_TURNS === 0) {
      this.lastHash = this.world.syncChecksum();
      this.hashes.set(turn, this.lastHash);
      this.link.send({ t: 'hash', turn, hash: this.lastHash });
    }
    const frameMs = Math.min(255, Math.round(this.frameMs()));
    const batch: ClientMessage = frameMs > 0 ? { t: 'turn', turn, commands: this.pending, frameMs } : { t: 'turn', turn, commands: this.pending };
    if (turn >= this.received) this.unreleased.set(turn, batch);
    this.link.send(batch);
    this.pending = [];
    const result = this.world.gameResult();
    if (result) {
      // Repeat each turn: votes lost during a reconnect or a quorum change must converge again.
      this.lastResult = { t: 'result', turn, hash: this.world.syncChecksum(), winners: result.winners };
      this.link.send(this.lastResult);
    }
    this.onTurn(turn, this.lastHash);
  }

  private wait(ms: number): void {
    this.timer = this.timers.set(() => {
      this.timer = undefined;
      this.pump();
    }, ms);
  }
}
