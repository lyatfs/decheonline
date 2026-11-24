import type { BotDifficulty, ErrorCode, GameSettings, PlayerInfo, RoomMode, ServerMessage, Slot } from '@aoe/protocol';
import { DEFAULT_GAME_SETTINGS, DEFAULT_ROOM_MODE, MAX_CHAT_LENGTH, normalizeCode } from '@aoe/protocol';
import { track } from '../analytics';
import type { Link } from '../net/link';

export type StartMessage = Extract<ServerMessage, { t: 'start' }>;

export interface CreateRoomOptions {
  mode?: RoomMode;
  difficulty?: BotDifficulty;
}

export interface LobbyState {
  phase: 'idle' | 'lobby' | 'playing' | 'ended';
  code: string;
  /** This client's slot; -1 before joining. */
  you: Slot;
  players: PlayerInfo[];
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

/** Lobby logic over a link, no DOM: create/join by code, ready, host start. Gameplay messages belong to lockstep. */
export class Session {
  /** Settings sent whose echo has not come back, oldest first; while any is pending the shown settings are the local ones. */
  private pendingSettings: GameSettings[] = [];
  state: LobbyState = {
    phase: 'idle',
    code: '',
    you: -1,
    players: [],
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

  constructor(private readonly link: Link) {
    link.onMessage((m) => this.handle(m));
    link.onClose(() => {
      if (this.state.phase === 'playing') return; // lockstep reports this as the opponent leaving
      this.pendingSettings = [];
      this.set({
        phase: 'idle',
        code: '',
        you: -1,
        players: [],
        mode: DEFAULT_ROOM_MODE,
        difficulty: undefined,
        botToken: undefined,
        error: { code: 'connection', message: 'Connection to the server was lost.' },
      });
    });
  }

  create(name: string, options?: CreateRoomOptions): void {
    this.set({ error: null });
    track('room_create');
    const mode = options?.mode;
    const difficulty = mode === 'single-player' ? options?.difficulty : undefined;
    this.link.send({
      t: 'create',
      name,
      ...(mode !== undefined ? { mode } : {}),
      ...(difficulty !== undefined ? { difficulty } : {}),
    });
  }

  join(code: string, name: string, botToken?: string): void {
    this.set({ error: null });
    this.link.send({
      t: 'join',
      code: normalizeCode(code),
      name,
      ...(botToken !== undefined ? { botToken } : {}),
    });
  }

  setReady(ready: boolean): void {
    this.link.send({ t: 'ready', ready });
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
      mode: DEFAULT_ROOM_MODE,
      difficulty: undefined,
      botToken: undefined,
    });
  }

  private handle(m: ServerMessage): void {
    switch (m.t) {
      case 'lobby': {
        // An echo carrying a pending settings object answers it and every older one; others (a guest's ready or civ) change nothing here.
        const answered = this.pendingSettings.findIndex((p) => sameJson(p, m.settings));
        if (answered >= 0) this.pendingSettings.splice(0, answered + 1);
        const mode = m.mode ?? DEFAULT_ROOM_MODE;
        this.set({
          phase: 'lobby',
          code: m.code,
          you: m.you,
          players: m.players,
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
        track('game_start', { map_type: m.settings.mapType, player_count: m.players.length });
        this.set({ phase: 'playing', players: m.players, settings: m.settings, mode, difficulty });
        this.onStart(m, this.state.you);
        return;
      }
      case 'rejoined': {
        const mode = m.mode ?? this.state.mode ?? DEFAULT_ROOM_MODE;
        const difficulty = mode === 'single-player' ? (m.difficulty ?? this.state.difficulty) : undefined;
        this.set({ mode, difficulty });
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
    this.onChat(`${this.state.players.find((p) => p.slot === slot)?.name ?? ''}: ${text}`);
  }

  private set(patch: Partial<LobbyState>): void {
    this.state = { ...this.state, ...patch };
    this.onChange(this.state);
  }
}
