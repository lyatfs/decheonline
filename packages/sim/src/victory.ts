/**
 * Victory, defeat and score (docs/spec/victory.md): each player's game status and victory-point list, the per-second
 * elimination check, resign, the time-limit countdown and the end-of-game resolution. Plain data, so the world hashes
 * and snapshots it as it is. No RNG anywhere (victory.md §3).
 *
 * The all-relics and all-ruins holds (victory.md §10) count the relics and ruins a random map placed (`artifactCount`,
 * `ruinCount`). The Wonder's countdown is its action's (`wonder.ts`, victory.md §8). Not ported, for want of the
 * objects (victory.md §2): the scenario/MP conditions of §7 other than "victory points". The allied-victory paths read the stances and flags of
 * docs/spec/diplomacy.md (`DiplomacyState`); without one every player is every other's enemy.
 */
import { relation, RELATION_ALLY, type DiplomacyState } from './diplomacy';
import type { Entity } from './entities';
import { ObjectState } from './entities';
import { div32, f32, mul32, sub32, toInt } from './num';

/** `TRIBE_World::victory_type` (victory.md §2). */
export const VICTORY_STANDARD = 0;
export const VICTORY_CONQUEST = 1;
export const VICTORY_TIME_LIMIT = 2;
export const VICTORY_SCORE = 3;
/**
 * `victory_type` 4: the lobby's ruins, artifacts, discoveries, exploration and gold settings, whose conditions are not
 * ported (victory.md §2, §7). Conquest is off and no condition is set, so the game never ends; players are still
 * eliminated. The sim's tests of other rules use it for worlds where one side has nothing.
 */
export const VICTORY_SPECIAL = 4;

/** `RGE_Player::game_status`. */
export const STATUS_PLAYING = 0;
export const STATUS_WON = 1;
export const STATUS_LOST = 2;

/** `game_end_condition` (victory.md §5): what ended the game, for the end screen. */
export const END_CONQUEST = 1;
export const END_CONDITIONS = 2;
export const END_WONDER = 100;
export const END_ALL_RELICS = 101;
export const END_ALL_RUINS = 102;
export const END_TIME_LIMIT = 103;

/** The lobby's victory setting: type, and the years (time limit) or points (score) it needs. */
export interface VictorySettings {
  type: number;
  amount?: number;
}

/** Victory-point entry commands (`handle_point_condition`). */
const POINTS_AMOUNT = 0;
const POINTS_FIRST = 1;
const POINTS_HIGHEST = 2;
const POINTS_HIGH_ONCE = 3;
const POINTS_HIGH_AMOUNT = 4;

/** Entry and condition states: 0 pending, 1 impossible, 2 met, 3 invalid. */
const ENTRY_IMPOSSIBLE = 1;
const ENTRY_MET = 2;
const ENTRY_INVALID = 3;

/** Condition command "victory points" (`handle_victory_points`), the only condition a random-map game adds. */
const CONDITION_VICTORY_POINTS = 12;

/** `RGE_Victory_Point_Entry`. */
export interface ScoreEntry {
  id: number;
  group: number;
  command: number;
  attribute: number;
  /** `amount`: the threshold `n`; the all-time-leader entry overwrites it with the others' maximum. */
  amount: number;
  points: number;
  state: number;
  /** `curr_attribute_amount` (float32): the attribute last read, or the all-time own maximum. */
  current: number;
  currPoints: number;
}

/** `RGE_Victory_Entry` for the conditions this port has. */
export interface ConditionEntry {
  command: number;
  group: number;
  ally: boolean;
  state: number;
  count: number;
}

