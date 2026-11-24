import { DEFAULT_ROOM_MODE, type RoomMode } from '@aoe/protocol';

export interface PauseState {
  readonly paused: boolean;
  readonly desiredPaused: boolean;
  readonly boundary: number;
  readonly epoch: number;
  readonly pending: boolean;
}

export interface PauseControlOptions {
  mode?: RoomMode;
  isHost?: boolean;
  send?: (message: { t: 'pause'; paused: boolean; epoch: number }) => void;
  isGameOver?: () => boolean;
  onChange?: (state: PauseState) => void;
}

/** Client-side synchronized pause state machine with epoch monotonicity and pending toggle deduplication. */
export class PauseControl {
  paused = false;
  desiredPaused = false;
  boundary = 0;
  epoch = 0;
  pending = false;

  readonly mode: RoomMode;
  readonly isHost: boolean;
  private readonly send?: (message: { t: 'pause'; paused: boolean; epoch: number }) => void;
  private readonly isGameOver: () => boolean;
  private readonly onChange?: (state: PauseState) => void;

  constructor(options: PauseControlOptions = {}) {
    this.mode = options.mode ?? DEFAULT_ROOM_MODE;
    this.isHost = options.isHost ?? true;
    this.send = options.send;
    this.isGameOver = options.isGameOver ?? (() => false);
    this.onChange = options.onChange;
  }

  get state(): PauseState {
    return {
      paused: this.paused,
      desiredPaused: this.desiredPaused,
      boundary: this.boundary,
      epoch: this.epoch,
      pending: this.pending,
    };
  }

  canToggle(mode: RoomMode = this.mode, gameOver: boolean = this.isGameOver()): boolean {
    return mode === 'single-player' && this.isHost && !gameOver;
  }

  request(paused: boolean): boolean {
    if (!this.canToggle() || this.pending || paused === this.paused) return false;
    this.desiredPaused = paused;
    this.pending = true;
    this.send?.({ t: 'pause', paused, epoch: this.epoch });
    return true;
  }

  toggle(): boolean {
    return this.request(!this.paused);
  }

  clearPending(): void {
    this.pending = false;
    this.desiredPaused = this.paused;
  }

  applyPaused(msg: { paused: boolean; boundary: number; epoch: number }): boolean {
    if (msg.epoch <= this.epoch) return false;
    this.epoch = msg.epoch;
    this.paused = msg.paused;
    this.boundary = msg.boundary;
    this.desiredPaused = msg.paused;
    this.pending = false;
    this.onChange?.(this.state);
    return true;
  }

  applySnapshot(snapshot: { paused?: boolean; pauseBoundary?: number; pauseEpoch?: number }): boolean {
    const epoch = snapshot.pauseEpoch ?? 0;
    const paused = snapshot.paused ?? false;
    const boundary = snapshot.pauseBoundary ?? 0;
    if (epoch < this.epoch) return false;
    const changed = epoch > this.epoch || paused !== this.paused || boundary !== this.boundary;
    this.pending = false;
    if (!changed) {
      this.desiredPaused = this.paused;
      return false;
    }
    this.epoch = epoch;
    this.paused = paused;
    this.boundary = boundary;
    this.desiredPaused = paused;
    this.onChange?.(this.state);
    return true;
  }
}
