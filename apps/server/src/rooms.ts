import { randomBytes, randomInt } from 'node:crypto';
import {
  CIV_COUNT,
  CODE_ALPHABET,
  CODE_LENGTH,
  COMMAND_DELAY_TURNS,
  DEFAULT_BOT_DIFFICULTY,
  DEFAULT_GAME_SETTINGS,
  DEFAULT_ROOM_MODE,
  DEFAULT_ROOM_CAPACITY,
  DEFAULT_COMPATIBILITY_VERSIONS,
  DROP_AFTER_MS,
  MAX_NAME_LENGTH,
  isRoomCapacity,
  isCompatibilityVersions,
  sameCompatibilityVersions,
  MAX_TURNS_AHEAD,
  isBotDifficulty,
  isLobbyCiv,
  isMultiplayerGameSpeed,
  isRoomMode,
  isSinglePlayerGameSpeed,
  isValidCode,
  normalizeCode,
  parseLobbySettings,
  type BotDifficulty,
  type RoomCapacity,
  type CompatibilityVersions,
  type MatchManifest,
  type MatchResult,
  type ClientMessage,
  type Command,
  type ErrorCode,
  type GameSettings,
  type PlayerInfo,
  type RoomMode,
  type ServerMessage,
  type SpeedChange,
  type TurnBatch,
} from '@aoe/protocol';
import { freezeSnapshot, openSlot, orderedMembers, roomSeats } from './room-seats';
import { highLatencyMs, SpeedHost } from './speed';

/** A player is pinged when this long passed since the last ping to it (`CheckPingTime`, turn-timing.md §3.1). */
export const PING_INTERVAL_MS = 8000;

/** One connected client, as the room logic sees it. */
export interface Peer {
  send(message: ServerMessage): void;
}

/** One released turn, as sent to both clients. */
export interface TurnRecord {
  turn: number;
  batches: TurnBatch[];
  speed?: SpeedChange;
}

interface Member {
  readonly slot: number;
  versions: CompatibilityVersions | undefined;
  /** Null while the member's socket is away (dropped, not left) in a started game. */
  peer: Peer | null;
  name: string;
  ready: boolean;
  /** The civ drop-down's value (docs/spec/lobby.md §3). */
  civ: number;
  /** Next turn this member must submit. */
  nextTurn: number;
  /** Latest executed turn acknowledged by an accepted batch or a retired observer keepalive. */
  executedTurn: number;
  /** Submitted but not yet released batches. */
  pending: Map<number, Command[]>;
  hashes: Map<number, number>;
  /** Latest round trip to this member, ms; 0 before the first. */
  rtt: number;
  /** Latest mean frame time the member reported, ms; 0 before the first. */
  frameMs: number;
  /** Number and send time of the latest ping. */
  pingN: number;
  pingAt: number;
  /** The secret `start` gave this member's client, for `rejoin`. */
  token: string;
  /** When the server last heard from this member, ms. */
  heardAt: number;
  /** Dropped after its socket stayed away `DROP_AFTER_MS`: the server fills its batches from then on. */
  dropped: boolean;
  /** Cancels the drop while the socket is away. */
  cancelDrop: (() => void) | null;
  /** Drop timer fired while room was paused; re-armed on resume. */
  pendingDrop: boolean;
  /** Submitted a resign command: leaving no longer ends the game for the others. */
  resigned: boolean;
  /** True when this member joined slot 1 of a single-player room using `botToken`. */
  isBot: boolean;
}

export class Room {
  readonly members: Member[] = [];
  /** Every turn released so far, in order. */
  readonly log: TurnRecord[] = [];
  readonly desyncs: number[] = [];
  readonly comparedHashes = new Set<number>();
  readonly resultRounds = new Map<number, Map<number, MatchResult>>();
  started = false;
  seed = 0;
  paused = false;
  pauseBoundary = 0;
  pauseEpoch = 0;
  gameOver = false;
  /** Results cannot predate the execution of any server-known resignation. */
  resultNotBefore = 0;
  hostSlot = 0;
  manifest: MatchManifest | undefined;
  /** The host's map type, map size and victory condition (docs/spec/lobby.md §2). */
  settings: GameSettings = structuredClone(DEFAULT_GAME_SETTINGS);
  /** Step size and buffer frames: the server plays the host (docs/spec/turn-timing.md §8.2). */
  readonly speed = new SpeedHost();

