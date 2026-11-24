import { describe, expect, test } from 'vitest';
import {
  BOT_DIFFICULTIES,
  CODE_ALPHABET,
  DEFAULT_BOT_DIFFICULTY,
  DEFAULT_GAME_SPEED,
  DEFAULT_ROOM_MODE,
  GAME_SPEEDS,
  ROOM_MODES,
  SERVER_TAGS,
  SINGLE_PLAYER_SPEED_MAX,
  SINGLE_PLAYER_SPEED_MIN,
  SINGLE_PLAYER_SPEED_STEP,
  decodeClientMessage,
  decodeServerMessage,
  encode,
  isBotDifficulty,
  isMultiplayerGameSpeed,
  isRoomMode,
  isSinglePlayerGameSpeed,
  isValidCode,
  normalizeCode,
  packageName,
  parseBotDifficulty,
  parseLobbySettings,
  type ClientMessage,
  type ServerMessage,
} from './index';

test('exports its package name', () => {
  expect(packageName).toBe('@aoe/protocol');
});

describe('invite codes', () => {
  test('alphabet has no lookalike characters', () => {
    for (const ch of '01OIL') expect(CODE_ALPHABET).not.toContain(ch);
  });
  test('normalize uppercases and strips separators', () => {
    expect(normalizeCode(' ab-c d2 ')).toBe('ABCD2');
  });
  test('validity checks length and alphabet', () => {
    expect(isValidCode('ABCD2')).toBe(true);
    expect(isValidCode('ABCD')).toBe(false);
    expect(isValidCode('ABCD0')).toBe(false);
  });
});

