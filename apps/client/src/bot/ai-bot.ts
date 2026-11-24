import { type Command, type World } from '@aoe/sim';
import type { ServerMessage } from '@aoe/protocol';
import { Lockstep } from '../lockstep';
import { connect, type Link } from '../net/link';
import { createArbiterState, resetArbiterState, runProposeCommitCycle } from './budget';
import { getBotProfile, resolveBotDifficulty, shouldThinkAtTime } from './difficulty';
import { createEconomyPlanner } from './economy';
import { createBotObservation, createEmptyBotMemory } from './observation';
import { createProgressionPlanner } from './progression';
import { createResearchPlanner } from './research-planner';
import { createSquadPlanner } from './squads';
import type { BotDifficulty, BotPlannerState } from './types';

function createPlannerState(): BotPlannerState {
  return {
    lastThinkTime: -1,
    squads: [],
    nextSquadSeq: 1,
    depletedResourceIds: [],
    failedTargets: {},
    unitCooldownUntil: {},
    buildingCooldownUntil: {},
    memory: createEmptyBotMemory(),
  };
}

export interface AiBotSpawnOptions {
  name?: string;
  civ?: number;
  difficulty?: BotDifficulty;
  botToken?: string;
  speed?: number;
  testMap?: boolean;
  onError?: (message: string) => void;
}

export type AiBotOptions = AiBotSpawnOptions & { player?: number };

function defaultBotName(difficulty: BotDifficulty): string {
  if (difficulty === 'easy') return 'Computer (Easy)';
  if (difficulty === 'medium') return 'Computer (Medium)';
  return 'Computer (Hard)';
}

export class AiBot {
  readonly difficulty: BotDifficulty;
  private readonly roomCode: string;
  private readonly name: string;
  private readonly preferredCiv: number;
  private readonly botToken?: string;
  private readonly speed: number;
  private readonly testMap: boolean;
  private player: number;
  private link: Link | null = null;
  private lockstep: Lockstep | null = null;
  private active = true;
  private isReady = false;
  private onErrorCallback?: (message: string) => void;
  private preStartError: string | null = null;
  private plannerState = createPlannerState();
  private readonly arbiterState = createArbiterState();
  private readonly planners = [
    createProgressionPlanner(),
    createEconomyPlanner(),
    createResearchPlanner(),
    createSquadPlanner(),
  ];

  constructor(
    roomCode = '',
    nameOrOptions: string | AiBotOptions = 'Computer (Hard)',
    preferredCiv = 2, // Greek by default
    player = 2, // Slot 1 is player 2
  ) {
    this.roomCode = roomCode;
    if (typeof nameOrOptions === 'object' && nameOrOptions !== null) {
      this.difficulty = resolveBotDifficulty(nameOrOptions.difficulty);
      this.name = nameOrOptions.name ?? defaultBotName(this.difficulty);
      this.preferredCiv = nameOrOptions.civ ?? 2;
      this.player = nameOrOptions.player ?? 2;
      this.botToken = nameOrOptions.botToken;
      this.speed = nameOrOptions.speed ?? 1;
      this.testMap = nameOrOptions.testMap ?? false;
      this.onErrorCallback = nameOrOptions.onError;
    } else {
      this.difficulty = resolveBotDifficulty(undefined);
      this.name = nameOrOptions;
      this.preferredCiv = preferredCiv;
      this.player = player;
      this.botToken = undefined;
      this.speed = 1;
      this.testMap = false;
    }
  }

  /** Register a pre-start error listener (flushes any error already received before registration). */
  setOnError(fn: (message: string) => void): void {
    this.onErrorCallback = fn;
    if (this.preStartError !== null) {
      const msg = this.preStartError;
      this.preStartError = null;
      fn(msg);
    }
  }

