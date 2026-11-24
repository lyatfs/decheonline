import { randomBytes, randomInt } from 'node:crypto';
import {
  CIV_COUNT,
  CODE_ALPHABET,
  CODE_LENGTH,
  COMMAND_DELAY_TURNS,
  DEFAULT_BOT_DIFFICULTY,
  DEFAULT_GAME_SETTINGS,
  DEFAULT_ROOM_MODE,
  DROP_AFTER_MS,
  MAX_NAME_LENGTH,
  MAX_PLAYERS,
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
  /** Null while the member's socket is away (dropped, not left) in a started game. */
  peer: Peer | null;
  name: string;
  ready: boolean;
  /** The civ drop-down's value (docs/spec/lobby.md §3). */
  civ: number;
  /** Next turn this member must submit. */
  nextTurn: number;
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
  started = false;
  seed = 0;
  paused = false;
  pauseBoundary = 0;
  pauseEpoch = 0;
  gameOver = false;
  /** The host's map type, map size and victory condition (docs/spec/lobby.md §2). */
  settings: GameSettings = structuredClone(DEFAULT_GAME_SETTINGS);
  /** Step size and buffer frames: the server plays the host (docs/spec/turn-timing.md §8.2). */
  readonly speed = new SpeedHost();

  constructor(
    readonly code: string,
    readonly mode: RoomMode = DEFAULT_ROOM_MODE,
    readonly difficulty?: BotDifficulty,
    readonly botToken?: string,
  ) {}

  players(): PlayerInfo[] {
    return this.members.map((m, slot) => ({ slot, name: m.name, ready: m.ready, civ: m.civ }));
  }

  broadcast(message: ServerMessage): void {
    for (const m of this.members) m.peer?.send(message);
  }

  /** Each member's round trip and last reported frame time, as the clients' score display reads them. */
  rttMessage(): ServerMessage {
    return { t: 'rtt', rtt: this.members.map((m) => m.rtt), frameMs: this.members.map((m) => m.frameMs) };
  }

  sendLobby(): void {
    const players = this.players();
    const extra = this.mode === 'single-player' && this.difficulty !== undefined ? { difficulty: this.difficulty } : {};
    this.members.forEach((m, you) =>
      m.peer?.send({
        t: 'lobby',
        code: this.code,
        you,
        players,
        settings: this.settings,
        mode: this.mode,
        ...extra,
        ...(this.mode === 'single-player' && you === 0 && !m.isBot && this.botToken ? { botToken: this.botToken } : {}),
      }),
    );
  }
}

export interface RoomRegistryOptions {
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

  constructor(options: RoomRegistryOptions = {}) {
    this.generateCode = options.generateCode ?? randomCode;
    this.generateSeed = options.generateSeed ?? (() => randomInt(2 ** 32));
    this.now = options.now ?? (() => performance.now());
    this.generateToken = options.generateToken ?? (() => randomBytes(16).toString('hex'));
    this.schedule = options.schedule ?? schedule;
    this.generateCiv = options.generateCiv ?? (() => randomInt(CIV_COUNT) + 1);
    this.dropAfterMs = options.dropAfterMs ?? DROP_AFTER_MS;
  }

  roomOf(peer: Peer): Room | undefined {
    return this.byPeer.get(peer);
  }