export interface VictoryState {
  type: number;
  /** `game_state`: 0 playing, 1 over. */
  gameState: number;
  endCondition: number;
  /** `game_status` per player, Gaia's included. */
  status: number[];
  resigned: boolean[];
  countdownVictory: boolean;
  /** `countdown_clock` (float32), in years. */
  countdownClock: number;
  /** Per player, the point list in evaluation order (newest entry first, victory.md §4). */
  scores: ScoreEntry[][];
  /** Per player, `tot_victory_points`. */
  totals: number[];
  /** Per player, the condition list in evaluation order. */
  conditions: ConditionEntry[][];
  /** Per player, `RGE_Victory_Conditions::victory`: 0 undecided, 1 failed, 2 achieved. */
  verdicts: number[];
  /** `TRIBE_World::artifact_count` / `ruin_count`: the relics and ruins a random map placed (5 or 0, victory.md §3). */
  artifactCount: number;
  ruinCount: number;
  /**
   * Per player, `TRIBE_Player::artifact_held_time` / `ruin_held_time` (float32, victory.md §10): -1 while the player's
   * team does not hold them all, else the countdown from 2000 (the timer panel shows it, `src/tpnl_tim.cpp:341-350`).
   */
  artifactHeld: number[];
  ruinHeld: number[];
  /**
   * Per player, `RGE_Base_Game::countdown_timer` (victory.md §8): -1, or the years its completed Wonders still need,
   * the lowest of them, which the Wonder clock shows. Only a Standard game sets it.
   */
  wonderCountdown: number[];
}

/** `[group, id, command, attribute, n, points]` in `TRIBE_World::new_game`'s order (victory.md §11.2). */
const SCORE_TABLE: readonly (readonly [number, number, number, number, number, number])[] = [
  [0, 0, POINTS_AMOUNT, 20, 2, 1],
  [0, 1, POINTS_AMOUNT, 43, 1, 1],
  [0, 2, POINTS_AMOUNT, 44, 1, 1],
  [0, 3, POINTS_HIGH_ONCE, 40, 1, 25],
  [1, 4, POINTS_AMOUNT, 49, 100, 1],
  [1, 9, POINTS_AMOUNT, 53, 60, 1],
  [1, 5, POINTS_HIGH_AMOUNT, 37, 1, 1],
  [1, 6, POINTS_HIGH_ONCE, 37, 1, 25],
  [1, 7, POINTS_AMOUNT, 22, 3, 1],
  [1, 8, POINTS_HIGHEST, 22, 1, 25],
  [2, 10, POINTS_AMOUNT, 41, 1, 2],
  [2, 11, POINTS_HIGHEST, 41, 1, 25],
  [2, 12, POINTS_AMOUNT, 14, 1, 10],
  [2, 13, POINTS_AMOUNT, 7, 1, 10],
  [2, 14, POINTS_AMOUNT, 52, 1, 3],
  [2, 16, POINTS_AMOUNT, 55, 1, 50],
  [2, 15, POINTS_AMOUNT, 54, 1, 50],
  [3, 17, POINTS_AMOUNT, 21, 1, 2],
  [3, 18, POINTS_HIGHEST, 21, 1, 50],
  [3, 19, POINTS_FIRST, 6, 3, 25],
  [3, 20, POINTS_FIRST, 6, 4, 25],
  [4, 22, POINTS_AMOUNT, 45, 1, 100],
  [4, 23, POINTS_AMOUNT, 42, 1, 100],
];

/** Score ids the achievements screen shows apart from the four groups (`src/scr_ach.cpp:445-466`). */
const SCORE_SURVIVAL = 22;
const SCORE_WONDER = 23;

/** `PLAYER_ATTRIBUTE_ARTIFACTS` / `RUINS` (relics and ruins held, from their storages) and the all-held flags. */
export const ATTR_ARTIFACTS = 7;
export const ATTR_RUINS = 14;
export const ATTR_ALL_RUINS = 54;
export const ATTR_ALL_ARTIFACTS = 55;
/** The all-relics / all-ruins countdown's start (`src/tworld.cpp:1012`, `:1053`). */
const HOLD_TIME = 2000;

const ATTR_KILLS = 20;
const ATTR_TOTAL_UNITS = 19;
const ATTR_POPULATION = 11;
const ATTR_PERCENT_EXPLORED = 22;
const ATTR_CIVILIANS = 37;
const ATTR_MILITARY = 40;
const ATTR_KILLS_MINUS_LOSSES = 44;
const ATTR_SURVIVAL = 45;

/** Object groups that do not keep a player alive (`src/tplayer.cpp:380-396`). */
const NOT_ALIVE_GROUPS: ReadonlySet<number> = new Set([11, 30, 27, 1, 21, 20, 2, 37]);