  constructor(
    readonly code: string,
    readonly mode: RoomMode = DEFAULT_ROOM_MODE,
    readonly difficulty?: BotDifficulty,
    readonly botToken?: string,
    readonly capacity: RoomCapacity = DEFAULT_ROOM_CAPACITY,
    readonly versions: CompatibilityVersions = DEFAULT_COMPATIBILITY_VERSIONS,
  ) {}

  players(): PlayerInfo[] {
    return orderedMembers(this.members).map((m) => ({ slot: m.slot, name: m.name, ready: m.ready, civ: m.civ }));
  }

  broadcast(message: ServerMessage): void {
    for (const m of this.members) m.peer?.send(message);
  }

  /** Each member's round trip and last reported frame time, as the clients' score display reads them. */
  rttMessage(): ServerMessage {
    return { t: 'rtt', rtt: this.slotMetrics(m => m.rtt), frameMs: this.slotMetrics(m => m.frameMs) };
  }

  slotMetrics(read: (m: Member) => number): number[] {
    return Array.from({length:this.capacity}, (_,slot) => {
      const m = this.members.find(m => m.slot === slot);
      return m && !m.dropped && !m.resigned ? read(m) : 0;
    });
  }

  sendLobby(): void {
    const players = this.players();
    const extra = this.mode === 'single-player' && this.difficulty !== undefined ? { difficulty: this.difficulty } : {};
    this.members.forEach((m) =>
      m.peer?.send({
        t: 'lobby',
        code: this.code,
        you: m.slot,
        capacity: this.capacity,
        hostSlot: this.hostSlot,
        seats: roomSeats(this.capacity, this.members),
        versions: this.versions,
        players,
        settings: this.settings,
        mode: this.mode,
        ...extra,
        ...(this.mode === 'single-player' && m.slot === 0 && !m.isBot && this.botToken ? { botToken: this.botToken } : {}),
      }),
    );
  }
}

export interface RoomRegistryOptions {
  versions?: CompatibilityVersions;
  /** Override code generation (tests). Must return a normalized, valid code. */
  generateCode?: () => string;
  /** Override the game seed (tests). */
  generateSeed?: () => number;
  /** Clock for round trips and drops, ms (tests). */
  now?: () => number;
  /** Override the rejoin tokens (tests). */
  generateToken?: () => string;
  /** Run `fn` after `ms`; returns a cancel function (tests). */
  schedule?: (fn: () => void, ms: number) => () => void;
  /** A new player's civ before it picks one; default a random civ, as the host rolls it (docs/spec/lobby.md §3). */
  generateCiv?: () => number;
  /** How long a broken socket keeps its slot before the player is dropped, ms; default `DROP_AFTER_MS`. */
  dropAfterMs?: number;
}

function schedule(fn: () => void, ms: number): () => void {
  const timer = setTimeout(fn, ms);
  return () => clearTimeout(timer);
}

function randomCode(): string {
  let code = '';
  for (let i = 0; i < CODE_LENGTH; i++) code += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
  return code;
}

/** All rooms plus which room each connected peer is in. Pure logic: no sockets, no timers. */
export class RoomRegistry {
  readonly rooms = new Map<string, Room>();
  private readonly byPeer = new Map<Peer, Room>();
  private readonly generateCode: () => string;
  private readonly generateSeed: () => number;
  private readonly now: () => number;
  private readonly generateToken: () => string;
  private readonly schedule: (fn: () => void, ms: number) => () => void;
  private readonly generateCiv: () => number;
  private readonly dropAfterMs: number;
  private readonly versions: CompatibilityVersions;

  constructor(options: RoomRegistryOptions = {}) {
    this.versions = freezeSnapshot(structuredClone(options.versions ?? DEFAULT_COMPATIBILITY_VERSIONS));
    this.generateCode = options.generateCode ?? randomCode;
    this.generateSeed = options.generateSeed ?? (() => randomInt(2 ** 32));
    this.now = options.now ?? (() => performance.now());
    this.generateToken = options.generateToken ?? (() => randomBytes(16).toString('hex'));
    this.schedule = options.schedule ?? schedule;
    this.generateCiv = options.generateCiv ?? (() => randomInt(CIV_COUNT) + 1);
    this.dropAfterMs = options.dropAfterMs ?? DROP_AFTER_MS;
  }

