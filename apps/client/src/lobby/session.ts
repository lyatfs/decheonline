import type {
  BotDifficulty,
  CompatibilityVersions,
  ErrorCode,
  GameSettings,
  PlayerInfo,
  RoomCapacity,
  RoomMode,
  RoomSeat,
  ServerMessage,
  Slot,
} from '@aoe/protocol';
import {
  DEFAULT_COMPATIBILITY_VERSIONS,
  DEFAULT_GAME_SETTINGS,
  DEFAULT_ROOM_CAPACITY,
  DEFAULT_ROOM_MODE,
  MAX_CHAT_LENGTH,
  isRoomCapacity,
  normalizeCode,
} from '@aoe/protocol';
import { track } from '../analytics';
import type { Link } from '../net/link';

export type StartMessage = Extract<ServerMessage, { t: 'start' }>;

export interface CreateRoomOptions {
  mode?: RoomMode;
  difficulty?: BotDifficulty;
  capacity?: RoomCapacity;
  versions?: CompatibilityVersions;
}

export interface LobbyState {
  phase: 'idle' | 'lobby' | 'playing' | 'ended';
  code: string;
  /** This client's slot; -1 before joining. */
  you: Slot;
  players: PlayerInfo[];
  /** Authoritative room seats (`0..capacity - 1`). */
  seats: RoomSeat[];
  /** Server-authoritative room capacity (`2` default, or `4`). */
  capacity: RoomCapacity;
  /** Server-authoritative host slot (`-1` when idle). */
  hostSlot: Slot;
  /** Compatibility versions reported by the server, or `null` when unknown. */
  versions: CompatibilityVersions | null;
  /** The host's map type, map size and victory condition, as the server last sent them. */
  settings: GameSettings;
  /** Server-authoritative room mode (`'multiplayer'` default). */
  mode?: RoomMode;
  /** Server-authoritative bot difficulty (only present in `'single-player'` mode). */
  difficulty?: BotDifficulty;
  /** Host-only secret token for spawning the slot-1 bot in `'single-player'` mode. */
  botToken?: string;
  /** Last error from the server (bad code, room full, ...), cleared by the next action. */
  error: { code: ErrorCode | 'connection'; message: string } | null;
}

const sameJson = (a: unknown, b: unknown): boolean => {
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return a === b;
  const ka = Object.keys(a);
  return ka.length === Object.keys(b).length && ka.every((k) => sameJson((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]));
};

function inferCapacity(players: readonly PlayerInfo[], seats?: readonly RoomSeat[]): RoomCapacity {
  if (seats && isRoomCapacity(seats.length)) return seats.length;
  if (players.some((p) => p.slot >= 2) || players.length > 2) return 4;
  return DEFAULT_ROOM_CAPACITY;
}

function buildSeats(capacity: RoomCapacity, players: readonly PlayerInfo[]): RoomSeat[] {
  return Array.from({ length: capacity }, (_, slot) => {
    const p = players.find((m) => m.slot === slot);
    if (!p) return { slot, status: 'open', name: null, civ: null, ready: false };
    return { slot, status: 'occupied', name: p.name, civ: p.civ, ready: p.ready };
  });
}

function cloneSeats(seats: readonly RoomSeat[]): RoomSeat[] {
  return seats.map((s) => ({ ...s }));
}

function cloneVersions(versions: CompatibilityVersions | null | undefined): CompatibilityVersions | null {
  return versions ? { ...versions } : null;
}

/** Lobby logic over a link, no DOM: create/join by code, ready, host start. Gameplay messages belong to lockstep. */
export class Session {
  /** Settings sent whose echo has not come back, oldest first; while any is pending the shown settings are the local ones. */
  private pendingSettings: GameSettings[] = [];
  private configuredVersions: CompatibilityVersions | null = null;
  state: LobbyState = {
    phase: 'idle',
    code: '',
    you: -1,
    players: [],
    seats: [],
    capacity: DEFAULT_ROOM_CAPACITY,
    hostSlot: -1,
    versions: null,
    settings: DEFAULT_GAME_SETTINGS,
    mode: DEFAULT_ROOM_MODE,
    difficulty: undefined,
    botToken: undefined,
    error: null,
  };
  /** Called after every state change. */
  onChange: (state: LobbyState) => void = () => {};
  /** Called when the host starts the game. */
  onStart: (start: StartMessage, you: Slot) => void = () => {};
  /** Called with each chat line of the room, "Name: text" (`TChat::AddChatMsg`), this player's own included. */
  onChat: (line: string) => void = () => {};

