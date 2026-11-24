/**
 * Command vocabulary and scheduling (docs/spec/core.md §2.3-2.4). Every command travels as a JSON object
 * tagged by `type`; this file is the single list of types the sim accepts.
 */

/** Does nothing. Keeps a turn's batch non-empty in tests. */
export interface NoopCommand {
  type: 'noop';
}

/**
 * Determinism probe, not a game rule: spawns an entity of type -1 (no master) owned by the sender at (x, y) with hit points
 * drawn from the RNG, then moves each of the sender's non-unit entities one float32 unit step toward (x, y).
 */
export interface TestCommand {
  type: 'test';
  x: number;
  y: number;
}

/**
 * Move order (`RGE_Command::do_command_move`, docs/spec/movement.md §5.1): the listed units of the sender walk to map
 * point (x, y), in tiles.
 */
export interface MoveCommand {
  type: 'move';
  units: number[];
  x: number;
  y: number;
}

/**
 * Work order (`RGE_Command::do_command_work`, docs/spec/economy.md §3.1): the listed units of the sender work on
 * object `target` (gather, hunt, drop off); (x, y) is the clicked map point.
 */
export interface WorkCommand {
  type: 'work';
  units: number[];
  target: number;
  x: number;
  y: number;
}

/**
 * Build order (`TRIBE_Command::do_command_build`, docs/spec/economy.md §4.1): place a foundation of master `unitType`
 * centred on (x, y), paid by the sender, and send the listed units of the sender to build it.
 */
export interface BuildCommand {
  type: 'build';
  units: number[];
  unitType: number;
  x: number;
  y: number;
}

/**
 * Wall line order (`TRIBE_Command::do_command_build_wall`, docs/spec/economy.md §4.8): segments of wall master
 * `unitType` from tile (x1, y1) to tile (x2, y2), each paid by the sender as it is placed, and the listed units of the
 * sender sent to build the first. Tiles are bytes on the wire (`command_build_wall` clamps them to 0..255).
 */