describe('client message decoding', () => {
  /** The start settings at their defaults (Random Map, Default age and resources, both check boxes off). */
  const START = { deathMatch: false, startingAge: 0, resources: 0, revealMap: false, fullTechTree: false, pathFinding: 0, fixedPositions: true, cheating: false };
  const roundTrips: ClientMessage[] = [
    { t: 'create', name: 'Eric' },
    { t: 'create', name: 'Eric', mode: 'multiplayer' },
    { t: 'create', name: 'Eric', mode: 'single-player' },
    { t: 'create', name: 'Eric', mode: 'single-player', difficulty: 'easy' },
    { t: 'create', name: 'Eric', mode: 'single-player', difficulty: 'medium' },
    { t: 'create', name: 'Eric', mode: 'single-player', difficulty: 'hard' },
    { t: 'join', code: 'ABCD2', name: 'Bao' },
    { t: 'join', code: 'ABCD2', name: 'Computer', botToken: 'secret-token-123' },
    { t: 'ready', ready: true },
    { t: 'settings', settings: { ...START, mapType: 7, mapSize: 96, victory: { type: 0 }, populationLimit: 50 } },
    { t: 'settings', settings: { ...START, mapType: 3, mapSize: 250, victory: { type: 2, amount: 9000 }, populationLimit: 200 } },
    { t: 'settings', settings: { ...START, mapType: 4, mapSize: 72, victory: { type: 3, amount: 300 }, populationLimit: 25 } },
    { t: 'settings', settings: { deathMatch: true, mapType: 7, mapSize: 120, victory: { type: 0 }, startingAge: 1, resources: 0, revealMap: true, fullTechTree: true, populationLimit: 75, pathFinding: 2, fixedPositions: false, cheating: true } },
    { t: 'settings', settings: { ...START, mapType: 3, mapSize: 144, victory: { type: 0 }, startingAge: 5, resources: 3, populationLimit: 50 } },
    { t: 'civ', civ: 1 },
    { t: 'civ', civ: 17 },
    { t: 'start' },
    { t: 'turn', turn: 3, commands: [{ type: 'test', x: 10.5, y: 12 }, { type: 'noop' }] },
    { t: 'turn', turn: 4, commands: [{ type: 'game-speed', speed: 0.5 }, { type: 'game-speed', speed: 2.75 }, { type: 'game-speed', speed: 4 }] },
    { t: 'turn', turn: 9, commands: [], frameMs: 17 },
    { t: 'hash', turn: 3, hash: 0xdeadbeef },
    { t: 'pong', n: 4 },
    { t: 'rejoin', code: 'ABCD2', slot: 1, token: 'f00d', received: 12 },
    { t: 'chat', text: 'hi: there', to: [0, 1] },
    { t: 'chat', text: 'x'.repeat(255), to: [] },
    { t: 'pause', paused: true },
    { t: 'pause', paused: false },
    { t: 'pause', paused: true, epoch: 0 },
    { t: 'pause', paused: false, epoch: 4 },
    { t: 'leave' },
  ];
  test.each(roundTrips)('round-trips $t', (m) => {
    expect(decodeClientMessage(encode(m))).toEqual({ ok: true, message: m });
  });

  test.each([
    ['not json', '{'],
    ['no tag', '{}'],
    ['unknown tag', '{"t":"nope"}'],
    ['array', '[]'],
    ['name too long', JSON.stringify({ t: 'create', name: 'x'.repeat(25) })],
    ['negative turn', JSON.stringify({ t: 'turn', turn: -1, commands: [] })],
    ['fractional turn', JSON.stringify({ t: 'turn', turn: 1.5, commands: [] })],
    ['command without type', JSON.stringify({ t: 'turn', turn: 0, commands: [{ x: 1 }] })],
    ['unknown command type', JSON.stringify({ t: 'turn', turn: 0, commands: [{ type: 'move', unit: 2 }] })],
    ['bad command field', JSON.stringify({ t: 'turn', turn: 0, commands: [{ type: 'test', x: '1', y: 2 }] })],
    ['too many commands', JSON.stringify({ t: 'turn', turn: 0, commands: Array(257).fill({ type: 'noop' }) })],
    ['hash out of range', JSON.stringify({ t: 'hash', turn: 0, hash: 2 ** 32 })],
    ['frame time out of range', JSON.stringify({ t: 'turn', turn: 0, commands: [], frameMs: 256 })],
    ['pong without number', JSON.stringify({ t: 'pong' })],
    ['map type not offered', JSON.stringify({ t: 'settings', settings: { ...START, mapType: 9, mapSize: 144, victory: { type: 0 }, populationLimit: 50 } })],
    ['map size not offered', JSON.stringify({ t: 'settings', settings: { ...START, mapType: 3, mapSize: 100, victory: { type: 0 }, populationLimit: 50 } })],
    ['special victory', JSON.stringify({ t: 'settings', settings: { ...START, mapType: 3, mapSize: 144, victory: { type: 4 }, populationLimit: 50 } })],
    ['time limit not offered', JSON.stringify({ t: 'settings', settings: { ...START, mapType: 3, mapSize: 144, victory: { type: 2, amount: 100 }, populationLimit: 50 } })],
    ['time limit without years', JSON.stringify({ t: 'settings', settings: { ...START, mapType: 3, mapSize: 144, victory: { type: 2 }, populationLimit: 50 } })],
    ['standard with an amount', JSON.stringify({ t: 'settings', settings: { ...START, mapType: 3, mapSize: 144, victory: { type: 0, amount: 900 }, populationLimit: 50 } })],
    ['settings without victory', JSON.stringify({ t: 'settings', settings: { ...START, mapType: 3, mapSize: 144, populationLimit: 50 } })],
    ['population limit not offered', JSON.stringify({ t: 'settings', settings: { ...START, mapType: 3, mapSize: 144, victory: { type: 0 }, populationLimit: 60 } })],
    ['starting age not offered', JSON.stringify({ t: 'settings', settings: { ...START, mapType: 3, mapSize: 144, victory: { type: 0 }, startingAge: 6, populationLimit: 50 } })],
    ['resources Low (not on the dialog)', JSON.stringify({ t: 'settings', settings: { ...START, mapType: 3, mapSize: 144, victory: { type: 0 }, resources: 1, populationLimit: 50 } })],
    ['Death Match with High resources', JSON.stringify({ t: 'settings', settings: { ...START, deathMatch: true, mapType: 3, mapSize: 144, victory: { type: 0 }, resources: 3, populationLimit: 50 } })],
    ['reveal map not a boolean', JSON.stringify({ t: 'settings', settings: { ...START, mapType: 3, mapSize: 144, victory: { type: 0 }, revealMap: 1, populationLimit: 50 } })],
    ['settings without full tech tree', JSON.stringify({ t: 'settings', settings: { deathMatch: false, mapType: 3, mapSize: 144, victory: { type: 0 }, startingAge: 0, resources: 0, revealMap: false, populationLimit: 50 } })],
    ['path finding not offered', JSON.stringify({ t: 'settings', settings: { ...START, mapType: 3, mapSize: 144, victory: { type: 0 }, populationLimit: 50, pathFinding: 3 } })],
    ['fixed positions not a boolean', JSON.stringify({ t: 'settings', settings: { ...START, mapType: 3, mapSize: 144, victory: { type: 0 }, populationLimit: 50, fixedPositions: 0 } })],
    ['settings without cheating', JSON.stringify({ t: 'settings', settings: { ...START, mapType: 3, mapSize: 144, victory: { type: 0 }, populationLimit: 50, cheating: undefined } })],
    ['settings without population limit', JSON.stringify({ t: 'settings', settings: { ...START, mapType: 3, mapSize: 144, victory: { type: 0 } } })],
    ['civ 0 (Gaia)', JSON.stringify({ t: 'civ', civ: 0 })],
    ['civ past Random', JSON.stringify({ t: 'civ', civ: 18 })],
    ['rejoin without token', JSON.stringify({ t: 'rejoin', code: 'ABCD2', slot: 0, received: 0 })],
    ['empty chat', JSON.stringify({ t: 'chat', text: '', to: [1] })],
    ['chat past 255 characters', JSON.stringify({ t: 'chat', text: 'x'.repeat(256), to: [1] })],
    ['chat to slot 4', JSON.stringify({ t: 'chat', text: 'hi', to: [4] })],
    ['chat without recipients', JSON.stringify({ t: 'chat', text: 'hi' })],
    ['rejoin with negative received', JSON.stringify({ t: 'rejoin', code: 'ABCD2', slot: 0, token: 'a', received: -1 })],
    ['create with invalid mode', JSON.stringify({ t: 'create', name: 'Eric', mode: 'solo' })],
    ['create with non-string mode', JSON.stringify({ t: 'create', name: 'Eric', mode: 1 })],
    ['create with invalid difficulty', JSON.stringify({ t: 'create', name: 'Eric', mode: 'single-player', difficulty: 'impossible' })],
    ['create with invalid difficulty in multiplayer', JSON.stringify({ t: 'create', name: 'Eric', mode: 'multiplayer', difficulty: 'godlike' })],
    ['create with prototype difficulty', JSON.stringify({ t: 'create', name: 'Eric', mode: 'single-player', difficulty: '__proto__' })],
    ['join with non-string botToken', JSON.stringify({ t: 'join', code: 'ABCD2', name: 'Bot', botToken: 123 })],
    ['join with overly long botToken', JSON.stringify({ t: 'join', code: 'ABCD2', name: 'Bot', botToken: 'x'.repeat(65) })],
    ['pause without boolean', JSON.stringify({ t: 'pause', paused: 'yes' })],
    ['pause missing paused', JSON.stringify({ t: 'pause' })],
    ['pause with negative epoch', JSON.stringify({ t: 'pause', paused: true, epoch: -1 })],
    ['pause with fractional epoch', JSON.stringify({ t: 'pause', paused: true, epoch: 1.5 })],
    ['pause with string epoch', JSON.stringify({ t: 'pause', paused: true, epoch: '1' })],
    ['game-speed zero', JSON.stringify({ t: 'turn', turn: 0, commands: [{ type: 'game-speed', speed: 0 }] })],
    ['game-speed negative', JSON.stringify({ t: 'turn', turn: 0, commands: [{ type: 'game-speed', speed: -1 }] })],
    ['game-speed below min', JSON.stringify({ t: 'turn', turn: 0, commands: [{ type: 'game-speed', speed: 0.25 }] })],
    ['game-speed above max', JSON.stringify({ t: 'turn', turn: 0, commands: [{ type: 'game-speed', speed: 4.25 }] })],
    ['game-speed null (NaN/Infinity JSON)', JSON.stringify({ t: 'turn', turn: 0, commands: [{ type: 'game-speed', speed: null }] })],
    ['game-speed string', JSON.stringify({ t: 'turn', turn: 0, commands: [{ type: 'game-speed', speed: '1.5' }] })],
  ])('rejects %s', (_label, raw) => {
    expect(decodeClientMessage(raw).ok).toBe(false);
  });

  test('trims names', () => {
    expect(decodeClientMessage('{"t":"create","name":"  Eric "}')).toEqual({
      ok: true,
      message: { t: 'create', name: 'Eric' },
    });
  });

  test('ignores difficulty when create mode is multiplayer or omitted', () => {
    expect(decodeClientMessage(JSON.stringify({ t: 'create', name: 'Eric', difficulty: 'hard' }))).toEqual({
      ok: true,
      message: { t: 'create', name: 'Eric' },
    });
    expect(decodeClientMessage(JSON.stringify({ t: 'create', name: 'Eric', mode: 'multiplayer', difficulty: 'hard' }))).toEqual({
      ok: true,
      message: { t: 'create', name: 'Eric', mode: 'multiplayer' },
    });
  });
});

