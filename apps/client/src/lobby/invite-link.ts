import { CODE_LENGTH, MAX_NAME_LENGTH, isValidCode, normalizeCode } from '@aoe/protocol';

/** Query parameter used for room invite links (`<origin>/?room=CODE`). */
export const INVITE_QUERY_PARAM = 'room';

const PLACEHOLDER_BASE = 'https://placeholder.invalid';
const IPV4_LOOPBACK_RE = /^127\.(?:25[0-5]|2[0-4]\d|1?\d?\d)\.(?:25[0-5]|2[0-4]\d|1?\d?\d)\.(?:25[0-5]|2[0-4]\d|1?\d?\d)$/;

function stripControlAndHtml(value: string): string {
  let out = '';
  for (const ch of value) {
    const code = ch.codePointAt(0) ?? 0;
    if (code < 0x20 || code === 0x7f || ch === '<' || ch === '>') continue;
    out += ch;
  }
  return out;
}
const LOCALHOST_IPV6_HOSTS = new Set([
  '[::1]',
  '::1',
  '[0:0:0:0:0:0:0:1]',
  '0:0:0:0:0:0:0:1',
  '[::]',
  '::',
  '[0:0:0:0:0:0:0:0]',
  '0:0:0:0:0:0:0:0',
  '[::ffff:127.0.0.1]',
  '[::ffff:7f00:1]',
]);

export type ShareableInviteFailureReason = 'localhost' | 'invalid-origin' | 'invalid-code';

export type ShareableInviteResult =
  | { ok: true; url: string }
  | { ok: false; reason: ShareableInviteFailureReason };

export interface CopyFallbackInput {
  focus?: () => void;
  select?: () => void;
}

export interface CopyInviteResult {
  copied: boolean;
  method: 'clipboard' | 'manual';
}

export interface InviteEntryState {
  readonly code: string;
  readonly name: string;
  readonly error: string | null;
  readonly joining: boolean;
  readonly fromInvite: boolean;
  readonly autoReady: false;
  readonly autoStart: false;
}

export type InviteJoinValidation =
  | { ok: true; code: string; name: string }
  | { ok: false; reason: 'empty-name' | 'invalid-code' | 'joining'; message: string };

export const INVITE_ERROR_TEXT: Readonly<Record<string, string>> = Object.freeze({
  'bad-code': 'No game with that invite code.',
  'room-full': 'That game is full.',
  'room-started': 'That game has already started.',
  'version-mismatch': 'Your game version does not match the room.',
  connection: 'Cannot reach the game server.',
  'empty-name': 'Please enter your player name before joining.',
  'invalid-code': 'Please enter a valid 5-character invite code.',
});

/**
 * Phase 2 wiring hooks (for M05 `apps/client/src/lobby/lobby-view.ts` and M10 `apps/client/src/multiplayer.ts`):
 *
 * - Entry initialization (`LobbyView` / `startMultiplayer`):
 *   `createInviteEntryState(location.href, initialName)` -> prefill `code` when `?room=CODE` is valid,
 *   never set `autoReady` or `autoStart`, and require explicit user action (`canSubmitInviteJoin(state)`).
 * - Entry form updates & error preservation (`LobbyView.entry`):
 *   `setInviteName(state, rawName)`, `setInviteCode(state, rawCode)`, `setInviteError(state, msg)`,
 *   `setInviteJoining(state, joining)`, `validateInviteJoin(state)`, `inviteErrorMessage(code, msg)`.
 * - Lobby room invite sharing (`LobbyView.room`):
 *   `shareableInviteUrl(origin, state.code)` -> if `{ ok: true, url }`, display/copy `url`;
 *   if `{ ok: false, reason: 'localhost' }`, warn that localhost cannot be shared with other devices.
 *   `copyInviteUrl(url, inputEl)` -> copies via Clipboard API or falls back to focusing/selecting `inputEl`.
 */