  /** Create and connect a new bot to a room code. */
  static async spawn(
    roomCode: string,
    nameOrOptions: string | AiBotSpawnOptions = 'Computer (Hard)',
    civ = 2,
  ): Promise<AiBot> {
    const bot =
      typeof nameOrOptions === 'object' && nameOrOptions !== null
        ? new AiBot(roomCode, nameOrOptions)
        : new AiBot(roomCode, nameOrOptions, civ);
    await bot.connect();
    return bot;
  }

  async connect(): Promise<void> {
    const link = await connect();
    if (!this.active) {
      link.close();
      return;
    }
    this.link = link;

    this.link.onMessage((m: ServerMessage) => {
      if (!this.active) return;

      if (m.t === 'lobby') {
        this.player = m.you + 1;
        if (!this.isReady) {
          this.isReady = true;
          this.link?.send({ t: 'civ', civ: this.preferredCiv });
          this.link?.send({ t: 'ready', ready: true });
        }
      } else if (m.t === 'start') {
        this.onGameStart(m);
      } else if (m.t === 'error' && !this.lockstep) {
        const message = m.message || 'AI opponent failed to join the room.';
        this.destroy();
        this.notifyPreStartError(message);
      }
    });

    this.link.onClose(() => {
      const premature = this.active && !this.lockstep;
      this.destroy();
      if (premature) {
        this.notifyPreStartError('AI opponent disconnected before the game could start.');
      }
    });

    this.link.send({
      t: 'join',
      code: this.roomCode,
      name: this.name,
      ...(this.botToken !== undefined ? { botToken: this.botToken } : {}),
    });
  }

  private notifyPreStartError(message: string): void {
    if (this.onErrorCallback) {
      this.onErrorCallback(message);
    } else {
      this.preStartError = message;
    }
  }

  private onGameStart(start: Extract<ServerMessage, { t: 'start' }>): void {
    if (!this.link || this.lockstep || !this.active) return;

    this.lockstep = new Lockstep({
      link: this.link,
      speed: this.speed,
      start: {
        seed: start.seed,
        mode: start.mode,
        slot: this.player - 1,
        testMap: this.testMap,
        commandDelay: start.commandDelay,
        playerCount: start.players.length,
        settings: start.settings,
        civs: start.players.map((p) => p.civ),
        rejoin: { code: this.roomCode, slot: this.player - 1, token: start.token },
      },
    });

    this.lockstep.onTurn = () => {
      if (!this.active || !this.lockstep || this.lockstep.isPaused()) return;
      const worldTime = this.lockstep.world.worldTime;
      if (shouldThinkAtTime(this.plannerState.lastThinkTime, worldTime, getBotProfile(this.difficulty))) {
        this.plannerState.lastThinkTime = worldTime;
        this.think();
      }
    };
  }

  private think(): void {
    if (!this.lockstep) return;
    const commands = this.step(this.lockstep.world);
    for (const cmd of commands) {
      this.issue(cmd);
    }
  }

  /**
   * Evaluate `world` for this bot's player and return commands to issue.
   * Exposed publicly so unit/integration tests can drive `AiBot` against a real `@aoe/sim` `World`.
   */
  step(world: World): Command[] {
    if (!this.active || world.gameResult() !== null) return [];
    const { observation, memory } = createBotObservation(world, this.player, this.plannerState.memory);
    this.plannerState.memory = memory;
    return runProposeCommitCycle(
      this.planners,
      observation,
      getBotProfile(this.difficulty),
      this.arbiterState,
      this.plannerState,
      this.player,
    ).commands;
  }

  private issue(command: Command): void {
    if (this.lockstep && this.active) {
      this.lockstep.issue(command);
    }
  }

  destroy(): void {
    this.active = false;
    resetArbiterState(this.arbiterState);
    this.plannerState = createPlannerState();
    const lockstep = this.lockstep;
    this.lockstep = null;
    if (lockstep) {
      lockstep.stop();
    }
    const link = this.link;
    this.link = null;
    if (link) {
      link.close();
    }
  }
}