  get compatibilityVersions(): Readonly<CompatibilityVersions> {
    return this.versions;
  }

  roomOf(peer: Peer): Room | undefined {
    return this.byPeer.get(peer);
  }

  handle(peer: Peer, message: ClientMessage): void {
    switch (message.t) {
      case 'create':
        return this.create(peer, message.name, message.mode, message.difficulty, message.capacity, message.versions);
      case 'join':
        return this.join(peer, message.code, message.name, message.botToken, message.versions);
      case 'rejoin':
        return this.rejoin(peer, message.code, message.slot, message.token, message.received);
      case 'leave':
        return this.disconnect(peer);
      default:
        break;
    }
    const room = this.byPeer.get(peer);
    if (!room) return reject(peer, 'not-in-room', 'join or create a room first');
    const member = room.members.find((m) => m.peer === peer);
    const slot = member?.slot;
    if (!member) return reject(peer, 'not-in-room', 'join or create a room first');
    member.heardAt = this.now();
    if (room.started) this.ping(member, false);
    switch (message.t) {
      case 'ready':
        if (room.started) return reject(peer, 'room-started', 'game already started');
        if (!this.compatible(room.capacity, message.versions ?? member.versions)) return reject(peer, 'version-mismatch', 'incompatible game versions');
        if (message.versions) member.versions = structuredClone(message.versions);
        member.ready = message.ready;
        return room.sendLobby();
      case 'settings': {
        if (room.started) return reject(peer, 'room-started', 'game already started');
        if (slot !== room.hostSlot) return reject(peer, 'not-host', 'only the host can change the settings');
        if (member.ready) return reject(peer, 'locked', 'the settings cannot change while the host is ready');
        const valid = parseLobbySettings(message.settings);
        if (valid === null) return reject(peer, 'invalid-settings', 'invalid game settings');
        room.settings = valid;
        for (const m of room.members) m.ready = false;
        return room.sendLobby();
      }
      case 'civ':
        if (room.started) return reject(peer, 'room-started', 'game already started');
        if (member.ready) return reject(peer, 'locked', 'the civilization cannot change while ready');
        if (typeof message.civ !== 'number' || !isLobbyCiv(message.civ)) {
          return reject(peer, 'invalid-settings', 'invalid civilization');
        }
        member.civ = message.civ;
        return room.sendLobby();
      case 'start':
        return this.start(room, member.slot, peer);
      case 'turn':
        return this.submitTurn(room, member, peer, message.turn, message.commands, message.frameMs);
      case 'pong':
        return this.pong(room, member, message.n);
      case 'hash':
        return this.reportHash(room, member, peer, message.turn, message.hash);
      case 'result':
        return this.reportResult(room, member, peer, message);
      case 'chat':
        return this.chat(room, peer, member.slot, message.text, message.to);
      case 'pause':
        return this.pause(room, member, member.slot, peer, message.paused, message.epoch);
    }
  }

  /** Preserve match seats after start; only lobby membership can be removed. */
  disconnect(peer: Peer, broken = false): void {
    const room = this.byPeer.get(peer);
    if (!room) return;
    const member = room.members.find(m => m.peer === peer);
    this.byPeer.delete(peer);
    if (!member) return;
    member.peer = null;
    member.cancelDrop?.();
    member.cancelDrop = null;
    if (room.members.every(m => m.peer === null)) return this.closeRoom(room);
    if (room.started) {
      this.transferHost(room);
      if (broken && !member.resigned && !member.dropped) return this.away(room, member);
      const wasActive = !member.resigned && !member.dropped;
      member.dropped = true;
      if (wasActive) this.injectResign(room, member);
      // An observer leaving after the terminal turn changes no gameplay commands.
      // Reuse already validated votes: stalled clients cannot emit another endTurn.
      else if (room.members.every(m => m.resigned || m.dropped) && this.completeAgreedResult(room)) return;
      this.release(room);
      return;
    }
    room.members.splice(room.members.indexOf(member), 1);
    if (room.mode === 'single-player' && member.slot === 0) return this.closeRoom(room);
    this.transferHost(room);
    for (const m of room.members) m.ready = false;
    room.sendLobby();
  }

  private transferHost(room: Room): void {
    if (room.members.some(m => m.slot === room.hostSlot && m.peer !== null && !m.isBot)) return;
    const next = orderedMembers(room.members).find(m => m.peer !== null && !m.isBot);
    if (next) room.hostSlot = next.slot;
  }

