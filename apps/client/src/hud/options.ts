// The game speed, music and sound volume parts of the original's Game Settings dialog (`TRIBE_Dialog_Config`,
// src/dlg_conf.cpp): three radio buttons Normal, Fast and Very Fast for 1.0, 1.5 and 2.0, which OK sends as a game speed
// command when the choice differs from the speed the dialog opened at (src/dlg_conf.cpp:453-475, docs/spec/lobby.md §8),
// and vertical sliders from "High" at the top to "Off" at the bottom that change the volume as they move, OK keeps them,
// Cancel puts the old ones back (src/dlg_conf.cpp:543-573). OK with the music moved to "Off" shuts the music down, and
// from off starts it again (src/dlg_conf.cpp:477-496). The scroll speed part is not here.
import {
  DEFAULT_GAME_SPEED,
  GAME_SPEEDS,
  SINGLE_PLAYER_SPEED_MAX,
  SINGLE_PLAYER_SPEED_MIN,
  SINGLE_PLAYER_SPEED_STEP,
  isSinglePlayerGameSpeed,
} from '@aoe/sim';
import type { AssetProvider } from '../assets';
import { VOLUME_STOPS } from '../audio/sound-player';

/**
 * `STRING_ID_GAME_SETTINGS_TITLE`, `_MUSIC_VOLUME_TITLE`, `_SOUND_VOLUME_TITLE`, `_AUDIO_VOLUME_HIGH`, `_AUDIO_VOLUME_OFF`
 * (include/resource_ids.h:116-123), `STRING_ID_BUTTON_OK`, `_CANCEL`.
 */
const STRING_TITLE = 9431;
/** `STRING_ID_GAME_SPEED_TITLE`, `_NORMAL`, `_FAST`, `_VERY_FAST` (include/resource_ids.h:117-124). */
const STRING_SPEED = 9439;
const STRING_SPEEDS = [9432, 9433, 9434];
const STRING_MUSIC_VOLUME = 9435;
const STRING_SOUND_VOLUME = 9438;
const STRING_HIGH = 9436;
const STRING_OFF = 9437;
const STRING_OK = 4001;
const STRING_CANCEL = 4002;

/** The player's sound volume and the buttons' click, as the dialog reads and changes them. */
export interface OptionsSounds {
  /** The slider's position: 0 "High" .. `VOLUME_STOPS` "Off". */
  volume: number;
  button(): void;
}

/** The game speed as the dialog reads and changes it. */
export interface OptionsSpeed {
  /** The world's `game_speed`. */
  current(): number;
  /** The game over mode (`ProgModeGameOver`): the speed controls are disabled and OK changes nothing. */
  disabled(): boolean;
  /** Change the speed for everybody. */
  change(speed: number): void;
  /** Single-player bounded speed mode ([0.5, 4.0], step 0.25); false/omitted keeps multiplayer [1, 1.5, 2]. */
  singlePlayer?: boolean;
}

/** The music volume as the dialog reads and changes it (`MusicPlayer`). */
export interface OptionsMusic {
  /** The slider's position: 0 "High" .. `VOLUME_STOPS` "Off"; it changes the volume at once. */
  volume: number;
  /** OK with the music volume moved: shut the music down at "Off", start it from off. */
  applyVolume(): void;
}

/** Single-player pause toggle shown inside Game Settings when allowed. */
export interface OptionsPause {
  allowed(): boolean;
  paused(): boolean;
  disabled(): boolean;
  toggle(): void;
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className: string, text = ''): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  e.className = className;
  e.textContent = text;
  return e;
}

function snapSinglePlayerSpeed(raw: number): number | null {
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return null;
  const clamped = Math.min(SINGLE_PLAYER_SPEED_MAX, Math.max(SINGLE_PLAYER_SPEED_MIN, raw));
  const snapped = Math.round(clamped / SINGLE_PLAYER_SPEED_STEP) * SINGLE_PLAYER_SPEED_STEP;
  return Number(snapped.toFixed(2));
}

function formatSpeedLabel(speed: number): string {
  return Number.isInteger(speed * 10) ? `${speed.toFixed(1)}x` : `${speed.toFixed(2)}x`;
}