  handle(peer: Peer, message: ClientMessage): void {
    switch (message.t) {
      case 'create':
        return this.create(peer, message.name, message.mode, message.difficulty);
      case 'join':
        return this.join(peer, message.code, message.name, message.botToken);
      case 'rejoin':
        return this.rejoin(peer, message.code, message.slot, message.token, message.received);
      case 'leave':
        return this.disconnect(peer);
      default:
        break;
    }
    const room = this.byPeer.get(peer);
    if (!room) return reject(peer, 'not-in-room', 'join or create a room first');
    const slot = room.members.findIndex((m) => m.peer === peer);
    const member = room.members[slot];
    if (!member) return reject(peer, 'not-in-room', 'join or create a room first');
    member.heardAt = this.now();
    if (room.started) this.ping(member, false);
    switch (message.t) {
      case 'ready':
        if (room.started) return reject(peer, 'room-started', 'game already started');
        member.ready = message.ready;
        return room.sendLobby();
      case 'settings': {
        if (room.started) return reject(peer, 'room-started', 'game already started');
        if (slot !== 0) return reject(peer, 'not-host', 'only the host can change the settings');
        if (member.ready) return reject(peer, 'locked', 'the settings cannot change while the host is ready');
        const valid = parseLobbySettings(message.settings);
        if (valid === null) return reject(peer, 'invalid-settings', 'invalid game settings');
        room.settings = valid;
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
        return this.start(room, slot, peer);
      case 'turn':
        if (message.frameMs !== undefined && room.started) member.frameMs = message.frameMs;
        return this.submitTurn(room, member, peer, message.turn, message.commands);
      case 'pong':
        return this.pong(room, member, message.n);
      case 'hash':
        return this.reportHash(room, member, peer, message.turn, message.hash);
      case 'chat':
        return this.chat(room, slot, message.text, message.to);
      case 'pause':
        return this.pause(room, member, slot, peer, message.paused, message.epoch);
    }
  }

  /**
   * Remove a peer from its room: a leave message or a socket closed on purpose (`dropped` false), or a socket that broke
   * (`dropped`). In a started game a broken socket keeps its slot for `rejoin` until `DROP_AFTER_MS` after the server
   * last heard from it; then the player is dropped (docs/spec/turn-timing.md §9). Leaving ends the game for the others,
   * unless the player resigned first (Quit Game, `disconnect_multiplayer_game` sends `SendIResignMsg`): then the game
   * goes on for them, the server filling its batches.
   */
  disconnect(peer: Peer, dropped = false): void {
    const room = this.byPeer.get(peer);
    if (!room) return;
    this.byPeer.delete(peer);
    const slot = room.members.findIndex((m) => m.peer === peer);
    if (room.started && dropped) return this.away(room, room.members[slot]!);
    const member = room.members[slot]!;
    if (room.started && member.resigned && room.members.some((m) => m !== member && m.peer !== null)) {
      member.peer = null;
      member.dropped = true;
      room.gameOver = true;
      this.release(room);
      return;
    }
    room.members.splice(slot, 1);
    if (room.started) {
      room.broadcast({ t: 'ended', reason: 'peer-left' });
      this.closeRoom(room);
      return;
    }
    if (room.members.length === 0) {
      this.rooms.delete(room.code);
      return;
    }
    for (const m of room.members) m.ready = false;
    room.sendLobby();
  }

  private closeRoom(room: Room): void {
    for (const m of room.members) {
      if (m.peer) this.byPeer.delete(m.peer);
      m.cancelDrop?.();
      m.cancelDrop = null;
    }
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
    member.dropped = true;
    room.gameOver = true;
    room.broadcast({ t: 'dropped', slot: room.members.indexOf(member) });
    member.pending.set(member.nextTurn, [{ type: 'resign' }]);
    member.nextTurn++;
    this.release(room);
  }

  /** Give a dropped socket's slot back to its client (`rejoin`): the turns it missed follow `rejoined`. */
  private rejoin(peer: Peer, rawCode: string, slot: number, token: string, received: number): void {
    if (this.byPeer.has(peer)) return reject(peer, 'already-in-room', 'leave the current room first');
    const code = normalizeCode(rawCode);
    const room = isValidCode(code) ? this.rooms.get(code) : undefined;
    const member = room?.started ? room.members[slot] : undefined;
    if (!room || !member || member.dropped || member.token !== token || received > room.log.length) {
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
      nextTurn: member.nextTurn,
      mode: room.mode,
      ...(room.mode === 'single-player' && room.difficulty !== undefined ? { difficulty: room.difficulty } : {}),
      ...pauseSnapshot,
    });
    for (const record of room.log.slice(received)) peer.send({ t: 'turn', ...record });
    peer.send(room.rttMessage());
    this.ping(member, true);
  }