function parseHttpOrigin(origin: string): URL | null {
  const trimmed = origin.trim();
  if (!trimmed) return null;
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
  if (parsed.origin === 'null') return null;
  if (parsed.username !== '' || parsed.password !== '') return null;
  return parsed;
}

/**
 * Builds `<origin>/?room=CODE` using the standard URL API.
 * Validates `origin` (`http:` or `https:`, no credentials) and normalizes/validates `code`.
 * Never serializes `token`, `botToken`, or any other secrets.
 */
export function inviteUrl(origin: string, code: string): string {
  const parsedOrigin = parseHttpOrigin(origin);
  if (!parsedOrigin) {
    throw new Error('Invalid invite origin: expected an http or https origin.');
  }
  const normalized = normalizeCode(code);
  if (!isValidCode(normalized)) {
    throw new Error('Invalid room code.');
  }
  const url = new URL(parsedOrigin.origin);
  url.searchParams.set(INVITE_QUERY_PARAM, normalized);
  return url.toString();
}

/**
 * Returns true if `origin` resolves to loopback, localhost, or unspecified address
 * (`localhost`, `*.localhost`, `127.x.x.x`, `0.0.0.0`, `[::1]`, `[::]`), which cannot be
 * reached from another player's device.
 */
export function isLocalhostOrigin(origin: string): boolean {
  const parsed = parseHttpOrigin(origin);
  if (!parsed) return false;
  const host = parsed.hostname.toLowerCase().replace(/\.+$/, '');
  if (host === 'localhost' || host.endsWith('.localhost')) return true;
  if (host === '0.0.0.0' || IPV4_LOOPBACK_RE.test(host)) return true;
  if (LOCALHOST_IPV6_HOSTS.has(host)) return true;
  return false;
}

/**
 * Builds an invite URL suitable for sharing with another device (LAN IP or public HTTPS tunnel).
 * Rejects localhost/loopback origins, invalid origins, and invalid room codes.
 */
export function shareableInviteUrl(origin: string, code: string): ShareableInviteResult {
  const parsed = parseHttpOrigin(origin);
  if (!parsed) {
    return { ok: false, reason: 'invalid-origin' };
  }
  if (isLocalhostOrigin(origin)) {
    return { ok: false, reason: 'localhost' };
  }
  const normalized = normalizeCode(code);
  if (!isValidCode(normalized)) {
    return { ok: false, reason: 'invalid-code' };
  }
  return { ok: true, url: inviteUrl(parsed.origin, normalized) };
}

/**
 * Safely parses an invite URL (full or relative `?room=CODE`) and returns the normalized room code,
 * or `null` if the URL is invalid, uses a non-HTTP(S) scheme, has duplicate `room` query parameters,
 * or has an invalid room code.
 */
export function parseInviteRoom(url: string): string | null {
  if (typeof url !== 'string') return null;
  const trimmed = url.trim();
  if (!trimmed) return null;
  let parsed: URL;
  try {
    parsed = new URL(trimmed, PLACEHOLDER_BASE);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return null;
  }
  const values = parsed.searchParams.getAll(INVITE_QUERY_PARAM);
  const [raw] = values;
  if (values.length !== 1 || raw === undefined) {
    return null;
  }
  const normalized = normalizeCode(raw);
  return isValidCode(normalized) ? normalized : null;
}

/**
 * Copies `url` via `navigator.clipboard.writeText` when available; if unavailable or rejected,
 * falls back to focusing and selecting `fallbackInput` so the user can copy manually.
 */
export async function copyInviteUrl(
  url: string,
  fallbackInput?: CopyFallbackInput,
): Promise<CopyInviteResult> {
  const clipboard = typeof navigator !== 'undefined' ? navigator.clipboard : undefined;
  if (clipboard && typeof clipboard.writeText === 'function') {
    try {
      await clipboard.writeText(url);
      return { copied: true, method: 'clipboard' };
    } catch {
      // Fall through to manual focus/select fallback.
    }
  }
  fallbackInput?.focus?.();
  fallbackInput?.select?.();
  return { copied: false, method: 'manual' };
}

