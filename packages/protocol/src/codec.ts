import { isLobbyCiv, isLobbySettings, parseCommand } from '@aoe/sim';
import {
  isBotDifficulty,
  isCompatibilityVersions,
  isRoomCapacity,
  isRoomMode,
  MAX_CHAT_LENGTH,
  MAX_COMMANDS_PER_BATCH,
  MAX_NAME_LENGTH,
  MAX_PLAYERS,
  type ClientMessage,
  type CompatibilityVersions,
  type Command,
  type GameSettings,
  type ServerMessage,
} from './messages';

export type Decoded<T> = { ok: true; message: T } | { ok: false; error: string };

type Obj = Record<string, unknown>;

const fail = (error: string): { ok: false; error: string } => ({ ok: false, error });

function isObj(v: unknown): v is Obj {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function isTurn(v: unknown): v is number {
  return typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;
}

function isSlot(v: unknown): v is number {
  return isTurn(v) && v < MAX_PLAYERS;
}

function isHash(v: unknown): v is number {
  return typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= 0xffffffff;
}

/** Return only the handshake's public identifiers. */
function parseVersions(v: unknown): CompatibilityVersions | null {
  if (!isCompatibilityVersions(v)) return null;
  const { protocol, rules, build, assets } = v;
  return { protocol, rules, build, assets };
}

function cleanName(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const name = v.trim();
  return name.length <= MAX_NAME_LENGTH ? name : null;
}

/** Every command must be in the sim's vocabulary; unknown fields are dropped. */
function commands(v: unknown): Command[] | null {
  if (!Array.isArray(v) || v.length > MAX_COMMANDS_PER_BATCH) return null;
  const out: Command[] = [];
  for (const c of v) {
    const command = parseCommand(c);
    if (command === null) return null;
    out.push(command);
  }
  return out;
}

/** A setting the lobby offers (`isLobbySettings`); unknown fields are dropped. */
export function parseLobbySettings(v: unknown): GameSettings | null {
  if (!isObj(v) || !isObj(v['victory'])) return null;
  const { deathMatch, mapType, mapSize, startingAge, resources, revealMap, fullTechTree, populationLimit, pathFinding, fixedPositions, cheating } = v;
  const { type, amount } = v['victory'];
  if (typeof mapType !== 'number' || typeof mapSize !== 'number' || typeof type !== 'number' || typeof populationLimit !== 'number') return null;
  if (typeof startingAge !== 'number' || typeof resources !== 'number' || typeof pathFinding !== 'number') return null;
  if (typeof deathMatch !== 'boolean' || typeof revealMap !== 'boolean' || typeof fullTechTree !== 'boolean') return null;
  if (typeof fixedPositions !== 'boolean' || typeof cheating !== 'boolean') return null;
  if (amount !== undefined && typeof amount !== 'number') return null;
  const victory = amount === undefined ? { type } : { type, amount };
  const s: GameSettings = { deathMatch, mapType, mapSize, victory, startingAge, resources, revealMap, fullTechTree, populationLimit, pathFinding, fixedPositions, cheating };
  return isLobbySettings(s) ? s : null;
}

export function encode(message: ClientMessage | ServerMessage): string {
  return JSON.stringify(message);
}

/** Parse and validate a frame from a client. Never throws. */
export function decodeClientMessage(raw: string): Decoded<ClientMessage> {
  let v: unknown;
  try {
    v = JSON.parse(raw);
  } catch {
    return fail('not JSON');
  }
  if (!isObj(v) || typeof v['t'] !== 'string') return fail('missing message tag');
  switch (v['t']) {
    case 'create': {
      const name = cleanName(v['name']);
      if (name === null) return fail('bad name');
      const modeRaw = v['mode'];
      if (modeRaw !== undefined && !isRoomMode(modeRaw)) return fail('bad room mode');
      const capacity = v['capacity'];
      if (capacity !== undefined && (!isRoomCapacity(capacity) || (modeRaw === 'single-player' && capacity !== 2))) return fail('bad room capacity');
      const versions = v['versions'] === undefined ? undefined : parseVersions(v['versions']);
      if (versions === null) return fail('bad versions');
      const diffRaw = v['difficulty'];
      if (diffRaw !== undefined && !isBotDifficulty(diffRaw)) return fail('bad difficulty');
      return {
        ok: true,
        message: {
          t: 'create',
          name,
          ...(modeRaw !== undefined ? { mode: modeRaw } : {}),
          ...(capacity !== undefined ? { capacity } : {}),
          ...(versions !== undefined ? { versions } : {}),
          ...(modeRaw === 'single-player' && diffRaw !== undefined ? { difficulty: diffRaw } : {}),
        },
      };
    }
    case 'join': {
      const name = cleanName(v['name']);
      if (name === null) return fail('bad name');
      if (typeof v['code'] !== 'string' || v['code'].length > 32) return fail('bad code');
      const versions = v['versions'] === undefined ? undefined : parseVersions(v['versions']);
      if (versions === null) return fail('bad versions');
      const botToken = v['botToken'];
      if (botToken !== undefined && (typeof botToken !== 'string' || botToken.length > 64)) return fail('bad bot token');
      return {
        ok: true,
        message: {
          t: 'join',
          code: v['code'],
          name,
          ...(botToken !== undefined ? { botToken } : {}),
          ...(versions !== undefined ? { versions } : {}),
        },
      };
    }
    case 'ready': {
      if (typeof v['ready'] !== 'boolean') return fail('bad ready flag');
      const versions = v['versions'] === undefined ? undefined : parseVersions(v['versions']);
      if (versions === null) return fail('bad versions');
      return { ok: true, message: { t: 'ready', ready: v['ready'], ...(versions !== undefined ? { versions } : {}) } };
    }
    case 'settings': {
      const s = parseLobbySettings(v['settings']);
      if (s === null) return fail('bad settings');
      return { ok: true, message: { t: 'settings', settings: s } };
    }
    case 'civ': {
      const civ = v['civ'];
      if (typeof civ !== 'number' || !isLobbyCiv(civ)) return fail('bad civ');
      return { ok: true, message: { t: 'civ', civ } };
    }
    case 'start':
      return { ok: true, message: { t: 'start' } };
    case 'leave':
      return { ok: true, message: { t: 'leave' } };
    case 'rejoin': {
      const { code, slot, token, received } = v;
      if (typeof code !== 'string' || code.length > 32 || typeof token !== 'string' || token.length > 64) return fail('bad rejoin');
      if (!isSlot(slot) || !isTurn(received)) return fail('bad rejoin');
      return { ok: true, message: { t: 'rejoin', code, slot, token, received } };
    }
    case 'turn': {
      const cmds = commands(v['commands']);
      const frameMs = v['frameMs'];
      if (!isTurn(v['turn']) || cmds === null) return fail('bad turn batch');
      if (frameMs === undefined) return { ok: true, message: { t: 'turn', turn: v['turn'], commands: cmds } };
      if (!isTurn(frameMs) || frameMs > 255) return fail('bad frame time');
      return { ok: true, message: { t: 'turn', turn: v['turn'], commands: cmds, frameMs } };
    }
    case 'chat': {
      const { text, to } = v;
      if (typeof text !== 'string' || text.length === 0 || text.length > MAX_CHAT_LENGTH) return fail('bad chat text');
      if (!Array.isArray(to) || to.length > MAX_PLAYERS || !to.every(isSlot)) return fail('bad chat recipients');
      return { ok: true, message: { t: 'chat', text, to: to as number[] } };
    }
    case 'pong':
      if (!isTurn(v['n'])) return fail('bad pong');
      return { ok: true, message: { t: 'pong', n: v['n'] } };
    case 'hash': {
      const h = v['hash'];
      if (!isTurn(v['turn']) || !isHash(h)) {
        return fail('bad hash report');
      }
      return { ok: true, message: { t: 'hash', turn: v['turn'], hash: h } };
    }
    case 'result': {
      const { turn, hash, winners } = v;
      if (!isTurn(turn) || !isHash(hash) || !Array.isArray(winners) || winners.length > MAX_PLAYERS ||
          !winners.every((p) => isTurn(p) && p >= 1 && p <= MAX_PLAYERS) || new Set(winners).size !== winners.length) {
        return fail('bad result report');
      }
      return { ok: true, message: { t: 'result', turn, hash, winners: winners as number[] } };
    }
    case 'pause': {
      if (typeof v['paused'] !== 'boolean') return fail('bad pause flag');
      const epoch = v['epoch'];
      if (epoch !== undefined && !isTurn(epoch)) return fail('bad pause epoch');
      return {
        ok: true,
        message: epoch !== undefined ? { t: 'pause', paused: v['paused'], epoch } : { t: 'pause', paused: v['paused'] },
      };
    }
    default:
      return fail('unknown message tag');
  }
}

export const SERVER_TAGS: ReadonlySet<string> = new Set<ServerMessage['t']>([
  'lobby',
  'start',
  'rejoined',
  'dropped',
  'turn',
  'paused',
  'ping',
  'rtt',
  'desync',
  'chat',
  'ended',
  'error',
]);

/** Parse a frame from the server. Checks the tag only; the server is trusted to send well-formed bodies. */
export function decodeServerMessage(raw: string): Decoded<ServerMessage> {
  let v: unknown;
  try {
    v = JSON.parse(raw);
  } catch {
    return fail('not JSON');
  }
  if (!isObj(v) || typeof v['t'] !== 'string' || !SERVER_TAGS.has(v['t'])) return fail('unknown message tag');
  return { ok: true, message: v as unknown as ServerMessage };
}