const GROUP_TRADE_BOAT = 2;
const GROUP_CIVILIAN = 4;
const GROUP_PRIEST = 18;
const GROUP_FISHING_BOAT = 21;
/** `TRIBE_MASTER_TYPE_COMBAT`: units. */
const MASTER_TYPE_UNIT = 70;
/** Watch, Sentry and Guard Tower: buildings counted as military. */
const MILITARY_TOWERS = [79, 199, 69];

/**
 * `TRIBE_World::new_game` for a random-map game (victory.md §2, §11): every player but Gaia gets the score table (with
 * `percentExplored`'s "highest" entry, id 8, only without Reveal Map, src/tworld.cpp:885-887); a Score game adds the
 * "average team points ≥ amount" condition, a time-limit game starts the countdown.
 */
export function newVictory(players: number, settings: VictorySettings = { type: VICTORY_STANDARD }, revealMap = false): VictoryState {
  const amount = settings.amount ?? 0;
  const v: VictoryState = {
    type: settings.type,
    gameState: 0,
    endCondition: 0,
    status: new Array<number>(players).fill(STATUS_PLAYING),
    resigned: new Array<boolean>(players).fill(false),
    countdownVictory: settings.type === VICTORY_TIME_LIMIT,
    countdownClock: settings.type === VICTORY_TIME_LIMIT ? f32(amount) : 0,
    scores: Array.from({ length: players }, () => []),
    totals: new Array<number>(players).fill(0),
    conditions: Array.from({ length: players }, () => []),
    verdicts: new Array<number>(players).fill(0),
    artifactCount: 0,
    ruinCount: 0,
    artifactHeld: new Array<number>(players).fill(-1),
    ruinHeld: new Array<number>(players).fill(-1),
    wonderCountdown: new Array<number>(players).fill(-1),
  };
  for (let p = 1; p < players; p++) {
    if (settings.type === VICTORY_SCORE) v.conditions[p]!.unshift({ command: CONDITION_VICTORY_POINTS, group: 0, ally: true, state: 0, count: amount });
    // `add_point` prepends.
    for (const [group, id, command, attribute, n, points] of SCORE_TABLE) {
      if (revealMap && id === 8) continue;
      v.scores[p]!.unshift({ id, group, command, attribute, amount: n, points, state: 0, current: 0, currPoints: 0 });
    }
  }
  return v;
}

/** Deep copy for snapshots. */
export function copyVictory(v: VictoryState): VictoryState {
  return {
    ...v,
    status: [...v.status],
    resigned: [...v.resigned],
    scores: v.scores.map((list) => list.map((e) => ({ ...e }))),
    totals: [...v.totals],
    conditions: v.conditions.map((list) => list.map((e) => ({ ...e }))),
    verdicts: [...v.verdicts],
    artifactHeld: [...v.artifactHeld],
    ruinHeld: [...v.ruinHeld],
    wonderCountdown: [...v.wonderCountdown],
  };
}

function allied(d: DiplomacyState | undefined, p: number, q: number): boolean {
  return relation({ diplomacy: d }, p, q) === RELATION_ALLY;
}

function alliedVictory(d: DiplomacyState | undefined, p: number): boolean {
  return d?.alliedVictory[p] ?? false;
}

/**
 * The other players 1 and up mutually allied with `player`, both with allied victory, in index order: its allied-victory
 * team (`win_game_now`, `handle_victory_points`, the time limit's team score; diplomacy.md §6).
 */
function teammates(v: VictoryState, d: DiplomacyState | undefined, player: number): number[] {
  if (!alliedVictory(d, player)) return [];
  const team: number[] = [];
  for (let j = 1; j < v.status.length; j++) {
    if (j !== player && allied(d, player, j) && allied(d, j, player) && alliedVictory(d, j)) team.push(j);
  }
  return team;
}

/** `RGE_Player::set_game_status`: a resigned player can only lose. */
function setGameStatus(v: VictoryState, player: number, status: number): void {
  if (status === v.status[player]) return;
  if (v.resigned[player] && status !== STATUS_LOST) return;
  v.status[player] = status;
}

function victoryIfGameOn(v: VictoryState, player: number): void {
  if (v.status[player] === STATUS_PLAYING) setGameStatus(v, player, STATUS_WON);
}

export function lossIfGameOn(v: VictoryState, player: number): void {
  if (v.status[player] === STATUS_PLAYING) setGameStatus(v, player, STATUS_LOST);
}