  private compatible(capacity: RoomCapacity, versions?: CompatibilityVersions): boolean {
    return versions === undefined ? capacity === 2 : isCompatibilityVersions(versions) && sameCompatibilityVersions(versions, this.versions);
  }

  private closeRoom(room: Room): void {
    for (const m of room.members) {
      if (m.peer) this.byPeer.delete(m.peer);
      m.cancelDrop?.();
      m.cancelDrop = null;
    }
    room.resultRounds.clear();
    this.rooms.delete(room.code);
  }

  /** `member`'s socket broke: hold its slot, and drop it once it stayed away `DROP_AFTER_MS`. */
  private away(room: Room, member: Member): void {
    member.peer = null;
    const wait = Math.max(0, this.dropAfterMs - (this.now() - member.heardAt));
    member.cancelDrop = this.schedule(() => this.drop(room, member), wait);
  }

  /**
   * Drop `member` from the game as the original's host does with a player that stopped answering (`Kick`, then every
   * other player runs `command_resign(player, 1)` on `COMM_OTHER_PLAYER_DROPPED`): its next batch resigns it, and from
   * then on the server fills its batches. A room with nobody connected left is closed.
   */
  private drop(room: Room, member: Member): void {
    member.cancelDrop = null;
    if (this.rooms.get(room.code) !== room) return;
    if (room.members.every((m) => m.peer === null)) return this.closeRoom(room);
    if (room.paused) {
      member.pendingDrop = true;
      return;
    }
    if (member.resigned || member.dropped) return;
    member.dropped = true;
    room.broadcast({ t: 'dropped', slot: member.slot });
    this.injectResign(room, member);
    this.release(room);
  }

  /** The first unaccepted batch follows every command the relay already accepted. */
  private injectResign(room: Room, member: Member): void {
    member.pending.set(member.nextTurn, [{ type: 'resign' }]);
    member.nextTurn++;
    this.quorumChanged(room, member.nextTurn - 1);
    if (room.paused) this.resume(room);
  }

  private quorumChanged(room: Room, issuedTurn: number): void {
    room.resultNotBefore = Math.max(room.resultNotBefore, issuedTurn + COMMAND_DELAY_TURNS);
    // A report made under an earlier voter set cannot finish a reduced quorum.
    room.resultRounds.clear();
    this.comparePendingHashes(room);
  }

  /** Give a dropped socket's slot back to its client (`rejoin`): the turns it missed follow `rejoined`. */
  private rejoin(peer: Peer, rawCode: string, slot: number, token: string, received: number): void {
    if (this.byPeer.has(peer)) return reject(peer, 'already-in-room', 'leave the current room first');
    const code = normalizeCode(rawCode);
    const room = isValidCode(code) ? this.rooms.get(code) : undefined;
    const member = room?.started ? room.members.find(m => m.slot === slot) : undefined;
    if (!room || !member || member.dropped || member.resigned || member.token !== token || !Number.isSafeInteger(received) || received < 0 || received > room.log.length) {
      return reject(peer, 'bad-rejoin', 'cannot rejoin that game');
    }
    // A socket that broke without the server noticing yet loses the slot to the new one.
    if (member.peer) this.byPeer.delete(member.peer);
    member.cancelDrop?.();
    member.cancelDrop = null;
    member.pendingDrop = false;
    member.peer = peer;
    member.heardAt = this.now();
    this.byPeer.set(peer, room);
    const pauseSnapshot =
      room.paused || room.pauseEpoch > 0
        ? { paused: room.paused, pauseBoundary: room.pauseBoundary, pauseEpoch: room.pauseEpoch }
        : {};
    peer.send({
      t: 'rejoined',
      capacity: room.capacity,
      hostSlot: room.hostSlot,
      versions: room.versions,
      manifest: room.manifest,
      nextTurn: member.nextTurn,
      mode: room.mode,
      ...(room.mode === 'single-player' && room.difficulty !== undefined ? { difficulty: room.difficulty } : {}),
      ...pauseSnapshot,
    });
    for (const record of room.log.slice(received)) peer.send({ t: 'turn', ...record });
    peer.send(room.rttMessage());
    this.ping(member, true);
  }

