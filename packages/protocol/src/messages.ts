/** Wire messages between client and relay server. One JSON object per WebSocket text frame, tagged by `t`. */

import {
  BUFFER_FRAMES,
  CIV_COUNT,
  CIV_RANDOM,
  COMMAND_DELAY_TURNS,
  DEFAULT_GAME_SETTINGS,
  DEFAULT_GAME_SPEED,
  GAME_SPEEDS,
  SINGLE_PLAYER_SPEED_MAX,
  SINGLE_PLAYER_SPEED_MIN,
  SINGLE_PLAYER_SPEED_STEP,
  STEP_MS,
  isLobbyCiv,
  isLobbySettings,
  isMultiplayerGameSpeed,
  isSinglePlayerGameSpeed,
  type Command,
  type GameSettings,
  type SpeedChange,
} from '@aoe/sim';

/** Games start at `STEP_MS` per step and `BUFFER_FRAMES`; the server retunes both (docs/spec/turn-timing.md §8). */
export {
  BUFFER_FRAMES,
  COMMAND_DELAY_TURNS,
  DEFAULT_GAME_SPEED,
  GAME_SPEEDS,
  SINGLE_PLAYER_SPEED_MAX,
  SINGLE_PLAYER_SPEED_MIN,
  SINGLE_PLAYER_SPEED_STEP,
  STEP_MS,
  isMultiplayerGameSpeed,
  isSinglePlayerGameSpeed,
  type Command,
  type SpeedChange,
};
/** The lobby's settings and civs (docs/spec/lobby.md). */
export { CIV_COUNT, CIV_RANDOM, DEFAULT_GAME_SETTINGS, isLobbyCiv, isLobbySettings, type GameSettings };
/** Protocol ceiling; each room independently selects its capacity. */
export const MAX_PLAYERS = 4;
export type RoomCapacity = 2 | 4;
export const DEFAULT_ROOM_CAPACITY: RoomCapacity = 2;

export function isRoomCapacity(value: unknown): value is RoomCapacity {
  return value === 2 || value === 4;
}

export interface CompatibilityVersions {
  protocol: string;
  rules: string;
  build: string;
  assets: string;
}

export const DEFAULT_COMPATIBILITY_VERSIONS: Readonly<CompatibilityVersions> = Object.freeze({
  protocol: 'mp4-v1', rules: 'sim-v1', build: 'development', assets: 'development',
});

export function isCompatibilityVersions(value: unknown): value is CompatibilityVersions {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const v = value as Record<string, unknown>;
  return ['protocol', 'rules', 'build', 'assets'].every((key) => typeof v[key] === 'string' && v[key].length > 0 && v[key].length <= 128);
}

export function sameCompatibilityVersions(a: CompatibilityVersions, b: CompatibilityVersions): boolean {
  return a.protocol === b.protocol && a.rules === b.rules && a.build === b.build && a.assets === b.assets;
}
export const MAX_NAME_LENGTH = 24;
export const MAX_COMMANDS_PER_BATCH = 256;
/** A chat message's text: `TXChat` sends at most 255 characters (src/com_hand.cpp:1972-1981; docs/spec/chat.md §3). */
export const MAX_CHAT_LENGTH = 255;

export type RoomMode = 'multiplayer' | 'single-player';
export const ROOM_MODES = ['multiplayer', 'single-player'] as const;
export const DEFAULT_ROOM_MODE: RoomMode = 'multiplayer';

/** Kept aligned with `apps/client/src/bot/types.ts`. */
export type BotDifficulty = 'easy' | 'medium' | 'hard';
export const BOT_DIFFICULTIES = ['easy', 'medium', 'hard'] as const;
export const DEFAULT_BOT_DIFFICULTY: BotDifficulty = 'medium';

export function isRoomMode(value: unknown): value is RoomMode {
  return value === 'multiplayer' || value === 'single-player';
}

export function isBotDifficulty(value: unknown): value is BotDifficulty {
  return value === 'easy' || value === 'medium' || value === 'hard';
}

export function parseBotDifficulty(value: unknown): BotDifficulty | null {
  return isBotDifficulty(value) ? value : null;
}

/** Invite code: 5 characters, no 0/O/1/I/L lookalikes; matched case-insensitively. */
export const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
export const CODE_LENGTH = 5;

/** Stable player seat; the host role is carried separately in `hostSlot`. */
export type Slot = number;
export type SlotId = 0 | 1 | 2 | 3;
export type SeatStatus = 'open' | 'occupied' | 'away' | 'resigned' | 'dropped';