/** `RGE_Player::win_game_now` (`src/player.cpp:1037-1052`): the player and its allied-victory team win, everyone else loses. */
export function winGameNow(v: VictoryState, player: number, d?: DiplomacyState): void {
  if (v.status[player] === STATUS_LOST) return;
  victoryIfGameOn(v, player);
  const team = teammates(v, d, player);
  for (let i = 1; i < v.status.length; i++) {
    if (i === player) continue;
    if (team.includes(i)) victoryIfGameOn(v, i);
    else lossIfGameOn(v, i);
  }
}

/** `RGE_Player::do_resign` (the resign command, `src/Command.cpp:660-683`). */
export function resign(v: VictoryState, player: number): void {
  v.resigned[player] = true;
  setGameStatus(v, player, STATUS_LOST);
}

/** What the per-second block reads of a player (`TRIBE_Player::update`). */
export interface PlayerView {
  attributes: number[];
  /** `numberTilesExploredValue` and `numberTotalTilesValue`. */
  exploredTiles: number;
  totalTiles: number;
  /** The player's object list. */
  objects: readonly Entity[];
  /** Object group of an object's master. */
  groupOf(e: Entity): number;
}

/**
 * The victory part of `TRIBE_Player::update`'s once-a-second block (`src/tplayer.cpp:364-396`, victory.md §4, §6): %
 * explored (attribute 22), kills − losses (44), then the elimination check: a player with no ACTIVE object outside the
 * groups that do not count is defeated and loses its survival attribute (45). Players but Gaia.
 */
export function perSecond(v: VictoryState, player: number, view: PlayerView): void {
  const a = view.attributes;
  a[ATTR_PERCENT_EXPLORED] = mul32(div32(view.exploredTiles, view.totalTiles), 100);
  a[ATTR_KILLS_MINUS_LOSSES] = sub32(a[ATTR_KILLS]!, sub32(a[ATTR_TOTAL_UNITS]!, a[ATTR_POPULATION]!));
  if (a[ATTR_KILLS_MINUS_LOSSES]! < 0) a[ATTR_KILLS_MINUS_LOSSES] = 0;
  const alive = view.objects.some((e) => e.state === ObjectState.Active && !NOT_ALIVE_GROUPS.has(view.groupOf(e)));
  if (!alive) {
    setGameStatus(v, player, STATUS_LOST);
    a[ATTR_SURVIVAL] = 0;
  }
}

/**
 * `TRIBE_Combat_Object::setup` (+1) and its destructor (−1) (`src/t_c_obj.cpp:57-87`): civilians, fishing and trade
 * boats count in attribute 37, other non-priest units and the three towers in attribute 40. For units and buildings.
 */
export function countPopulation(attributes: number[], t: { id: number; masterType: number; group: number }, sign: 1 | -1): void {
  if (t.masterType !== MASTER_TYPE_UNIT && t.masterType !== 80) return;
  const attr =
    t.group === GROUP_CIVILIAN || t.group === GROUP_FISHING_BOAT || t.group === GROUP_TRADE_BOAT
      ? ATTR_CIVILIANS
      : (t.group !== GROUP_PRIEST && t.masterType === MASTER_TYPE_UNIT) || MILITARY_TOWERS.includes(t.id)
        ? ATTR_MILITARY
        : -1;
  if (attr >= 0) attributes[attr] = sub32(attributes[attr] ?? 0, f32(-sign));
}

/**
 * `RGE_Victory_Conditions::update` for `player` after its objects (victory.md §4): the point entries, then the
 * conditions, then `check_for_victory`; a failed verdict loses the game (`RGE_Player::update`, `src/player.cpp:880`).
 */
export function updateConditions(v: VictoryState, player: number, attributes: readonly (readonly number[])[], d?: DiplomacyState): void {
  for (const e of v.scores[player]!) if (e.state !== ENTRY_IMPOSSIBLE && e.state !== ENTRY_INVALID) handlePoints(v, player, e, attributes);
  for (const c of v.conditions[player]!) {
    if (c.state === ENTRY_IMPOSSIBLE || c.state === ENTRY_INVALID) continue;
    if (c.command === CONDITION_VICTORY_POINTS) handleVictoryPoints(v, player, c, d);
  }
  checkForVictory(v, player);
  if (v.verdicts[player] === 1) setGameStatus(v, player, STATUS_LOST);
}

