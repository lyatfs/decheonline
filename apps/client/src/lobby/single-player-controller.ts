import type { GameSettings } from '@aoe/sim';
import { AiBot, type AiBotSpawnOptions } from '../bot/ai-bot';
import type { BotDifficulty, SinglePlayerSetup } from '../bot/types';
import type { LobbyState, Session } from './session';
import { validateSinglePlayerSetup } from './single-player-setup';

export type SinglePlayerLaunchStatus =
  | 'idle'
  | 'creating'
  | 'configuring'
  | 'spawning'
  | 'readying'
  | 'starting'
  | 'playing'
  | 'error';

export interface SinglePlayerControllerState {
  status: SinglePlayerLaunchStatus;
  statusMessage: string;
  error: string | null;
  activeSetup: SinglePlayerSetup | null;
}

export interface SinglePlayerControllerDeps {
  session: Session;
  spawnBot?: (roomCode: string, options: AiBotSpawnOptions) => Promise<AiBot>;
  onStateChange?: (state: SinglePlayerControllerState) => void;
}

function defaultBotName(difficulty: BotDifficulty): string {
  if (difficulty === 'easy') return 'Computer (Easy)';
  if (difficulty === 'medium') return 'Computer (Medium)';
  return 'Computer (Hard)';
}

function sameJson(a: unknown, b: unknown): boolean {
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return a === b;
  const ka = Object.keys(a);
  return (
    ka.length === Object.keys(b).length &&
    ka.every((k) =>
      sameJson((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]),
    )
  );
}

function cloneSettings(s: GameSettings): GameSettings {
  return {
    ...s,
    victory: { ...s.victory },
  };
}

function cloneSetup(setup: SinglePlayerSetup): SinglePlayerSetup {
  return {
    humanCiv: setup.humanCiv,
    botCiv: setup.botCiv,
    difficulty: setup.difficulty,
    settings: cloneSettings(setup.settings),
  };
}

/**
 * Coordinates single-player room creation, server-confirmed settings & civ synchronization,
 * `AiBot` spawning with `botToken`, and safe cancellation / retry without timer hacks.
 */
export class SinglePlayerController {
  private readonly session: Session;
  private readonly spawnBotFn: (roomCode: string, options: AiBotSpawnOptions) => Promise<AiBot>;
  private readonly onStateChange?: (state: SinglePlayerControllerState) => void;

  private generation = 0;
  private bot: AiBot | null = null;
  private botSpawning = false;
  private setup: SinglePlayerSetup | null = null;
  private pendingSettingsSync = false;
  private settingsSent = false;
  private civSent = false;
  private readySent = false;
  private startSent = false;
  private inLocalCall = false;
  private abandonRoomOnLobby = false;

  state: SinglePlayerControllerState = {
    status: 'idle',
    statusMessage: '',
    error: null,
    activeSetup: null,
  };

  constructor(deps: SinglePlayerControllerDeps) {
    this.session = deps.session;
    this.spawnBotFn = deps.spawnBot ?? ((code, options) => AiBot.spawn(code, options));
    this.onStateChange = deps.onStateChange;
  }

  isLaunching(): boolean {
    const s = this.state.status;
    return (
      s === 'creating' ||
      s === 'configuring' ||
      s === 'spawning' ||
      s === 'readying' ||
      s === 'starting'
    );
  }

  start(playerName: string, setup: SinglePlayerSetup): boolean {
    if (this.isLaunching()) return false;

    const validationError = validateSinglePlayerSetup(playerName, setup);
    if (validationError !== null) {
      this.setState({
        status: 'error',
        statusMessage: '',
        error: validationError,
        activeSetup: cloneSetup(setup),
      });
      return false;
    }

    this.cleanupBot();
    this.resetStepFlags();
    this.abandonRoomOnLobby = false;

    const snapshot = cloneSetup(setup);
    this.setup = snapshot;
    const trimmedName = playerName.trim();

    this.setState({
      status: 'creating',
      statusMessage: 'Creating single-player room...',
      error: null,
      activeSetup: snapshot,
    });

    this.callSession(() =>
      this.session.create(trimmedName, {
        mode: 'single-player',
        difficulty: snapshot.difficulty,
      }),
    );

    if (this.session.state.phase === 'lobby') {
      this.onSessionState(this.session.state);
    }
    return true;
  }

  cancel(): void {
    const wasCreating =
      this.state.status === 'creating' && this.session.state.phase !== 'lobby';
    this.cleanupBot();
    this.resetStepFlags();
    this.setup = null;

    if (this.session.state.phase === 'lobby') {
      this.abandonRoomOnLobby = false;
      this.callSession(() => this.session.leave());
    } else if (wasCreating) {
      this.abandonRoomOnLobby = true;
    }

    this.setState({
      status: 'idle',
      statusMessage: '',
      error: null,
      activeSetup: null,
    });
  }

  destroy(): void {
    this.cancel();
  }