export interface RoomSeat {
  slot: Slot;
  status: SeatStatus;
  name: string | null;
  civ: number | null;
  ready: boolean;
}

export interface MatchParticipant {
  slot: Slot;
  playerId: number;
  name: string;
  civ: number;
}

/** Frozen by the server at start and reused unchanged for reconnects. */
export interface MatchManifest {
  code: string;
  capacity: RoomCapacity;
  mode: RoomMode;
  hostSlot: Slot;
  players: MatchParticipant[];
  seed: number;
  settings: GameSettings;
  versions: CompatibilityVersions;
}

export interface MatchResult {
  turn: number;
  hash: number;
  /** Sim player IDs 1..4; an empty array represents a draw. */
  winners: number[];
}

export interface PlayerInfo {
  slot: Slot;
  name: string;
  ready: boolean;
  /** The player's civilization drop-down: 1 Egyptian .. 16 Macedonian, 17 Random (docs/spec/lobby.md §3). */
  civ: number;
}

export interface TurnBatch {
  slot: Slot;
  commands: Command[];
}

// Client -> server

export type ClientMessage =
  | { t: 'create'; name: string; mode?: RoomMode; difficulty?: BotDifficulty; capacity?: RoomCapacity; versions?: CompatibilityVersions }
  | { t: 'join'; code: string; name: string; botToken?: string; versions?: CompatibilityVersions }
  | { t: 'ready'; ready: boolean; versions?: CompatibilityVersions }
  /** Host only, while not ready: the map type, map size and victory condition (docs/spec/lobby.md §2, §4). */
  | { t: 'settings'; settings: GameSettings }
  /** This player's civilization, while not ready (docs/spec/lobby.md §3, §4). */
  | { t: 'civ'; civ: number }
  /** Host only, once every player is ready. */
  | { t: 'start' }
  /**
   * Commands issued during turn `turn`, sent when the client has run it; they execute on `turn + COMMAND_DELAY_TURNS`.
   * Each client sends exactly one batch per turn, in order starting at 0 (empty batches included), up to
   * MAX_TURNS_AHEAD past the last turn the server has released. `frameMs`: the client's mean frame time, whole ms
   * up to 255, once it has one (docs/spec/turn-timing.md §8.4).
   */
  | { t: 'turn'; turn: number; commands: Command[]; frameMs?: number }
  /** Hash of the sim state after executing `turn`. */
  | { t: 'hash'; turn: number; hash: number }
  /** Agreed sim result; the relay validates agreement before completing a match. */
  | ({ t: 'result' } & MatchResult)
  /** Answer to the server's `ping` `n`, sent at once. */
  | { t: 'pong'; n: number }
  /**
   * Take slot `slot` of started room `code` back after this client's socket dropped (docs/spec/turn-timing.md §9).
   * `token` is the one `start` gave this client; `received` is how many released turns it has (it gets the rest).
   */
  | { t: 'rejoin'; code: string; slot: Slot; token: string; received: number }
  /**
   * A chat message for the players in `to` (`TXChat`'s `DestPlayers`, docs/spec/chat.md §3), in the lobby or the game.
   * Outside the turns: it never reaches the sim. The sender shows its own copy itself.
   */
  | { t: 'chat'; text: string; to: Slot[] }
  /** Single-player host pause/resume request outside the turn queue (with optional last known epoch). */
  | { t: 'pause'; paused: boolean; epoch?: number }
  | { t: 'leave' };

// Server -> client

export type ErrorCode =
  | 'bad-message'
  | 'bad-code'
  | 'room-full'
  | 'room-started'
  | 'already-in-room'
  | 'not-in-room'
  | 'not-host'
  | 'not-ready'
  | 'not-started'
  | 'bad-turn'
  /** The room, slot or token of a `rejoin` is wrong, or the slot was dropped. */
  | 'bad-rejoin'
  /** A ready player's civ, or the settings while the host is ready, cannot change (docs/spec/lobby.md §4). */
  | 'locked'
  /** Missing or invalid `botToken` for a single-player room, or caller lacks mode/slot authority. */
  | 'unauthorized'
  /** Server-side boundary rejection for invalid mode, difficulty, civ, or game settings. */
  | 'invalid-settings'
  | 'version-mismatch'
  | 'bad-result';

export type EndReason = 'peer-left' | 'completed';