function setPoints(v: VictoryState, player: number, e: ScoreEntry, points: number): void {
  if (points === e.currPoints) return;
  v.totals[player] = v.totals[player]! + points - e.currPoints;
  e.currPoints = points;
}

/** The point handlers (`src/victory.cpp:1206-1339`, victory.md §11.1). */
function handlePoints(v: VictoryState, player: number, e: ScoreEntry, attributes: readonly (readonly number[])[]): void {
  if (e.state !== 0) return;
  const own = attributes[player]![e.attribute]!;
  const value = toInt(own);
  switch (e.command) {
    case POINTS_AMOUNT: {
      e.current = f32(value);
      const k = Math.trunc(value / e.amount);
      return setPoints(v, player, e, e.points * Math.max(k, 0));
    }
    case POINTS_FIRST: {
      e.current = f32(value);
      if (value < e.amount) return;
      for (let i = 0; i < attributes.length; i++) {
        if (i === player) continue;
        if (!(f32(e.amount) > attributes[i]![e.attribute]!)) {
          e.state = ENTRY_IMPOSSIBLE;
          return;
        }
      }
      setPoints(v, player, e, e.points);
      e.state = ENTRY_MET;
      return;
    }
    case POINTS_HIGHEST: {
      const current = f32(value);
      e.current = current;
      let points = e.points;
      if (value < e.amount) points = 0;
      else {
        for (let i = 1; i < attributes.length; i++) {
          if (i === player) continue;
          const other = attributes[i]![e.attribute]!;
          if (other > current) {
            points = 0;
            break;
          }
          if (other === current) points = e.currPoints;
        }
      }
      return setPoints(v, player, e, points);
    }
    case POINTS_HIGH_ONCE: {
      if (e.current < f32(value)) e.current = f32(value);
      for (let i = 1; i < attributes.length; i++) {
        if (i !== player && f32(e.amount) <= attributes[i]![e.attribute]!) e.amount = toInt(attributes[i]![e.attribute]!);
      }
      return setPoints(v, player, e, e.current >= f32(e.amount) ? e.points : value === e.amount ? e.currPoints : 0);
    }
    case POINTS_HIGH_AMOUNT: {
      if (e.current < f32(value)) e.current = f32(value);
      return setPoints(v, player, e, toInt(div32(e.current, e.amount)) * e.points);
    }
  }
}

/** `handle_victory_points` (`src/victory.cpp:761-790`): the team's average total (C division) reaches the count. */
function handleVictoryPoints(v: VictoryState, player: number, c: ConditionEntry, d: DiplomacyState | undefined): void {
  let total = v.totals[player]!;
  let members = 1;
  if (c.ally) {
    for (const j of teammates(v, d, player)) {
      total += v.totals[j]!;
      members++;
    }
  }
  if (Math.trunc(total / members) >= c.count) c.state = ENTRY_MET;
}

/**
 * `check_for_victory` (`src/victory.cpp:250`, D, victory.md §7): groups in list order of their first entry; a group with
 * an impossible entry fails; one whose entries are all met or invalid (at least one met) achieves. The invalid-entry
 * count is not reset between groups, as in the original.
 */
function checkForVictory(v: VictoryState, player: number): void {
  const list = v.conditions[player]!;
  if (list.length === 0) return;
  v.verdicts[player] = 0;
  const checked = new Array<boolean>(list.length).fill(false);
  let invalid = 0;
  let groups = 0;
  let failed = 0;
  for (;;) {
    const first = checked.indexOf(false);
    if (first === -1) break;
    const group = list[first]!.group;
    groups++;
    let total = 0;
    let met = 0;
    let impossible = false;
    for (let i = first; i < list.length; i++) {
      const c = list[i]!;
      if (c.group !== group) continue;
      total++;
      checked[i] = true;
      if (c.state === ENTRY_IMPOSSIBLE) impossible = true;
      else if (c.state === ENTRY_MET) met++;
      else if (c.state === ENTRY_INVALID) invalid++;
    }
    if (impossible) {
      failed++;
      continue;
    }
    if (met > 0 && total === invalid + met) {
      v.verdicts[player] = 2;
      break;
    }
  }
  if (groups === failed) v.verdicts[player] = 1;
}