  private newMember(peer: Peer, name: string, slot: number, isBot: boolean, versions?: CompatibilityVersions): Member {
    return {
      slot,
      versions: versions ? structuredClone(versions) : undefined,
      peer,
      name: name === '' ? `Player ${slot + 1}` : name,
      ready: false,
      civ: this.generateCiv(),
      nextTurn: 0,
      executedTurn: -1,
      pending: new Map(),
      hashes: new Map(),
      rtt: 0,
      frameMs: 0,
      pingN: 0,
      pingAt: 0,
      token: '',
      heardAt: this.now(),
      dropped: false,
      cancelDrop: null,
      pendingDrop: false,
      resigned: false,
      isBot,
    };
  }

  private create(peer: Peer, name: string, rawMode?: RoomMode, rawDifficulty?: BotDifficulty, rawCapacity?: RoomCapacity, versions?: CompatibilityVersions): void {
    if (this.byPeer.has(peer)) return reject(peer, 'already-in-room', 'leave the current room first');
    if (typeof name !== 'string' || name.trim().length > MAX_NAME_LENGTH) {
      return reject(peer, 'bad-message', 'invalid player name');
    }
    if (rawMode !== undefined && !isRoomMode(rawMode)) {
      return reject(peer, 'invalid-settings', 'invalid room mode');
    }
    if (rawDifficulty !== undefined && !isBotDifficulty(rawDifficulty)) {
      return reject(peer, 'invalid-settings', 'invalid bot difficulty');
    }
    const mode: RoomMode = rawMode ?? DEFAULT_ROOM_MODE;
    const capacity = rawCapacity ?? DEFAULT_ROOM_CAPACITY;
    if (!isRoomCapacity(capacity) || (mode === 'single-player' && capacity !== 2)) return reject(peer, 'invalid-settings', 'invalid room capacity');
    if (!this.compatible(capacity, versions)) return reject(peer, 'version-mismatch', 'incompatible game versions');
    const difficulty = mode === 'single-player' ? (rawDifficulty ?? DEFAULT_BOT_DIFFICULTY) : undefined;
    const botToken = mode === 'single-player' ? this.generateToken() : undefined;
    let code = this.generateCode();
    while (this.rooms.has(code)) code = this.generateCode();
    const room = new Room(code, mode, difficulty, botToken, capacity, this.versions);
    room.members.push(this.newMember(peer, name.trim(), 0, false, versions));
    this.rooms.set(code, room);
    this.byPeer.set(peer, room);
    room.sendLobby();
  }

  private join(peer: Peer, rawCode: string, name: string, botToken?: string, versions?: CompatibilityVersions): void {
    if (this.byPeer.has(peer)) return reject(peer, 'already-in-room', 'leave the current room first');
    if (typeof rawCode !== 'string' || rawCode.length > 32) return reject(peer, 'bad-code', 'no room with that invite code');
    if (typeof name !== 'string' || name.trim().length > MAX_NAME_LENGTH) {
      return reject(peer, 'bad-message', 'invalid player name');
    }
    const code = normalizeCode(rawCode);
    const room = isValidCode(code) ? this.rooms.get(code) : undefined;
    if (!room) return reject(peer, 'bad-code', 'no room with that invite code');
    if (room.started) return reject(peer, 'room-started', 'game already started');
    if (room.members.length >= room.capacity) return reject(peer, 'room-full', 'room is full');
    if (!this.compatible(room.capacity, versions)) return reject(peer, 'version-mismatch', 'incompatible game versions');
    if (room.mode === 'single-player') {
      if (!room.botToken || typeof botToken !== 'string' || botToken.length === 0 || botToken !== room.botToken) {
        return reject(peer, 'unauthorized', 'valid bot token required to join single-player room');
      }
    }
    for (const m of room.members) m.ready = false;
    room.members.push(this.newMember(peer, name.trim(), openSlot(room.capacity, room.members)!, room.mode === 'single-player', versions));
    this.byPeer.set(peer, room);
    room.sendLobby();
  }