describe('room mode and difficulty helpers', () => {
  test('exports mode and difficulty constants and guards', () => {
    expect(ROOM_MODES).toEqual(['multiplayer', 'single-player']);
    expect(DEFAULT_ROOM_MODE).toBe('multiplayer');
    expect(BOT_DIFFICULTIES).toEqual(['easy', 'medium', 'hard']);
    expect(DEFAULT_BOT_DIFFICULTY).toBe('medium');

    expect(isRoomMode('multiplayer')).toBe(true);
    expect(isRoomMode('single-player')).toBe(true);
    expect(isRoomMode('coop')).toBe(false);
    expect(isRoomMode('__proto__')).toBe(false);

    expect(isBotDifficulty('easy')).toBe(true);
    expect(isBotDifficulty('medium')).toBe(true);
    expect(isBotDifficulty('hard')).toBe(true);
    expect(isBotDifficulty('brutal')).toBe(false);
    expect(parseBotDifficulty('hard')).toBe('hard');
    expect(parseBotDifficulty('nope')).toBeNull();
    expect(parseLobbySettings({})).toBeNull();
  });

  test('exports game speed bounds and guards', () => {
    expect(GAME_SPEEDS).toEqual([1, 1.5, 2]);
    expect([SINGLE_PLAYER_SPEED_MIN, SINGLE_PLAYER_SPEED_MAX, SINGLE_PLAYER_SPEED_STEP, DEFAULT_GAME_SPEED]).toEqual([0.5, 4, 0.25, 1]);
    expect(isMultiplayerGameSpeed(1.5)).toBe(true);
    expect(isMultiplayerGameSpeed(0.5)).toBe(false);
    expect(isMultiplayerGameSpeed(4)).toBe(false);
    expect(isSinglePlayerGameSpeed(0.5)).toBe(true);
    expect(isSinglePlayerGameSpeed(4)).toBe(true);
    expect(isSinglePlayerGameSpeed(0)).toBe(false);
    expect(isSinglePlayerGameSpeed(-1)).toBe(false);
    expect(isSinglePlayerGameSpeed(Number.NaN)).toBe(false);
    expect(isSinglePlayerGameSpeed(Number.POSITIVE_INFINITY)).toBe(false);
  });
});

test('server message decoding checks the tag and SERVER_TAGS is complete', () => {
  const allServerTags: ServerMessage['t'][] = [
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
  ];
  for (const tag of allServerTags) {
    expect(SERVER_TAGS.has(tag)).toBe(true);
  }
  expect(decodeServerMessage('{"t":"ended","reason":"peer-left"}').ok).toBe(true);
  expect(decodeServerMessage('{"t":"rejoined","nextTurn":3}').ok).toBe(true);
  expect(decodeServerMessage('{"t":"rejoined","nextTurn":3,"mode":"single-player","difficulty":"hard"}').ok).toBe(true);
  expect(decodeServerMessage('{"t":"rejoined","nextTurn":3,"mode":"single-player","paused":true,"pauseBoundary":5,"pauseEpoch":2}').ok).toBe(true);
  expect(decodeServerMessage('{"t":"paused","paused":true,"boundary":2,"epoch":1}').ok).toBe(true);
  expect(decodeServerMessage('{"t":"dropped","slot":1}').ok).toBe(true);
  expect(decodeServerMessage('{"t":"chat","from":0,"text":"hi"}').ok).toBe(true);
  expect(decodeServerMessage('{"t":"create"}').ok).toBe(false);
});