/**
 * `TRIBE_World::check_game_state` then `RGE_Game_World::check_game_state` (victory.md §5, §9, §10), after every player's
 * update. `deltaSeconds` is `world_time_delta_seconds`; `attributes` every player's attributes.
 */
export function checkGameState(v: VictoryState, deltaSeconds: number, attributes: number[][], d?: DiplomacyState): void {
  if (v.gameState === 0 && v.type === VICTORY_TIME_LIMIT && v.countdownVictory && v.countdownClock >= 1) {
    v.countdownClock = sub32(v.countdownClock, mul32(deltaSeconds, 2));
    if (v.countdownClock < 1) {
      // Team scores (C division), then the strictly highest from player 1 up: ties go to the lower index.
      let best = -1;
      let winner = -1;
      for (let i = 1; i < v.status.length; i++) {
        if (v.status[i] === STATUS_LOST) continue;
        const team = teammates(v, d, i);
        const score = Math.trunc(team.reduce((sum, j) => sum + v.totals[j]!, v.totals[i]!) / (team.length + 1));
        if (score > best) {
          best = score;
          winner = i;
        }
      }
      if (winner > 0) {
        winGameNow(v, winner, d);
        v.endCondition = END_TIME_LIMIT;
      }
    }
  }
  if (v.gameState === 0 && (v.artifactCount > 0 || v.ruinCount > 0)) {
    // Teams from player 1 up: each player not yet in one starts one with its allied-victory team members not yet in
    // one (src/tworld.cpp:966-994).
    const teams: number[][] = [];
    const placed = new Set<number>();
    for (let i = 1; i < v.status.length; i++) {
      if (placed.has(i) || v.status[i] === STATUS_LOST) continue;
      const team = [i, ...teammates(v, d, i).filter((j) => !placed.has(j) && v.status[j] !== STATUS_LOST)];
      for (const j of team) placed.add(j);
      teams.push(team);
    }
    if (v.artifactCount > 0) for (const team of teams) hold(v, team, deltaSeconds, attributes, v.artifactCount, ATTR_ARTIFACTS, ATTR_ALL_ARTIFACTS, v.artifactHeld, END_ALL_RELICS, d);
    if (v.ruinCount > 0) for (const team of teams) hold(v, team, deltaSeconds, attributes, v.ruinCount, ATTR_RUINS, ATTR_ALL_RUINS, v.ruinHeld, END_ALL_RUINS, d);
  }
  // `RGE_Game_World::check_game_state`: `check_victory` for each player, then count statuses.
  let playing = 0;
  let won = 0;
  let lost = 0;
  let candidate = 0;
  let candidateState = 0;
  for (let i = 1; i < v.status.length; i++) {
    checkVictory(v, d, i);
    const status = v.status[i];
    if (status === STATUS_PLAYING) {
      playing++;
      if (candidate <= 0 || candidateState === 0) {
        candidate = i;
        candidateState = 1;
        // The candidate's own allied-victory flag is not read (src/world.cpp:1392-1394).
      } else if (!alliedVictory(d, i) || !allied(d, candidate, i) || !allied(d, i, candidate)) candidateState = -1;
    } else if (status === STATUS_WON) won++;
    else if (status === STATUS_LOST) lost++;
  }
  if (won > 0) {
    v.gameState = 1;
    for (let i = 1; i < v.status.length; i++) lossIfGameOn(v, i);
  } else if (conquest(v) && ((lost > 0 && candidateState > 0) || playing === 0)) {
    v.gameState = 1;
    for (let i = 1; i < v.status.length; i++) victoryIfGameOn(v, i);
    v.endCondition = END_CONQUEST;
  }
}

/**
 * `RGE_Player::check_victory` (`src/player.cpp:1090-1118`, diplomacy.md §6): a player not lost whose conditions are
 * achieved wins, unless it has allied victory and either the group check fails for it or one of the players it calls
 * allies, or one of those allies has not lost and has not achieved its own conditions.
 */