  private start(room: Room, slot: number, peer: Peer): void {
    if (room.started) return reject(peer, 'room-started', 'game already started');
    if (slot !== room.hostSlot) return reject(peer, 'not-host', 'only the host can start');
    if (room.members.length < room.capacity || room.members.some((m) => !m.ready)) {
      return reject(peer, 'not-ready', 'every player must be ready');
    }
    if (room.members.some(m => !this.compatible(room.capacity, m.versions))) return reject(peer, 'version-mismatch', 'incompatible game versions');
    room.started = true;
    room.seed = this.generateSeed();
    room.manifest = freezeSnapshot(structuredClone({ code: room.code, capacity: room.capacity, mode: room.mode, hostSlot: room.hostSlot, players: room.players().map(p => ({slot:p.slot, playerId:p.slot+1, name:p.name, civ:p.civ})), seed:room.seed, settings:room.settings, versions:room.versions }));
    const players = room.players();
    const extra = room.mode === 'single-player' && room.difficulty !== undefined ? { difficulty: room.difficulty } : {};
    for (const m of room.members) {
      m.token = this.generateToken();
      m.peer?.send({
        t: 'start',
        capacity: room.capacity,
        hostSlot: room.hostSlot,
        manifest: room.manifest,
        versions: room.versions,
        seed: room.seed,
        commandDelay: COMMAND_DELAY_TURNS,
        players,
        settings: room.settings,
        token: m.token,
        mode: room.mode,
        ...extra,
      });
    }
    for (const m of room.members) this.ping(m, true);
  }

  /** Ping `member` when forced or when `PING_INTERVAL_MS` passed since the last ping (`CheckPingTime`). */
  private ping(member: Member, force: boolean): void {
    const now = this.now();
    if (!force && now - member.pingAt <= PING_INTERVAL_MS) return;
    if (!member.peer) return;
    member.pingN++;
    member.pingAt = now;
    member.peer.send({ t: 'ping', n: member.pingN });
  }

  private pong(room: Room, member: Member, n: number): void {
    if (n !== member.pingN) return;
    member.rtt = Math.max(0, Math.round(this.now() - member.pingAt));
    room.broadcast(room.rttMessage());
  }

  private submitTurn(room: Room, member: Member, peer: Peer, turn: number, commands: Command[], frameMs?: number): void {
    if (!room.started) return reject(peer, 'not-started', 'game has not started');
    if (!Number.isSafeInteger(turn) || turn < 0) return reject(peer, 'bad-turn', 'invalid turn');
    if (frameMs !== undefined && (!Number.isInteger(frameMs) || frameMs < 0 || frameMs > 255)) {
      return reject(peer, 'bad-message', 'invalid frame time');
    }
    if (member.resigned || member.dropped) {
      if (commands.length !== 0) return reject(peer, 'locked', 'resigned players cannot issue commands');
      // A retired client still runs the released timeline. It cannot acknowledge a boundary
      // for which the relay has not supplied the delayed batch, or create new batches itself.
      if (turn > room.log.length + COMMAND_DELAY_TURNS - 1) return reject(peer, 'bad-turn', 'observer turn has not run yet');
      member.executedTurn = Math.max(member.executedTurn, turn);
      return;
    }
    if (turn !== member.nextTurn) {
      return reject(peer, 'bad-turn', `expected turn ${member.nextTurn}, got ${turn}`);
    }
    if (turn - room.log.length >= MAX_TURNS_AHEAD) {
      return reject(peer, 'bad-turn', 'too many unreleased turns');
    }
    const slot = member.slot;
    for (const command of commands) {
      if (command.type !== 'game-speed') continue;
      if (room.mode === 'single-player') {
        if (slot !== 0 || member.isBot) {
          return reject(peer, 'unauthorized', 'only the single-player host can change game speed');
        }
        if (!isSinglePlayerGameSpeed(command.speed)) {
          return reject(peer, 'invalid-settings', 'invalid single-player game speed');
        }
      } else if (!isMultiplayerGameSpeed(command.speed)) {
        return reject(peer, 'invalid-settings', 'invalid multiplayer game speed');
      }
    }
    member.pending.set(turn, structuredClone(commands));
    member.nextTurn++;
    member.executedTurn = turn;
    if (frameMs !== undefined) member.frameMs = frameMs;
    if (commands.some((c) => c.type === 'resign')) {
      member.resigned = true;
      this.quorumChanged(room, turn);
      // A resign must reach the sim even when nobody can manually resume after game over.
      if (room.paused) this.resume(room);
    }
    this.release(room);
  }