/** Strips ASCII control characters and HTML angle brackets, then trims surrounding whitespace. */
export function sanitizeInviteInput(value: string): string {
  return stripControlAndHtml(value).trim();
}

/**
 * Sanitizes a player name for lobby entry: removes control chars and `<`/`>`,
 * trims surrounding whitespace, and clamps to `MAX_NAME_LENGTH`.
 */
export function sanitizePlayerName(name: string): string {
  return sanitizeInviteInput(name).slice(0, MAX_NAME_LENGTH);
}

/**
 * Creates the initial entry state, prefilling `code` from `url` when valid.
 * Never sets `autoReady` or `autoStart`.
 */
export function createInviteEntryState(url?: string, initialName = ''): InviteEntryState {
  const parsedCode = url !== undefined ? parseInviteRoom(url) : null;
  return {
    code: parsedCode ?? '',
    name: sanitizePlayerName(initialName),
    error: null,
    joining: false,
    fromInvite: parsedCode !== null,
    autoReady: false,
    autoStart: false,
  };
}

/** Updates player name in entry state (clamped to `MAX_NAME_LENGTH`, control/HTML chars stripped) and clears stale error. */
export function setInviteName(state: InviteEntryState, name: string): InviteEntryState {
  const cleaned = stripControlAndHtml(name).slice(0, MAX_NAME_LENGTH);
  return {
    ...state,
    name: cleaned,
    error: null,
    autoReady: false,
    autoStart: false,
  };
}

/** Updates room code in entry state (normalizes spaces/dashes and uppercases, strips control/HTML chars) and clears stale error. */
export function setInviteCode(state: InviteEntryState, code: string): InviteEntryState {
  const cleaned = normalizeCode(stripControlAndHtml(code)).slice(0, CODE_LENGTH * 2);
  return {
    ...state,
    code: cleaned,
    error: null,
    autoReady: false,
    autoStart: false,
  };
}

/** Records or clears an entry error while preserving the user's `code` and `name` inputs for retry. */
export function setInviteError(state: InviteEntryState, error: string | null): InviteEntryState {
  return {
    ...state,
    error: error === null ? null : sanitizeInviteInput(error),
    joining: false,
    autoReady: false,
    autoStart: false,
  };
}

/** Updates pending join state while preserving form inputs. */
export function setInviteJoining(state: InviteEntryState, joining: boolean): InviteEntryState {
  return {
    ...state,
    joining,
    error: joining ? null : state.error,
    autoReady: false,
    autoStart: false,
  };
}

/** Validates entry state before sending `{ t: 'join', code, name }` and returns normalized values when valid. */
export function validateInviteJoin(state: InviteEntryState): InviteJoinValidation {
  if (state.joining) {
    return { ok: false, reason: 'joining', message: 'Join request already in progress.' };
  }
  const name = sanitizePlayerName(state.name);
  if (name.length < 1) {
    return { ok: false, reason: 'empty-name', message: INVITE_ERROR_TEXT['empty-name']! };
  }
  const code = normalizeCode(state.code);
  if (!isValidCode(code)) {
    return { ok: false, reason: 'invalid-code', message: INVITE_ERROR_TEXT['invalid-code']! };
  }
  return { ok: true, code, name };
}

/** Returns true only when entry state has a valid code, a valid non-empty player name, and is not currently joining. */
export function canSubmitInviteJoin(state: InviteEntryState): boolean {
  return validateInviteJoin(state).ok;
}

/** Maps a server/validation error code to a safe user-facing message. */
export function inviteErrorMessage(code: string, fallback = 'Unable to join room.'): string {
  return INVITE_ERROR_TEXT[code] ?? sanitizeInviteInput(fallback);
}