export type ServerMessage =
  /** Sent on create/join and whenever the lobby changes. `you` is the receiver's slot; `botToken` is only sent to slot 0 host in `'single-player'` mode. */
  | { t: 'lobby'; code: string; you: Slot; players: PlayerInfo[]; settings: GameSettings; mode?: RoomMode; difficulty?: BotDifficulty; botToken?: string; capacity?: RoomCapacity; hostSlot?: Slot; seats?: RoomSeat[]; versions?: CompatibilityVersions }
  /**
   * The game begins. Every client seeds its sim with `seed` and submits each turn's batch once it has run it. `token`
   * is the receiver's own: it takes the slot back with `rejoin` after a dropped socket. `settings` and each player's
   * `civ` are the lobby's at the start (`lobbyWorldOptions` turns them into the world).
   */
  | { t: 'start'; seed: number; commandDelay: number; players: PlayerInfo[]; settings: GameSettings; token: string; mode?: RoomMode; difficulty?: BotDifficulty; capacity?: RoomCapacity; hostSlot?: Slot; manifest?: MatchManifest; versions?: CompatibilityVersions }
  /**
   * Answer to a good `rejoin`: the slot is this client's again. `nextTurn` is the first turn the server has no batch
   * of it for: the client sends its batches from there. The released turns it lacks follow as `turn` messages.
   */
  | { t: 'rejoined'; nextTurn: number; mode?: RoomMode; difficulty?: BotDifficulty; paused?: boolean; pauseBoundary?: number; pauseEpoch?: number; capacity?: RoomCapacity; hostSlot?: Slot; manifest?: MatchManifest; versions?: CompatibilityVersions }
  /** Authoritative pause/resume state change broadcast to all members in a single-player room. */
  | { t: 'paused'; paused: boolean; boundary: number; epoch: number }
  /**
   * The player in `slot` stayed away `DROP_AFTER_MS` and is dropped: the server sends a `resign` in its next batch and
   * empty ones after it (`COMM_OTHER_PLAYER_DROPPED`, docs/spec/turn-timing.md §9).
   */
  | { t: 'dropped'; slot: Slot }
  /**
   * All participant batches issued during `turn`, ordered by slot. Released strictly in turn order. `speed`: the step size and
   * buffer frames the server agreed for turn `speed.turn` (later than `turn + COMMAND_DELAY_TURNS`); give it to the
   * sim when this batch is. `frameMs`: each slot's last reported mean frame time, ms (0 before the first), on every
   * live release as the original carries it on each turn's done message (absent on the turns a rejoin replays).
   */
  | { t: 'turn'; turn: number; batches: TurnBatch[]; speed?: SpeedChange; frameMs?: number[] }
  /** Round-trip probe; answer with `pong` (docs/spec/turn-timing.md §8.3). */
  | { t: 'ping'; n: number }
  /**
   * The server's latest round trip to each slot, ms (0 before the first), and each slot's last reported mean frame
   * time `frameMs`, ms (0 before the first): the score display's latency and slow-player icons (docs/spec/hud.md). The
   * frame times also ride on every `turn`, so they follow within a turn; this message is sent after each pong.
   */
  | { t: 'rtt'; rtt: number[]; frameMs: number[] }
  /** State hashes for `turn` disagreed. `hashes` is indexed by slot. */
  | { t: 'desync'; turn: number; hashes: number[] }
  /** Player `from`'s chat message to this client (docs/spec/chat.md §3). */
  | { t: 'chat'; from: Slot; text: string }
  | { t: 'ended'; reason: EndReason; result?: MatchResult }
  | { t: 'error'; code: ErrorCode; message: string };

/**
 * A player whose socket dropped is dropped from the game this long after the server last heard from it: the original's
 * non-host timeout (`0x1D6B4` ms, src/com_hand.cpp:560). Until then it may `rejoin`.
 */
export const DROP_AFTER_MS = 120_500;

/** The server buffers at most this many unreleased turns per player. */
export const MAX_TURNS_AHEAD = 64;

/** Uppercase and drop spaces/dashes, so "ab-c d2" matches "ABCD2". */
export function normalizeCode(raw: string): string {
  return raw.replace(/[\s-]/g, '').toUpperCase();
}

export function isValidCode(code: string): boolean {
  if (code.length !== CODE_LENGTH) return false;
  for (const ch of code) if (!CODE_ALPHABET.includes(ch)) return false;
  return true;
}