  constructor(private readonly link: Link, versions: CompatibilityVersions | null = null) {
    this.configuredVersions = cloneVersions(versions);
    link.onMessage((m) => this.handle(m));
    link.onClose(() => {
      if (this.state.phase === 'playing') return; // lockstep reports this as the opponent leaving
      this.pendingSettings = [];
      this.set({
        phase: 'idle',
        code: '',
        you: -1,
        players: [],
        seats: [],
        capacity: DEFAULT_ROOM_CAPACITY,
        hostSlot: -1,
        versions: null,
        settings: DEFAULT_GAME_SETTINGS,
        mode: DEFAULT_ROOM_MODE,
        difficulty: undefined,
        botToken: undefined,
        error: { code: 'connection', message: 'Connection to the server was lost.' },
      });
    });
  }

  setVersions(versions: CompatibilityVersions | null): void {
    this.configuredVersions = cloneVersions(versions);
  }

  getLobbyState(): LobbyState {
    return {
      ...this.state,
      players: this.state.players.map((p) => ({ ...p })),
      seats: cloneSeats(this.state.seats),
      versions: cloneVersions(this.state.versions),
      settings: { ...this.state.settings, victory: { ...this.state.settings.victory } },
      error: this.state.error ? { ...this.state.error } : null,
    };
  }

  create(name: string, options?: CreateRoomOptions): void {
    this.set({ error: null });
    track('room_create');
    const mode = options?.mode;
    const difficulty = mode === 'single-player' ? options?.difficulty : undefined;
    const capacity = mode === 'single-player' ? undefined : options?.capacity;
    const versions =
      options?.versions ??
      this.configuredVersions ??
      (capacity === 4 ? DEFAULT_COMPATIBILITY_VERSIONS : undefined);
    this.link.send({
      t: 'create',
      name,
      ...(mode !== undefined ? { mode } : {}),
      ...(difficulty !== undefined ? { difficulty } : {}),
      ...(capacity !== undefined ? { capacity } : {}),
      ...(versions !== undefined ? { versions } : {}),
    });
  }

  join(code: string, name: string, botToken?: string, versions?: CompatibilityVersions): void {
    this.set({ error: null });
    const effectiveVersions = versions ?? this.configuredVersions ?? undefined;
    this.link.send({
      t: 'join',
      code: normalizeCode(code),
      name,
      ...(botToken !== undefined ? { botToken } : {}),
      ...(effectiveVersions !== undefined ? { versions: effectiveVersions } : {}),
    });
  }

  setReady(ready: boolean, versions?: CompatibilityVersions): void {
    this.set({ error: null });
    const effectiveVersions =
      versions ??
      this.configuredVersions ??
      (this.state.capacity === 4 ? DEFAULT_COMPATIBILITY_VERSIONS : undefined);
    this.link.send({
      t: 'ready',
      ready,
      ...(effectiveVersions !== undefined ? { versions: effectiveVersions } : {}),
    });
  }

  /** Host only, while not ready: the game's settings (docs/spec/lobby.md §4). */
  setSettings(settings: GameSettings): void {
    // Shown at once, so the next change builds on it; the echoes of the settings still pending are older and ignored.
    this.pendingSettings.push(settings);
    this.set({ error: null, settings });
    this.link.send({ t: 'settings', settings });
  }

  /** This player's civilization, while not ready. */
  setCiv(civ: number): void {
    this.set({ error: null });
    this.link.send({ t: 'civ', civ });
  }

  /**
   * The setup screen's chat: Enter sends the line to every player (`SendChatMsgAll`, src/scr_mps.cpp:750-754), this one
   * included, so it shows here at once (`TXChat`, src/com_hand.cpp:1966-1969).
   */
  sendChat(text: string): void {
    const line = text.slice(0, MAX_CHAT_LENGTH);
    if (this.state.phase !== 'lobby' || !line) return;
    this.chatLine(this.state.you, line);
    this.link.send({ t: 'chat', text: line, to: this.state.players.map((p) => p.slot) });
  }

  start(): void {
    this.set({ error: null });
    this.link.send({ t: 'start' });
  }