export class OptionsDialog {
  readonly root = el('div', 'hud-options');
  private readonly slider = el('input', 'hud-options-slider');
  private readonly musicSlider = el('input', 'hud-options-slider');
  /** The volumes when the dialog opened, for Cancel. */
  private before = 0;
  /** Normal, Fast, Very Fast (multiplayer). */
  private readonly speedButtons: HTMLInputElement[];
  /** Single-player bounded speed controls (when `speed.singlePlayer` is true). */
  private readonly spSpeedSlider: HTMLInputElement | null = null;
  private readonly spSpeedDec: HTMLButtonElement | null = null;
  private readonly spSpeedInc: HTMLButtonElement | null = null;
  private readonly spSpeedValue: HTMLSpanElement | null = null;
  private spSelected = DEFAULT_GAME_SPEED;
  /** The speed when the dialog opened (`gameSpeed`). */
  private speedBefore = 1;
  private musicBefore = 0;
  private readonly pauseButton: HTMLButtonElement | null = null;

  constructor(
    parent: HTMLElement,
    provider: AssetProvider,
    private readonly sounds: OptionsSounds,
    private readonly speed?: OptionsSpeed,
    private readonly music: OptionsMusic | null = null,
    private readonly pause: OptionsPause | null = null,
  ) {
    // Like the other HUD labels, no English of its own: without the pack's strings they are empty.
    const text = (id: number) => provider.string(id) ?? '';
    this.root.dataset.testid = 'options-dialog';
    this.root.hidden = true;
    const volume = (label: number, slider: HTMLInputElement, testid: string, set: (position: number) => void) => {
      const box = el('div', 'hud-options-volume');
      Object.assign(slider, { type: 'range', min: '0', max: String(VOLUME_STOPS), step: '1' });
      slider.dataset.testid = testid;
      slider.addEventListener('input', () => set(Number(slider.value)));
      box.append(el('div', 'hud-options-label', text(label)), el('div', 'hud-options-high', text(STRING_HIGH)), slider, el('div', 'hud-options-off', text(STRING_OFF)));
      return box;
    };
    const volumes = el('div', 'hud-options-volumes');
    // The music's slider left of the sound's (src/dlg_conf.cpp:108-133).
    if (music) volumes.append(volume(STRING_MUSIC_VOLUME, this.musicSlider, 'music-volume', (p) => (music.volume = p)));
    volumes.append(volume(STRING_SOUND_VOLUME, this.slider, 'sound-volume', (p) => (this.sounds.volume = p)));
    const speeds = el('div', 'hud-options-speed');
    speeds.append(el('div', 'hud-options-label', text(STRING_SPEED)));
    if (speed?.singlePlayer) {
      this.speedButtons = [];
      const row = el('div', 'hud-options-sp-speed');
      row.dataset.testid = 'sp-speed-control';
      Object.assign(row.style, { display: 'flex', alignItems: 'center', gap: '6px' });

      const slider = el('input', 'hud-options-sp-slider');
      Object.assign(slider, {
        type: 'range',
        min: String(SINGLE_PLAYER_SPEED_MIN),
        max: String(SINGLE_PLAYER_SPEED_MAX),
        step: String(SINGLE_PLAYER_SPEED_STEP),
        value: String(DEFAULT_GAME_SPEED),
      });
      slider.dataset.testid = 'sp-speed-slider';
      slider.style.width = '110px';

      const valueLabel = el('span', 'hud-options-sp-value', formatSpeedLabel(DEFAULT_GAME_SPEED));
      valueLabel.dataset.testid = 'sp-speed-value';
      Object.assign(valueLabel.style, { minWidth: '42px', textAlign: 'right', fontWeight: 'bold' });

      const dec = this.button('-', 'sp-speed-dec', () => {
        if (this.speed?.disabled()) return;
        const next = snapSinglePlayerSpeed(this.spSelected - SINGLE_PLAYER_SPEED_STEP);
        if (next !== null) this.setSpSpeed(next);
      });
      dec.style.minWidth = '28px';

      const inc = this.button('+', 'sp-speed-inc', () => {
        if (this.speed?.disabled()) return;
        const next = snapSinglePlayerSpeed(this.spSelected + SINGLE_PLAYER_SPEED_STEP);
        if (next !== null) this.setSpSpeed(next);
      });
      inc.style.minWidth = '28px';

      slider.addEventListener('input', () => {
        const next = snapSinglePlayerSpeed(Number(slider.value));
        if (next !== null) this.setSpSpeed(next);
      });

      this.spSpeedSlider = slider;
      this.spSpeedDec = dec;
      this.spSpeedInc = inc;
      this.spSpeedValue = valueLabel;
      row.append(dec, slider, inc, valueLabel);
      speeds.append(row);
    } else {
      this.speedButtons = GAME_SPEEDS.map(() => el('input', 'hud-options-radio'));
      this.speedButtons.forEach((b, i) => {
        Object.assign(b, { type: 'radio', name: 'hud-options-speed' });
        b.dataset.testid = `game-speed-${GAME_SPEEDS[i]}`;
        const label = el('label', 'hud-options-choice');
        label.append(b, el('span', '', text(STRING_SPEEDS[i]!)));
        speeds.append(label);
      });
    }
    const ok = this.button(text(STRING_OK), 'options-ok', () => {
      if (this.speed && !this.speed.disabled()) {
        if (this.speed.singlePlayer) {
          if (isSinglePlayerGameSpeed(this.spSelected) && this.spSelected !== this.speedBefore) {
            this.speed.change(this.spSelected);
          }
        } else {
          const chosen = GAME_SPEEDS[this.speedButtons.findIndex((b) => b.checked)];
          if (chosen !== undefined && chosen !== this.speedBefore) this.speed.change(chosen);
        }
      }
      if (music && music.volume !== this.musicBefore) music.applyVolume();
      this.close();
    });
    const cancel = this.button(text(STRING_CANCEL), 'options-cancel', () => {
      this.sounds.volume = this.before;
      if (music) music.volume = this.musicBefore;
      this.close();
    });
    const buttons = el('div', 'hud-options-buttons');
    if (this.pause) {
      this.pauseButton = this.button('Pause Game', 'options-pause', () => {
        if (!this.pause || !this.pause.allowed() || this.pause.disabled()) return;
        this.pause.toggle();
        this.close();
      });
      buttons.append(ok, this.pauseButton, cancel);
    } else {
      buttons.append(ok, cancel);
    }
    const parts = el('div', 'hud-options-parts');
    if (speed) parts.append(speeds);
    parts.append(volumes);
    this.root.append(el('div', 'hud-options-title', text(STRING_TITLE)), parts, buttons);
    parent.append(this.root);
  }