  private pause(room: Room, member: Member, slot: number, peer: Peer, paused: boolean, epoch?: number): void {
    if (!room.started) return reject(peer, 'not-started', 'game has not started');
    if (room.mode !== 'single-player' || slot !== 0 || member.isBot) {
      return reject(peer, 'unauthorized', 'only the single-player host can pause');
    }
    if (room.gameOver || room.members.some(m => m.resigned || m.dropped)) return reject(peer, 'locked', 'cannot pause after resignation or game over');
    if (epoch !== undefined && epoch !== room.pauseEpoch) return;
    if (paused === room.paused) return;

    if (paused) {
      room.paused = true;
      room.pauseBoundary = room.log.length + COMMAND_DELAY_TURNS;
      room.pauseEpoch += 1;
      room.broadcast({ t: 'paused', paused: true, boundary: room.pauseBoundary, epoch: room.pauseEpoch });
    } else {
      this.resume(room);
    }
  }

  /** Clear the pause barrier before releasing held batches, including a resign received while paused. */
  private resume(room: Room): void {
    room.paused = false;
    room.pauseEpoch += 1;
    room.broadcast({ t: 'paused', paused: false, boundary: room.pauseBoundary, epoch: room.pauseEpoch });
    for (const m of room.members) {
      if (m.peer === null && !m.dropped && !m.resigned) {
        m.pendingDrop = false;
        m.cancelDrop?.();
        m.heardAt = this.now();
        m.cancelDrop = this.schedule(() => this.drop(room, m), this.dropAfterMs);
      }
    }
    this.release(room);
  }

  /**
   * Release every turn for which all members have submitted, in order. Once turn N is released every member has run
   * it, which is the host's boundary N + 1: the speed analysis runs there, and its change rides on this release.
   */
  private release(room: Room): void {
    for (;;) {
      const turn = room.log.length;
      if (room.paused && turn + COMMAND_DELAY_TURNS >= room.pauseBoundary) return;
      if (room.members.some((m) => !m.dropped && !m.resigned && !m.pending.has(turn))) return;
      if (!room.members.some(m => m.pending.has(turn))) return;
      const batches = orderedMembers(room.members).map((m) => ({ slot: m.slot, commands: m.pending.get(turn) ?? [] }));
      for (const m of room.members) m.pending.delete(turn);
      // Through the relay a round trip between players is the sum of both legs (turn-timing.md §8.3).
      const active = room.members.filter(m => !m.dropped && !m.resigned);
      const latency = highLatencyMs(active.map(m => m.rtt).sort((a,b) => b-a).slice(0,2).reduce((sum,rtt) => sum+rtt,0));
      const frameMs = Math.max(0, ...active.map((m) => m.frameMs));
      const speed = room.speed.boundary(turn + 1, frameMs, latency);
      const record: TurnRecord = speed ? { turn, batches, speed } : { turn, batches };
      freezeSnapshot(record);
      room.log.push(record);
      this.pruneHashes(room);
      this.pruneResults(room);
      room.broadcast({ t: 'turn', ...record, frameMs: room.slotMetrics(m => m.frameMs) });
    }
  }

  /**
   * A chat message, in the lobby or the game: to each other player in `to` whose socket is here (`TXChat` sends it to
   * the players its `DestPlayers` names; the sender adds its own copy, docs/spec/chat.md §3). Never part of a turn.
   */
  private chat(room: Room, peer: Peer, from: number, text: string, to: number[]): void {
    if (to.some(slot => !Number.isInteger(slot) || slot < 0 || slot >= room.capacity || !room.members.some(m => m.slot === slot))) {
      return reject(peer, 'bad-message', 'invalid chat recipient');
    }
    for (const slot of new Set(to)) if (slot !== from) room.members.find(m => m.slot === slot)?.peer?.send({ t: 'chat', from, text });
  }

  private pruneResults(room: Room): void {
    for (const turn of room.resultRounds.keys()) if (turn < room.log.length - MAX_TURNS_AHEAD) room.resultRounds.delete(turn);
  }