  /** Leave the room (or the game) and return to the entry screen. */
  leave(): void {
    this.link.send({ t: 'leave' });
    this.pendingSettings = [];
    this.set({
      phase: 'idle',
      code: '',
      you: -1,
      players: [],
      seats: [],
      capacity: DEFAULT_ROOM_CAPACITY,
      hostSlot: -1,
      versions: null,
      settings: DEFAULT_GAME_SETTINGS,
      mode: DEFAULT_ROOM_MODE,
      difficulty: undefined,
      botToken: undefined,
      error: null,
    });
  }

  /** The game is over (opponent left, desync): leave the room and show the entry screen. */
  finish(): void {
    this.link.send({ t: 'leave' });
    this.pendingSettings = [];
    this.set({
      phase: 'ended',
      code: '',
      you: -1,
      players: [],
      seats: [],
      capacity: DEFAULT_ROOM_CAPACITY,
      hostSlot: -1,
      versions: null,
      settings: DEFAULT_GAME_SETTINGS,
      mode: DEFAULT_ROOM_MODE,
      difficulty: undefined,
      botToken: undefined,
      error: null,
    });
  }

  private handle(m: ServerMessage): void {
    switch (m.t) {
      case 'lobby': {
        // An echo carrying a pending settings object answers it and every older one; others (a guest's ready or civ) change nothing here.
        const answered = this.pendingSettings.findIndex((p) => sameJson(p, m.settings));
        if (answered >= 0) this.pendingSettings.splice(0, answered + 1);
        const mode = m.mode ?? DEFAULT_ROOM_MODE;
        const capacity = m.capacity ?? inferCapacity(m.players, m.seats);
        const hostSlot = m.hostSlot ?? 0;
        const seats = m.seats ? cloneSeats(m.seats) : buildSeats(capacity, m.players);
        const versions = cloneVersions(m.versions);
        this.set({
          phase: 'lobby',
          code: m.code,
          you: m.you,
          players: m.players,
          seats,
          capacity,
          hostSlot,
          versions,
          mode,
          difficulty: mode === 'single-player' ? m.difficulty : undefined,
          botToken: mode === 'single-player' ? m.botToken : undefined,
          error: null,
          ...(this.pendingSettings.length === 0 && { settings: m.settings }),
        });
        return;
      }
      case 'start': {
        const mode = m.mode ?? this.state.mode ?? DEFAULT_ROOM_MODE;
        const difficulty = mode === 'single-player' ? (m.difficulty ?? this.state.difficulty) : undefined;
        const capacity = m.capacity ?? this.state.capacity ?? inferCapacity(m.players);
        const hostSlot = m.hostSlot ?? (this.state.hostSlot >= 0 ? this.state.hostSlot : 0);
        const versions = m.versions ? cloneVersions(m.versions) : this.state.versions;
        const seats = buildSeats(capacity, m.players);
        track('game_start', { map_type: m.settings.mapType, player_count: m.players.length });
        this.set({
          phase: 'playing',
          players: m.players,
          seats,
          settings: m.settings,
          mode,
          difficulty,
          capacity,
          hostSlot,
          versions,
        });
        this.onStart(m, this.state.you);
        return;
      }
      case 'rejoined': {
        const mode = m.mode ?? this.state.mode ?? DEFAULT_ROOM_MODE;
        const difficulty = mode === 'single-player' ? (m.difficulty ?? this.state.difficulty) : undefined;
        const capacity = m.capacity ?? this.state.capacity;
        const hostSlot = m.hostSlot ?? this.state.hostSlot;
        const versions = m.versions ? cloneVersions(m.versions) : this.state.versions;
        this.set({ mode, difficulty, capacity, hostSlot, versions });
        return;
      }
      case 'error':
        this.pendingSettings = [];
        this.set({ error: { code: m.code, message: m.message } });
        return;
      case 'chat':
        // A chat for the game screen is the game's (multiplayer.ts).
        if (this.state.phase === 'lobby') this.chatLine(m.from, m.text);
        return;
      default:
        return;
    }
  }

  private chatLine(slot: Slot, text: string): void {
    const name =
      this.state.players.find((p) => p.slot === slot)?.name ??
      this.state.seats.find((s) => s.slot === slot)?.name ??
      '';
    this.onChat(`${name}: ${text}`);
  }

  private set(patch: Partial<LobbyState>): void {
    this.state = { ...this.state, ...patch };
    this.onChange(this.state);
  }
}