export interface BuildWallCommand {
  type: 'build-wall';
  units: number[];
  unitType: number;
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

/**
 * Production queue order (`TRIBE_Command::do_command_queue`, economy.md §5.1): `count` > 0 queues that many units of
 * master `unit` at `building`, `count` < 0 removes that many.
 */
export interface QueueCommand {
  type: 'queue';
  building: number;
  unit: number;
  count: number;
}

/**
 * Cancel order (`TRIBE_Command::do_command_cancel_build`, economy.md §4.4): a foundation is cancelled with a partial
 * refund; any other unit or building is destroyed.
 */
export interface CancelCommand {
  type: 'cancel';
  target: number;
}

/**
 * Attack order: the listed units of the sender attack object `target` (the right-click on an enemy; the original sends
 * it as a work order, `do_command_work`, at the target's position).
 */
export interface AttackCommand {
  type: 'attack';
  units: number[];
  target: number;
}

/** Research order (`TRIBE_Command::do_command_research`, techs.md §3.1): building `building` researches tech `tech`. */
export interface ResearchCommand {
  type: 'research';
  building: number;
  tech: number;
}

/**
 * Stop order (`RGE_Command::do_command_stop`, techs.md §3.5, docs/spec/commands.md): the listed objects stop; a
 * building's research and queue are refunded.
 */
export interface StopCommand {
  type: 'stop';
  objects: number[];
}

/**
 * Repair order (`TRIBE_Command::do_command_repair`, support-actions.md §6): the listed units of the sender repair object
 * `target`.
 */
export interface RepairCommand {
  type: 'repair';
  units: number[];
  target: number;
}

/**
 * Stand ground (`RGE_Player::command_stand_ground`, sent as a group AI order, docs/spec/commands.md): the listed units of
 * the sender stop and attack only what they reach from where they stand.
 */
export interface StandGroundCommand {
  type: 'stand-ground';
  units: number[];
}

/**
 * Attack Ground (`TRIBE_Command::command_attack_ground`, docs/spec/commands.md §5): the listed units of the sender fire
 * at map point (x, y), in tiles, until another order replaces it.
 */
export interface AttackGroundCommand {
  type: 'attack-ground';
  units: number[];
  x: number;
  y: number;
}

/**
 * Unload (`TRIBE_Command::do_command_unload`, src/tcommand.cpp:513, naval.md §7.6): each listed transport of the sender
 * gets an immediate UNLOAD order at map point (x, y), in tiles; a transport idle with its Transport action drops at its own
 * position and ignores the point.
 */
export interface UnloadCommand {
  type: 'unload';
  units: number[];
  x: number;
  y: number;
}

/**
 * Trade cargo (`TRIBE_Command::do_command_trade_attribute`, command 0x6D, src/tcommand.cpp:489, support-actions.md §7.6):
 * each listed trade boat of the sender will carry `attribute` (0 food, 1 wood, 2 stone; the trade panel's three buttons,
 * src/scr_game.cpp:2057-2063).
 */
export interface TradeAttributeCommand {
  type: 'trade-attribute';
  units: number[];
  attribute: number;
}

/**
 * Formation (`RGE_Command::do_command_formation`, command 6, src/Command.cpp:492, commands.md §6): the listed units of
 * the sender line up on the one nearest the map origin in formation `formation` (0-5, Shift+F2..F7).
 */
/**
 * A cheat code typed in chat (`TRIBE_GAME_COMMAND_ID_CHEAT`, game command 6, `TRIBE_World::cheat`; chat.md §7): runs
 * only when the game allows cheats.
 */
export interface CheatCommand {
  type: 'cheat';
  /** The code, an unsigned char. */
  code: number;
}

/** STEROIDS (`command_quick_build`, game command 4; chat.md §7.2): sets the game-wide quick build flag. */
export interface QuickBuildCommand {
  type: 'quick-build';
  on: boolean;
}

/** The speeds a player may pick in multiplayer: the + and - keys' ladder and the Game Settings dialog's radio buttons (lobby.md §8). */
export const GAME_SPEEDS = [1, 1.5, 2] as const;

/** Single-player bounded game speed range and UI step. */
export const SINGLE_PLAYER_SPEED_MIN = 0.5;
export const SINGLE_PLAYER_SPEED_MAX = 4.0;
export const SINGLE_PLAYER_SPEED_STEP = 0.25;
export const DEFAULT_GAME_SPEED = 1.0;

/** True when `speed` is one of the multiplayer whitelist speeds (`[1, 1.5, 2]`). */
export function isMultiplayerGameSpeed(speed: unknown): speed is (typeof GAME_SPEEDS)[number] {
  return typeof speed === 'number' && Number.isFinite(speed) && GAME_SPEEDS.includes(speed as (typeof GAME_SPEEDS)[number]);
}

/** True when `speed` is a finite number within the single-player bounds (`[0.5, 4.0]`). */
export function isSinglePlayerGameSpeed(speed: unknown): speed is number {
  return (
    typeof speed === 'number' &&
    Number.isFinite(speed) &&
    speed >= SINGLE_PLAYER_SPEED_MIN &&
    speed <= SINGLE_PLAYER_SPEED_MAX
  );
}

/**
 * Game speed (`TRIBE_Command::command_game_speed`, game command 1, src/tcommand.cpp:773; lobby.md §8): any player sets
 * the world's `game_speed` for everybody (src/tcommand.cpp:377).
 */
export interface GameSpeedCommand {
  type: 'game-speed';
  speed: number;
}

export interface FormationCommand {
  type: 'formation';
  units: number[];
  formation: number;
}

/** Resign (`RGE_Command::do_command_resign`, victory.md §4): the sender loses. */
export interface ResignCommand {
  type: 'resign';
}

/**
 * Stance (`TRIBE_Command::command_relation`, game command 0, docs/spec/diplomacy.md §4): the sender's stance towards
 * `player` becomes `relation` (0 ally, 1 neutral, 3 enemy; `RGE_RELATION_*`).
 */
export interface RelationCommand {
  type: 'relation';
  player: number;
  relation: number;
}

/** Allied victory (`TRIBE_Command::command_allied_victory`, game command 5, diplomacy.md §4): the sender's flag. */
export interface AlliedVictoryCommand {
  type: 'allied-victory';
  on: boolean;
}

/**
 * Tribute (`TRIBE_Command::command_give_attribute`, diplomacy.md §5): the sender gives `amount` of resource `resource`
 * (0 food, 1 wood, 2 stone, 3 gold) to `player`, paying its tribute fee on top.
 */
export interface TributeCommand {
  type: 'tribute';
  player: number;
  resource: number;
  amount: number;
}

/** Most units one move command may list. */
export const MAX_ORDER_UNITS = 255;

export type Command =
  | NoopCommand
  | TestCommand
  | MoveCommand
  | WorkCommand
  | BuildCommand
  | BuildWallCommand
  | QueueCommand
  | CancelCommand
  | AttackCommand
  | ResearchCommand
  | StopCommand
  | ResignCommand
  | RepairCommand
  | StandGroundCommand
  | AttackGroundCommand
  | UnloadCommand
  | TradeAttributeCommand
  | FormationCommand
  | CheatCommand
  | QuickBuildCommand
  | GameSpeedCommand
  | RelationCommand
  | AlliedVictoryCommand
  | TributeCommand;

function isId(v: unknown): v is number {
  return Number.isInteger(v) && (v as number) > 0 && (v as number) <= 0x7fffffff;
}

/** A master object id (`short` on the wire). */
function isMasterId(v: unknown): v is number {
  return Number.isInteger(v) && (v as number) >= 0 && (v as number) <= 0x7fff;
}

/** A player number (`unsigned char` on the wire; the original has at most 8 players and Gaia). */
function isPlayer(v: unknown): v is number {
  return Number.isInteger(v) && (v as number) >= 0 && (v as number) <= 8;
}

/** A tile coordinate of a wall line (`unsigned char` on the wire). */
function isTileByte(v: unknown): v is number {
  return Number.isInteger(v) && (v as number) >= 0 && (v as number) <= 0xff;
}

function isPoint(x: unknown, y: unknown): boolean {
  return typeof x === 'number' && typeof y === 'number' && Number.isFinite(x) && Number.isFinite(y);
}

/** Validate untrusted input (from the wire). Returns a fresh object with only known fields, or null. */
export function parseCommand(v: unknown): Command | null {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  switch (o['type']) {
    case 'noop':
      return { type: 'noop' };
    case 'test': {
      const { x, y } = o;
      if (typeof x !== 'number' || typeof y !== 'number' || !Number.isFinite(x) || !Number.isFinite(y)) return null;
      return { type: 'test', x, y };
    }
    case 'move':
    case 'work': {
      const { units, x, y, target } = o;
      if (typeof x !== 'number' || typeof y !== 'number' || !Number.isFinite(x) || !Number.isFinite(y)) return null;
      if (!Array.isArray(units) || units.length === 0 || units.length > MAX_ORDER_UNITS) return null;
      if (!units.every(isId)) return null;
      if (o['type'] === 'move') return { type: 'move', units: [...(units as number[])], x, y };
      if (!isId(target)) return null;
      return { type: 'work', units: [...(units as number[])], target, x, y };
    }
    case 'build': {
      const { units, unitType, x, y } = o;
      if (!isPoint(x, y) || !isMasterId(unitType)) return null;
      if (!Array.isArray(units) || units.length > MAX_ORDER_UNITS || !units.every(isId)) return null;
      return { type: 'build', units: [...(units as number[])], unitType, x: x as number, y: y as number };
    }
    case 'build-wall': {
      const { units, unitType, x1, y1, x2, y2 } = o;
      if (!isTileByte(x1) || !isTileByte(y1) || !isTileByte(x2) || !isTileByte(y2) || !isMasterId(unitType)) return null;
      if (!Array.isArray(units) || units.length > MAX_ORDER_UNITS || !units.every(isId)) return null;
      return { type: 'build-wall', units: [...(units as number[])], unitType, x1, y1, x2, y2 };
    }
    case 'queue': {
      const { building, unit, count } = o;
      if (!isId(building) || !isMasterId(unit)) return null;
      // `train_count` is a short; 0 would remove nothing.
      if (!Number.isInteger(count) || count === 0 || (count as number) < -0x7fff || (count as number) > 0x7fff) return null;
      return { type: 'queue', building, unit, count: count as number };
    }
    case 'cancel': {
      const { target } = o;
      if (!isId(target)) return null;
      return { type: 'cancel', target };
    }
    case 'attack': {
      const { units, target } = o;
      if (!isId(target)) return null;
      if (!Array.isArray(units) || units.length === 0 || units.length > MAX_ORDER_UNITS || !units.every(isId)) return null;
      return { type: 'attack', units: [...(units as number[])], target };
    }
    case 'research': {
      const { building, tech } = o;
      // `tech_id` is a short.
      if (!isId(building) || !isMasterId(tech)) return null;
      return { type: 'research', building, tech };
    }
    case 'stop': {
      const { objects } = o;
      if (!Array.isArray(objects) || objects.length === 0 || objects.length > MAX_ORDER_UNITS || !objects.every(isId)) return null;
      return { type: 'stop', objects: [...(objects as number[])] };
    }
    case 'resign':
      return { type: 'resign' };
    case 'repair': {
      const { units, target } = o;
      if (!isId(target)) return null;
      if (!Array.isArray(units) || units.length === 0 || units.length > MAX_ORDER_UNITS || !units.every(isId)) return null;
      return { type: 'repair', units: [...(units as number[])], target };
    }
    case 'stand-ground': {
      const { units } = o;
      if (!Array.isArray(units) || units.length === 0 || units.length > MAX_ORDER_UNITS || !units.every(isId)) return null;
      return { type: 'stand-ground', units: [...(units as number[])] };
    }
    case 'attack-ground': {
      const { units, x, y } = o;
      // The unit count is a byte on the wire (src/tcommand.cpp:869).
      if (!isPoint(x, y)) return null;
      if (!Array.isArray(units) || units.length === 0 || units.length > MAX_ORDER_UNITS || !units.every(isId)) return null;
      return { type: 'attack-ground', units: [...(units as number[])], x: x as number, y: y as number };
    }
    case 'unload': {
      const { units, x, y } = o;
      if (!isPoint(x, y)) return null;
      if (!Array.isArray(units) || units.length === 0 || units.length > MAX_ORDER_UNITS || !units.every(isId)) return null;
      return { type: 'unload', units: [...(units as number[])], x: x as number, y: y as number };
    }
    case 'trade-attribute': {
      const { units, attribute } = o;
      // The unit count is a byte on the wire (src/tcommand.cpp:916).
      if (attribute !== 0 && attribute !== 1 && attribute !== 2) return null;
      if (!Array.isArray(units) || units.length === 0 || units.length > MAX_ORDER_UNITS || !units.every(isId)) return null;
      return { type: 'trade-attribute', units: [...(units as number[])], attribute };
    }
    case 'formation': {
      const { units, formation } = o;
      // `RGE_Player::command_formation` sends only formations 0-5 (src/player.cpp:1869).
      if (!Number.isInteger(formation) || (formation as number) < 0 || (formation as number) > 5) return null;
      if (!Array.isArray(units) || units.length === 0 || units.length > MAX_ORDER_UNITS || !units.every(isId)) return null;
      return { type: 'formation', units: [...(units as number[])], formation: formation as number };
    }
    case 'cheat': {
      // `command_cheat` sends the code as an unsigned char.
      const { code } = o;
      if (!Number.isInteger(code) || (code as number) < 0 || (code as number) > 255) return null;
      return { type: 'cheat', code: code as number };
    }
    case 'quick-build':
      if (typeof o.on !== 'boolean') return null;
      return { type: 'quick-build', on: o.on };
    case 'game-speed': {
      // Multiplayer enforces GAME_SPEEDS ([1, 1.5, 2]) on the server; wire parsing accepts bounded finite [0.5, 4.0] for single-player.
      const { speed } = o;
      if (!isSinglePlayerGameSpeed(speed)) return null;
      return { type: 'game-speed', speed };
    }
    case 'relation': {
      const { player, relation } = o;
      // The Diplomacy dialog sends only ally, neutral or enemy (src/dlg_dip.cpp:443-450).
      if (!isPlayer(player) || (relation !== 0 && relation !== 1 && relation !== 3)) return null;
      return { type: 'relation', player, relation };
    }
    case 'allied-victory': {
      const { on } = o;
      if (typeof on !== 'boolean') return null;
      return { type: 'allied-victory', on };
    }
    case 'tribute': {
      const { player, resource, amount } = o;
      // `TRIBE_Player::command_give_attribute` sends nothing for 0 (src/tplayer.cpp:977-982); a negative one gives nothing.
      if (!isPlayer(player) || !Number.isInteger(resource) || (resource as number) < 0 || (resource as number) > 3) return null;
      if (typeof amount !== 'number' || !Number.isFinite(amount) || amount <= 0) return null;
      return { type: 'tribute', player, resource: resource as number, amount };
    }
    default:
      return null;
  }
}

export interface QueuedCommand {
  /** Turn the command executes on (issue turn + 2, src/com_hand.cpp:2810). */
  turn: number;
  /** Sender player number. */
  player: number;
  /** 1-based position among the sender's commands for this turn (src/com_q.cpp:335). */
  seq: number;
  command: Command;
}

/**
 * Commands waiting for their turn. `take(turn)` hands them out ordered by sender player, then sequence
 * (the original's `Code = sequence + player * 1000`, src/com_q.cpp:228) and drops any for a passed turn
 * (src/com_q.cpp:304-306).
 */
export class CommandQueue {
  private items: QueuedCommand[] = [];

  get size(): number {
    return this.items.length;
  }

  /** Queue one sender's commands for `turn`, in the order the sender issued them. */
  push(turn: number, player: number, commands: readonly Command[]): void {
    let seq = 0;
    for (const item of this.items) if (item.turn === turn && item.player === player) seq = Math.max(seq, item.seq);
    for (const command of commands) this.items.push({ turn, player, seq: ++seq, command });
  }

  take(turn: number): QueuedCommand[] {
    const due: QueuedCommand[] = [];
    const later: QueuedCommand[] = [];
    for (const item of this.items) {
      if (item.turn === turn) due.push(item);
      else if (item.turn > turn) later.push(item);
    }
    this.items = later;
    return due.sort((a, b) => a.player - b.player || a.seq - b.seq);
  }

  toJSON(): QueuedCommand[] {
    return this.items.map((item) => ({ ...item, command: copyCommand(item.command) }));
  }

  static fromJSON(items: QueuedCommand[]): CommandQueue {
    const queue = new CommandQueue();
    queue.items = items.map((item) => ({ ...item, command: copyCommand(item.command) }));
    return queue;
  }
}

function copyCommand(c: Command): Command {
  return 'units' in c ? { ...c, units: [...c.units] } : { ...c };
}