  private reportResult(room: Room, member: Member, peer: Peer, report: MatchResult): void {
    if (!room.started) return reject(peer, 'not-started', 'game has not started');
    const { turn, hash, winners } = report;
    const active = room.members.filter(m => !m.resigned && !m.dropped);
    // When every sender retired, the remaining original clients must still be able to
    // confirm the terminal sim result. This does not promote observers back to senders.
    const voters = active.length > 0 ? active : room.members.filter(m => m.peer !== null);
    const validPlayers = new Set(room.manifest!.players.map(p => p.playerId));
    const oldest = Math.max(room.resultNotBefore, 0, room.log.length - MAX_TURNS_AHEAD);
    const ownHash = member.hashes.get(turn);
    if (!voters.includes(member) || !Number.isSafeInteger(turn) || turn < oldest ||
        turn > member.executedTurn || turn > room.log.length + COMMAND_DELAY_TURNS - 1 ||
        !Number.isInteger(hash) || hash < 0 || hash > 0xffffffff || !Array.isArray(winners) ||
        new Set(winners).size !== winners.length || winners.some(id => !validPlayers.has(id)) ||
        (ownHash !== undefined && ownHash !== hash)) {
      return reject(peer, 'bad-result', 'invalid, premature or unacknowledged match result');
    }
    this.pruneResults(room);
    const normalized = { turn, hash, winners: [...winners].sort((a, b) => a - b) };
    let round = room.resultRounds.get(turn);
    if (!round) { round = new Map(); room.resultRounds.set(turn, round); }
    const previous = round.get(member.slot);
    if (previous && !sameResult(previous, normalized)) return reject(peer, 'bad-result', 'result already reported for this turn');
    round.set(member.slot, normalized);
    this.completeAgreedResult(room);
  }

  /** Recheck validated votes when a result arrives or a terminal observer disconnects. */
  private completeAgreedResult(room: Room): boolean {
    const active = room.members.filter(m => !m.resigned && !m.dropped);
    const voters = active.length > 0 ? active : room.members.filter(m => m.peer !== null);
    if (voters.length === 0) return false;
    for (const [turn, round] of room.resultRounds) {
      if (turn < room.resultNotBefore) continue;
      const result = round.get(voters[0]!.slot);
      if (!result || voters.some(m => !round.has(m.slot) || !sameResult(round.get(m.slot)!, result))) continue;
      room.gameOver = true;
      room.broadcast({ t: 'ended', reason: 'completed', result });
      this.closeRoom(room);
      return true;
    }
    return false;
  }

  private reportHash(room: Room, member: Member, peer: Peer, turn: number, hash: number): void {
    if (!room.started) return reject(peer, 'not-started', 'game has not started');
    if (member.resigned || member.dropped) return;
    if (!Number.isSafeInteger(turn) || turn < 0 || turn > member.nextTurn || turn > room.log.length + MAX_TURNS_AHEAD) {
      return reject(peer, 'bad-turn', `turn ${turn} has not run yet`);
    }
    this.pruneHashes(room);
    if (turn < room.log.length - MAX_TURNS_AHEAD || room.comparedHashes.has(turn) || member.resigned || member.dropped) return;
    // The first sample is immutable just as an accepted command batch is.
    if (!member.hashes.has(turn)) member.hashes.set(turn, hash);
    this.compareHashes(room, turn);
  }

  private pruneHashes(room: Room): void {
    const oldest = room.log.length - MAX_TURNS_AHEAD;
    for (const m of room.members) for (const turn of m.hashes.keys()) if (turn < oldest) m.hashes.delete(turn);
    for (const turn of room.comparedHashes) if (turn < oldest) room.comparedHashes.delete(turn);
  }

  private compareHashes(room: Room, turn: number): void {
    const active = room.members.filter(m => !m.dropped && !m.resigned);
    if (active.length === 0 || active.some(m => !m.hashes.has(turn)) || room.comparedHashes.has(turn)) return;
    const hashes = Array.from({length:room.capacity}, (_,slot) => active.find(m => m.slot === slot)?.hashes.get(turn) ?? 0);
    const reported = active.map(m => m.hashes.get(turn)!);
    // Keep bounded samples until pruning so result votes can be checked against them.
    room.comparedHashes.add(turn);
    if (reported.some(h => h !== reported[0])) {
      room.desyncs.push(turn);
      room.broadcast({t:'desync',turn,hashes});
    }
  }

  private comparePendingHashes(room: Room): void {
    this.pruneHashes(room);
    for (const turn of new Set(room.members.flatMap(m => [...m.hashes.keys()]))) this.compareHashes(room,turn);
  }
}

function reject(peer: Peer, code: ErrorCode, message: string): void {
  peer.send({ t: 'error', code, message });
}

function sameResult(a: MatchResult, b: MatchResult): boolean {
  return a.turn === b.turn && a.hash === b.hash && a.winners.length === b.winners.length && a.winners.every((id,i) => id === b.winners[i]);
}