  onSessionState(lobby: LobbyState): void {
    if (this.inLocalCall) return;

    if (this.abandonRoomOnLobby && lobby.phase === 'lobby') {
      this.abandonRoomOnLobby = false;
      if (lobby.mode === 'single-player') {
        this.cleanupBot();
        this.callSession(() => this.session.leave());
        return;
      }
    }

    if (this.state.status === 'playing') {
      if (lobby.phase === 'ended' || lobby.phase === 'idle') {
        this.cleanupBot();
        this.resetStepFlags();
        this.setup = null;
        this.setState({
          status: 'idle',
          statusMessage: '',
          error: null,
          activeSetup: null,
        });
      }
      return;
    }

    if (!this.isLaunching()) {
      if (this.abandonRoomOnLobby && lobby.error) {
        this.abandonRoomOnLobby = false;
      }
      if (lobby.phase === 'ended' || lobby.phase === 'idle') {
        this.cleanupBot();
      }
      return;
    }

    if (lobby.error) {
      this.failLaunch(lobby.error.message || 'Failed to launch single-player game.');
      return;
    }

    if (lobby.phase === 'idle' || lobby.phase === 'ended') {
      this.failLaunch('Room closed before the game could start.');
      return;
    }

    if (lobby.phase === 'playing') {
      this.setState({
        status: 'playing',
        statusMessage: '',
        error: null,
        activeSetup: this.setup,
      });
      return;
    }

    // lobby.phase === 'lobby'
    if (lobby.mode !== 'single-player' || lobby.you !== 0 || !lobby.botToken) {
      this.failLaunch('Server did not grant single-player room authority.');
      return;
    }

    const setup = this.setup;
    if (!setup) return;

    if (this.pendingSettingsSync) {
      if (!sameJson(lobby.settings, setup.settings)) return;
      this.pendingSettingsSync = false;
    }

    if (!this.settingsSent) {
      this.settingsSent = true;
      if (!sameJson(lobby.settings, setup.settings)) {
        this.pendingSettingsSync = true;
        this.setState({
          status: 'configuring',
          statusMessage: 'Applying game settings...',
          error: null,
          activeSetup: setup,
        });
        this.callSession(() => this.session.setSettings(setup.settings));
        return;
      }
    }

    if (this.pendingSettingsSync) return;

    const me = lobby.players.find((p) => p.slot === lobby.you);
    if (!me) return;

    if (me.civ !== setup.humanCiv) {
      if (!this.civSent) {
        this.civSent = true;
        this.setState({
          status: 'configuring',
          statusMessage: 'Selecting civilization...',
          error: null,
          activeSetup: setup,
        });
        this.callSession(() => this.session.setCiv(setup.humanCiv));
      }
      return;
    }

    if (!this.bot && !this.botSpawning) {
      this.spawnBot(lobby.code, lobby.botToken, setup);
      return;
    }

    if (!this.bot || this.botSpawning) return;

    if (lobby.players.length < 2) return;
    const botPlayer = lobby.players.find((p) => p.slot !== lobby.you);
    if (!botPlayer) return;

    if (me.civ !== setup.humanCiv || botPlayer.civ !== setup.botCiv) return;

    if (!me.ready) {
      if (!this.readySent) {
        this.readySent = true;
        this.setState({
          status: 'readying',
          statusMessage: 'Preparing match...',
          error: null,
          activeSetup: setup,
        });
        this.callSession(() => this.session.setReady(true));
      }
      return;
    }

    if (!botPlayer.ready) return;
    if (!sameJson(lobby.settings, setup.settings) || this.pendingSettingsSync) return;

    if (!this.startSent) {
      this.startSent = true;
      this.setState({
        status: 'starting',
        statusMessage: 'Starting game...',
        error: null,
        activeSetup: setup,
      });
      this.callSession(() => this.session.start());
    }
  }

  private spawnBot(code: string, botToken: string, setup: SinglePlayerSetup): void {
    const gen = this.generation;
    this.botSpawning = true;
    this.setState({
      status: 'spawning',
      statusMessage: 'Connecting AI opponent...',
      error: null,
      activeSetup: setup,
    });

    void this.spawnBotFn(code, {
      name: defaultBotName(setup.difficulty),
      civ: setup.botCiv,
      difficulty: setup.difficulty,
      botToken,
    })
      .then((bot) => {
        if (
          gen !== this.generation ||
          !this.isLaunching() ||
          this.session.state.phase !== 'lobby' ||
          this.session.state.code !== code
        ) {
          bot.destroy();
          return;
        }
        this.bot = bot;
        this.botSpawning = false;
        if (typeof bot.setOnError === 'function') {
          bot.setOnError((message) => {
            if (gen !== this.generation || !this.isLaunching()) return;
            this.failLaunch(message || 'AI opponent failed to join the room.');
          });
        }
        if (gen !== this.generation || !this.isLaunching()) return;
        this.onSessionState(this.session.state);
      })
      .catch((err: unknown) => {
        if (gen !== this.generation || !this.isLaunching()) return;
        this.botSpawning = false;
        const message =
          err instanceof Error && err.message
            ? err.message
            : 'Failed to connect AI opponent. Please try again.';
        this.failLaunch(message);
      });
  }

  private failLaunch(message: string): void {
    this.cleanupBot();
    this.resetStepFlags();
    this.abandonRoomOnLobby = false;

    if (this.session.state.phase === 'lobby') {
      this.callSession(() => this.session.leave());
    }

    this.setState({
      status: 'error',
      statusMessage: '',
      error: message,
      activeSetup: this.setup,
    });
  }

  private cleanupBot(): void {
    this.generation++;
    this.botSpawning = false;
    if (this.bot) {
      this.bot.destroy();
      this.bot = null;
    }
  }

  private resetStepFlags(): void {
    this.pendingSettingsSync = false;
    this.settingsSent = false;
    this.civSent = false;
    this.readySent = false;
    this.startSent = false;
  }

  private callSession(fn: () => void): void {
    this.inLocalCall = true;
    try {
      fn();
    } finally {
      this.inLocalCall = false;
    }
  }

  private setState(next: SinglePlayerControllerState): void {
    this.state = next;
    this.onStateChange?.(next);
  }
}