  get open(): boolean {
    return !this.root.hidden;
  }

  show(): void {
    this.before = this.sounds.volume;
    this.slider.value = String(this.before);
    if (this.speed) {
      const current = this.speed.current();
      const disabled = this.speed.disabled();
      if (this.speed.singlePlayer) {
        const normalized = isSinglePlayerGameSpeed(current) ? (snapSinglePlayerSpeed(current) ?? DEFAULT_GAME_SPEED) : DEFAULT_GAME_SPEED;
        this.speedBefore = normalized;
        this.setSpSpeed(normalized, disabled);
      } else {
        // A speed off the ladder checks none of the three (src/dlg_conf.cpp:98-105).
        this.speedBefore = current;
        this.speedButtons.forEach((b, i) => Object.assign(b, { checked: GAME_SPEEDS[i] === this.speedBefore, disabled }));
      }
    }
    this.musicBefore = this.music?.volume ?? 0;
    this.musicSlider.value = String(this.musicBefore);
    if (this.pauseButton) {
      const allowed = this.pause?.allowed() ?? false;
      const disabled = !allowed || (this.pause?.disabled() ?? true);
      this.pauseButton.hidden = !allowed;
      this.pauseButton.disabled = disabled;
      this.pauseButton.textContent = this.pause?.paused() ? 'Resume Game' : 'Pause Game';
    }
    this.root.hidden = false;
  }

  close(): void {
    this.root.hidden = true;
  }

  private setSpSpeed(speed: number, disabled = this.speed?.disabled() ?? false): void {
    this.spSelected = speed;
    if (this.spSpeedSlider) {
      this.spSpeedSlider.value = String(speed);
      this.spSpeedSlider.disabled = disabled;
    }
    if (this.spSpeedValue) {
      this.spSpeedValue.textContent = formatSpeedLabel(speed);
    }
    if (this.spSpeedDec) {
      this.spSpeedDec.disabled = disabled || speed <= SINGLE_PLAYER_SPEED_MIN;
    }
    if (this.spSpeedInc) {
      this.spSpeedInc.disabled = disabled || speed >= SINGLE_PLAYER_SPEED_MAX;
    }
  }

  private button(label: string, testid: string, run: () => void): HTMLButtonElement {
    const b = el('button', 'hud-options-button', label);
    b.dataset.testid = testid;
    b.addEventListener('pointerdown', () => this.sounds.button());
    b.addEventListener('click', run);
    return b;
  }
}