  private newMember(peer: Peer, name: string, slot: number, isBot: boolean): Member {
    return {
      peer,
      name: name === '' ? `Player ${slot + 1}` : name,
      ready: false,
      civ: this.generateCiv(),
      nextTurn: 0,
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

  private create(peer: Peer, name: string, rawMode?: RoomMode, rawDifficulty?: BotDifficulty): void {
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
    const difficulty = mode === 'single-player' ? (rawDifficulty ?? DEFAULT_BOT_DIFFICULTY) : undefined;
    const botToken = mode === 'single-player' ? this.generateToken() : undefined;
    let code = this.generateCode();
    while (this.rooms.has(code)) code = this.generateCode();
    const room = new Room(code, mode, difficulty, botToken);
    room.members.push(this.newMember(peer, name.trim(), 0, false));
    this.rooms.set(code, room);
    this.byPeer.set(peer, room);
    room.sendLobby();
  }

  private join(peer: Peer, rawCode: string, name: string, botToken?: string): void {
    if (this.byPeer.has(peer)) return reject(peer, 'already-in-room', 'leave the current room first');
    if (typeof rawCode !== 'string' || rawCode.length > 32) return reject(peer, 'bad-code', 'no room with that invite code');
    if (typeof name !== 'string' || name.trim().length > MAX_NAME_LENGTH) {
      return reject(peer, 'bad-message', 'invalid player name');
    }
    const code = normalizeCode(rawCode);
    const room = isValidCode(code) ? this.rooms.get(code) : undefined;
    if (!room) return reject(peer, 'bad-code', 'no room with that invite code');
    if (room.started) return reject(peer, 'room-started', 'game already started');
    if (room.members.length >= MAX_PLAYERS) return reject(peer, 'room-full', 'room is full');
    if (room.mode === 'single-player') {
      if (!room.botToken || typeof botToken !== 'string' || botToken.length === 0 || botToken !== room.botToken) {
        return reject(peer, 'unauthorized', 'valid bot token required to join single-player room');
      }
    }
    for (const m of room.members) m.ready = false;
    room.members.push(this.newMember(peer, name.trim(), room.members.length, room.mode === 'single-player'));
    this.byPeer.set(peer, room);
    room.sendLobby();
  }

  private start(room: Room, slot: number, peer: Peer): void {
    if (room.started) return reject(peer, 'room-started', 'game already started');
    if (slot !== 0) return reject(peer, 'not-host', 'only the host can start');
    if (room.members.length < MAX_PLAYERS || room.members.some((m) => !m.ready)) {
      return reject(peer, 'not-ready', 'every player must be ready');
    }
    room.started = true;
    room.seed = this.generateSeed();
    const players = room.players();
    const extra = room.mode === 'single-player' && room.difficulty !== undefined ? { difficulty: room.difficulty } : {};
    for (const m of room.members) {
      m.token = this.generateToken();
      m.peer?.send({
        t: 'start',
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

  private submitTurn(room: Room, member: Member, peer: Peer, turn: number, commands: Command[]): void {
    if (!room.started) return reject(peer, 'not-started', 'game has not started');
    if (turn !== member.nextTurn) {
      return reject(peer, 'bad-turn', `expected turn ${member.nextTurn}, got ${turn}`);
    }
    if (turn - room.log.length >= MAX_TURNS_AHEAD) {
      return reject(peer, 'bad-turn', 'too many unreleased turns');
    }
    const slot = room.members.indexOf(member);
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
    member.pending.set(turn, commands);
    member.nextTurn++;
    if (commands.some((c) => c.type === 'resign')) {
      member.resigned = true;
      room.gameOver = true;
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
    if (room.gameOver) return reject(peer, 'locked', 'cannot pause after game over');
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
      if (m.peer === null && !m.dropped) {
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
      if (room.members.some((m) => !m.dropped && !m.pending.has(turn))) return;
      const batches = room.members.map((m, slot) => ({ slot, commands: m.pending.get(turn) ?? [] }));
      for (const m of room.members) m.pending.delete(turn);
      // Through the relay a round trip between players is the sum of both legs (turn-timing.md §8.3).
      const latency = highLatencyMs(room.members.reduce((sum, m) => sum + m.rtt, 0));
      const frameMs = Math.max(...room.members.map((m) => m.frameMs));
      const speed = room.speed.boundary(turn + 1, frameMs, latency);
      const record: TurnRecord = speed ? { turn, batches, speed } : { turn, batches };
      room.log.push(record);
      room.broadcast({ t: 'turn', ...record, frameMs: room.members.map((m) => m.frameMs) });
    }
  }

  /**
   * A chat message, in the lobby or the game: to each other player in `to` whose socket is here (`TXChat` sends it to
   * the players its `DestPlayers` names; the sender adds its own copy, docs/spec/chat.md §3). Never part of a turn.
   */
  private chat(room: Room, from: number, text: string, to: number[]): void {
    for (const slot of new Set(to)) if (slot !== from) room.members[slot]?.peer?.send({ t: 'chat', from, text });
  }

  private reportHash(room: Room, member: Member, peer: Peer, turn: number, hash: number): void {
    if (!room.started) return reject(peer, 'not-started', 'game has not started');
    // A client reports the hash of turn N just before it submits the batch of turn N (Lockstep.endTurn), so the report
    // reaches the relay before turn N is released: it is held until the other player's hash arrives.
    if (turn > member.nextTurn) return reject(peer, 'bad-turn', `turn ${turn} has not run yet`);
    member.hashes.set(turn, hash);
    if (room.members.some((m) => !m.dropped && !m.hashes.has(turn))) return;
    const hashes = room.members.map((m) => m.hashes.get(turn) ?? 0);
    for (const m of room.members) m.hashes.delete(turn);
    const reported = hashes.filter((_, slot) => !room.members[slot]!.dropped);
    if (reported.some((h) => h !== reported[0])) {
      room.desyncs.push(turn);
      room.broadcast({ t: 'desync', turn, hashes });
    }
  }
}

function reject(peer: Peer, code: ErrorCode, message: string): void {
  peer.send({ t: 'error', code, message });
}