function checkVictory(v: VictoryState, d: DiplomacyState | undefined, player: number): void {
  if (v.status[player] === STATUS_LOST || v.verdicts[player] !== 2) return;
  if (alliedVictory(d, player)) {
    const n = v.status.length;
    const count = { value: -1 };
    for (let i = 1; i < n; i++) if ((i === player || allied(d, player, i)) && !checkAllyGroup(v, d, i, count)) return;
    // `check_victory_conditions`: a lost player counts as achieved.
    for (let i = 1; i < n; i++) if (allied(d, player, i) && v.status[i] !== STATUS_LOST && v.verdicts[i] !== 2) return;
  }
  setGameStatus(v, player, STATUS_WON);
  v.endCondition = END_CONDITIONS;
}

/**
 * `RGE_Player::check_ally_group` (`src/player.cpp:1060-1088`, D): for a player not lost, every player it calls an ally
 * must call it one back and have allied victory; the count is of the players walked (all of them unless one fails), and
 * must equal the previous member's. A lost player keeps the count and passes unless a previous count differs.
 */
function checkAllyGroup(v: VictoryState, d: DiplomacyState | undefined, player: number, count: { value: number }): boolean {
  const last = count.value;
  let ok = true;
  if (v.status[player] !== STATUS_LOST) {
    count.value = 0;
    for (let i = 1; i < v.status.length; i++) {
      if (allied(d, player, i) && (!allied(d, i, player) || !alliedVictory(d, i))) {
        ok = false;
        break;
      }
      count.value++;
    }
  }
  if (last >= 0 && count.value !== last) ok = false;
  return ok;
}

/**
 * One team's all-relics or all-ruins hold (`src/tworld.cpp:996-1075`, victory.md §10): when the members' held count
 * (each truncated to int) is exactly `count`, the first step sets the all-held attribute and, in a Standard game, starts
 * the countdown at 2000; each later step takes `dt * 2` off it until below 1, when the first member wins. Holding fewer
 * (or more) after the countdown started clears the attribute and the countdown. The original's captured/lost
 * notifications (`GAME_NOTIFY_ARTIFACTS_CAPTURED` ...) are the client's to derive from `held`.
 */
function hold(
  v: VictoryState,
  team: readonly number[],
  deltaSeconds: number,
  attributes: number[][],
  count: number,
  attr: number,
  allAttr: number,
  held: number[],
  endCondition: number,
  d: DiplomacyState | undefined,
): void {
  let total = 0;
  for (const p of team) total += toInt(attributes[p]![attr] ?? 0);
  const first = team[0]!;
  if (total === count) {
    const time = held[first]!;
    if (time === -1) {
      for (const p of team) attributes[p]![allAttr] = f32(1);
      if (v.type === VICTORY_STANDARD) for (const p of team) held[p] = f32(HOLD_TIME);
    } else if (time >= 1 && v.type === VICTORY_STANDARD) {
      const next = sub32(time, mul32(deltaSeconds, 2));
      for (const p of team) held[p] = next;
      if (next < 1) {
        winGameNow(v, first, d);
        v.endCondition = endCondition;
      }
    }
  } else if (held[first] !== -1) {
    for (const p of team) attributes[p]![allAttr] = f32(0);
    if (v.type === VICTORY_STANDARD) for (const p of team) held[p] = -1;
  }
}

/** `Get_conquest_victory`: on for every setting this port has (victory.md §2). */
function conquest(v: VictoryState): boolean {
  return v.type <= VICTORY_SCORE;
}

/** A player's score as the achievements screen groups it (victory.md §11). */
export interface Score {
  total: number;
  military: number;
  economy: number;
  religion: number;
  technology: number;
  /** Points of the survival entry (100 until eliminated). */
  survival: number;
  /** Points of the standing-wonders entry. */
  wonder: number;
}

/** `get_victory_points`, `get_victory_points_group` and `get_victory_points_id` for `player`. */
export function scoreOf(v: VictoryState, player: number): Score {
  const list = v.scores[player] ?? [];
  const group = (g: number) => list.reduce((sum, e) => sum + (e.group === g ? e.currPoints : 0), 0);
  const id = (i: number) => list.find((e) => e.id === i)?.currPoints ?? 0;
  return {
    total: v.totals[player] ?? 0,
    military: group(0),
    economy: group(1),
    religion: group(2),
    technology: group(3),
    survival: id(SCORE_SURVIVAL),
    wonder: id(SCORE_WONDER),
  };
}
