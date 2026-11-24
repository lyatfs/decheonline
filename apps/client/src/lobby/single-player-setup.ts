import {
  DEFAULT_GAME_SETTINGS,
  isLobbyCiv,
  isLobbySettings,
  MAX_NAME_LENGTH,
} from '@aoe/protocol';
import {
  CIV_RANDOM,
  DEFAULT_SCORE_LIMIT,
  DEFAULT_TIME_LIMIT,
  LOBBY_MAP_SIZES,
  LOBBY_MAP_TYPES,
  LOBBY_POPULATION_LIMITS,
  LOBBY_RESOURCES,
  LOBBY_SCORE_LIMITS,
  LOBBY_STARTING_AGES,
  LOBBY_TIME_LIMITS,
  LOBBY_VICTORY_TYPES,
  RESOURCES_DEFAULT,
  VICTORY_SCORE,
  VICTORY_STANDARD,
  VICTORY_TIME_LIMIT,
  type GameSettings,
} from '@aoe/sim';
import { BOT_DIFFICULTIES, isBotDifficulty } from '../bot/difficulty';
import type { BotDifficulty, SinglePlayerSetup } from '../bot/types';
import {
  ageName,
  civName,
  englishText,
  gameName,
  LABELS,
  mapSizeName,
  mapTypeName,
  resourcesName,
  timeLimitName,
  victoryName,
  type Text,
} from './setting-text';
import type { SinglePlayerControllerState } from './single-player-controller';

export function defaultLobbySettings(): GameSettings {
  return {
    ...DEFAULT_GAME_SETTINGS,
    victory: { ...DEFAULT_GAME_SETTINGS.victory },
  };
}

export function validateSinglePlayerSetup(
  playerName: string,
  setup: SinglePlayerSetup,
): string | null {
  const trimmed = playerName.trim();
  if (trimmed.length === 0) return 'Please enter a player name.';
  if (trimmed.length > MAX_NAME_LENGTH) {
    return `Player name must be at most ${MAX_NAME_LENGTH} characters.`;
  }
  if (!isLobbyCiv(setup.humanCiv) || !isLobbyCiv(setup.botCiv)) {
    return 'Please select valid civilizations.';
  }
  if (!isBotDifficulty(setup.difficulty)) {
    return 'Please select a valid AI difficulty.';
  }
  if (!isLobbySettings(setup.settings)) {
    return 'Invalid game settings selected.';
  }
  return null;
}

const DIFFICULTY_LABELS: Readonly<Record<BotDifficulty, string>> = {
  easy: 'Easy',
  medium: 'Medium',
  hard: 'Hard',
};

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: Partial<Omit<HTMLElementTagNameMap[K], 'style'>> & { testid?: string; style?: string } = {},
  ...children: (Node | string)[]
): HTMLElementTagNameMap[K] {
  const { testid, style, ...rest } = props;
  const node = Object.assign(document.createElement(tag), rest);
  if (style) node.style.cssText = style;
  if (testid) node.dataset.testid = testid;
  node.append(...children);
  return node;
}

function setOptions(
  node: HTMLSelectElement,
  options: readonly [string, string][],
  selectedValue: string,
): void {
  const opts = options.map(([value, label]) =>
    el('option', { value, selected: value === selectedValue }, label),
  );
  node.replaceChildren(...opts);
  node.value = selectedValue;
}

export interface SinglePlayerSetupCallbacks {
  onStart: (playerName: string, setup: SinglePlayerSetup) => void;
  onCancel: () => void;
}

/**
 * Dedicated Single-Player Setup screen: lets the player choose name, human/bot civs
 * (including Random), difficulty (easy/medium/hard), map type/size, and game settings
 * before creating a single-player room.
 */
export class SinglePlayerSetupView {
  readonly root: HTMLFormElement;
  private text: Text = englishText;
  private playerName = 'Player';
  private humanCiv = 1;
  private botCiv = 2;
  private difficulty: BotDifficulty = 'medium';
  private settings: GameSettings = defaultLobbySettings();
  private localError: string | null = null;
  private launching = false;

  private readonly heading = el('h2', {}, 'Single Player vs AI');
  private readonly nameInput = el('input', {
    testid: 'sp-name',
    maxLength: MAX_NAME_LENGTH,
    ariaLabel: 'Player name',
    placeholder: 'Your name',
    value: 'Player',
  });
  private readonly humanCivSelect = el('select', {
    testid: 'sp-human-civ',
    ariaLabel: 'Your civilization',
  });
  private readonly botCivSelect = el('select', {
    testid: 'sp-bot-civ',
    ariaLabel: 'AI civilization',
  });
  private readonly difficultySelect = el('select', {
    testid: 'sp-difficulty',
    ariaLabel: 'Difficulty',
  });
  private readonly gameSelect = el('select', {
    testid: 'sp-game',
    ariaLabel: 'Select Scenario',
  });
  private readonly mapTypeSelect = el('select', {
    testid: 'sp-map-type',
    ariaLabel: 'Map Type',
  });
  private readonly mapSizeSelect = el('select', {
    testid: 'sp-map-size',
    ariaLabel: 'Map Size',
  });
  private readonly victorySelect = el('select', {
    testid: 'sp-victory',
    ariaLabel: 'Victory Condition',
  });
  private readonly victoryAmountSelect = el('select', {
    testid: 'sp-victory-amount',
    ariaLabel: 'Victory limit',
  });
  private readonly victoryAmountField: HTMLLabelElement;
  private readonly victoryAmountLabelText = el('span', {}, 'Score');
  private readonly startingAgeSelect = el('select', {
    testid: 'sp-starting-age',
    ariaLabel: 'Starting Age',
  });
  private readonly resourcesSelect = el('select', {
    testid: 'sp-resources',
    ariaLabel: 'Resources',
  });
  private readonly populationSelect = el('select', {
    testid: 'sp-population-limit',
    ariaLabel: 'Population Limit',
  });
  private readonly revealMapCheckbox = el('input', {
    type: 'checkbox',
    testid: 'sp-reveal-map',
    ariaLabel: 'Reveal Map',
  });
  private readonly fullTechTreeCheckbox = el('input', {
    type: 'checkbox',
    testid: 'sp-full-tech-tree',
    ariaLabel: 'Full Tech Tree',
  });
  private readonly fixedPositionsCheckbox = el('input', {
    type: 'checkbox',
    testid: 'sp-fixed-positions',
    ariaLabel: 'Fixed Positions',
    checked: true,
  });

  private readonly statusBanner = el('p', {
    className: 'sp-status',
    testid: 'sp-status',
    hidden: true,
  });
  private readonly errorBanner = el('p', {
    className: 'error',
    role: 'alert',
    testid: 'sp-error',
    hidden: true,
  });
  private readonly startBtn = el(
    'button',
    { type: 'submit', className: 'primary', testid: 'sp-start' },
    'Start Game',
  );
  private readonly cancelBtn = el(
    'button',
    { type: 'button', testid: 'sp-cancel' },
    'Cancel',
  );

  private readonly humanCivLabel = el('span', {}, 'Your Civ');
  private readonly botCivLabel = el('span', {}, 'AI Civ');
  private readonly difficultyLabel = el('span', {}, 'Difficulty');
  private readonly gameLabel = el('span', {}, LABELS.game[1]);
  private readonly mapTypeLabel = el('span', {}, LABELS.mapType[1]);
  private readonly mapSizeLabel = el('span', {}, LABELS.mapSize[1]);
  private readonly victoryLabel = el('span', {}, LABELS.victory[1]);
  private readonly startingAgeLabel = el('span', {}, LABELS.startingAge[1]);
  private readonly resourcesLabel = el('span', {}, LABELS.resources[1]);
  private readonly populationLabel = el('span', {}, LABELS.populationLimit[1]);
  private readonly revealMapLabel = el('span', {}, LABELS.revealMap[1]);
  private readonly fullTechTreeLabel = el('span', {}, LABELS.fullTechTree[1]);
  private readonly fixedPositionsLabel = el('span', {}, LABELS.fixedPositions[1]);

  constructor(private readonly callbacks: SinglePlayerSetupCallbacks) {
    this.victoryAmountField = el(
      'label',
      { hidden: true },
      this.victoryAmountLabelText,
      this.victoryAmountSelect,
    );

    const grid = el(
      'div',
      { className: 'sp-grid' },
      el('label', {}, this.humanCivLabel, this.humanCivSelect),
      el('label', {}, this.botCivLabel, this.botCivSelect),
      el('label', {}, this.difficultyLabel, this.difficultySelect),
      el('label', {}, this.gameLabel, this.gameSelect),
      el('label', {}, this.mapTypeLabel, this.mapTypeSelect),
      el('label', {}, this.mapSizeLabel, this.mapSizeSelect),
      el('label', {}, this.victoryLabel, this.victorySelect),
      this.victoryAmountField,
      el('label', {}, this.startingAgeLabel, this.startingAgeSelect),
      el('label', {}, this.resourcesLabel, this.resourcesSelect),
      el('label', {}, this.populationLabel, this.populationSelect),
    );

    const checks = el(
      'div',
      { className: 'sp-checks' },
      el('label', { className: 'sp-check' }, this.revealMapCheckbox, this.revealMapLabel),
      el('label', { className: 'sp-check' }, this.fullTechTreeCheckbox, this.fullTechTreeLabel),
      el('label', { className: 'sp-check' }, this.fixedPositionsCheckbox, this.fixedPositionsLabel),
    );

    this.root = el(
      'form',
      { className: 'panel sp-setup', testid: 'sp-setup' },
      this.heading,
      el('label', {}, 'Player Name', this.nameInput),
      grid,
      checks,
      this.statusBanner,
      this.errorBanner,
      el('div', { className: 'row sp-actions' }, this.startBtn, this.cancelBtn),
    );

    this.bindEvents();
    this.populateOptions();
    this.syncControls();
  }

  setText(text: Text): void {
    this.text = text;
    this.populateOptions();
    this.syncControls();
  }

  setPlayerName(name: string): void {
    this.playerName = name;
    this.nameInput.value = name;
    this.clearLocalError();
  }

  getSetup(): SinglePlayerSetup {
    return {
      humanCiv: this.humanCiv,
      botCiv: this.botCiv,
      difficulty: this.difficulty,
      settings: {
        ...this.settings,
        victory: { ...this.settings.victory },
      },
    };
  }

  update(controllerState: SinglePlayerControllerState, externalError: string | null = null): void {
    const launching =
      controllerState.status === 'creating' ||
      controllerState.status === 'configuring' ||
      controllerState.status === 'spawning' ||
      controllerState.status === 'readying' ||
      controllerState.status === 'starting';
    this.launching = launching;

    const controls: (HTMLInputElement | HTMLSelectElement | HTMLButtonElement)[] = [
      this.nameInput,
      this.humanCivSelect,
      this.botCivSelect,
      this.difficultySelect,
      this.gameSelect,
      this.mapTypeSelect,
      this.mapSizeSelect,
      this.victorySelect,
      this.victoryAmountSelect,
      this.startingAgeSelect,
      this.resourcesSelect,
      this.populationSelect,
      this.revealMapCheckbox,
      this.fullTechTreeCheckbox,
      this.fixedPositionsCheckbox,
      this.startBtn,
    ];
    for (const c of controls) c.disabled = launching;
    if (!launching) {
      this.resourcesSelect.disabled = this.settings.deathMatch;
    }
    this.cancelBtn.disabled = false;
    this.startBtn.textContent = launching ? 'Starting...' : 'Start Game';

    this.statusBanner.hidden = !launching;
    this.statusBanner.textContent = launching ? controllerState.statusMessage : '';

    const err = externalError ?? this.localError ?? controllerState.error;
    this.errorBanner.hidden = !err;
    this.errorBanner.textContent = err ?? '';
  }

  private clearLocalError(): void {
    if (this.localError !== null) {
      this.localError = null;
      this.errorBanner.hidden = true;
      this.errorBanner.textContent = '';
    }
  }

  private submit(): void {
    if (this.launching) return;
    this.playerName = this.nameInput.value;
    const setup = this.getSetup();
    const err = validateSinglePlayerSetup(this.playerName, setup);
    if (err !== null) {
      this.localError = err;
      this.errorBanner.hidden = false;
      this.errorBanner.textContent = err;
      return;
    }
    this.localError = null;
    this.callbacks.onStart(this.playerName.trim(), setup);
  }

  private bindEvents(): void {
    this.nameInput.addEventListener('input', () => {
      this.playerName = this.nameInput.value;
      this.clearLocalError();
    });
    this.humanCivSelect.addEventListener('change', () => {
      this.humanCiv = Number(this.humanCivSelect.value);
      this.clearLocalError();
    });
    this.botCivSelect.addEventListener('change', () => {
      this.botCiv = Number(this.botCivSelect.value);
      this.clearLocalError();
    });
    this.difficultySelect.addEventListener('change', () => {
      const val = this.difficultySelect.value;
      if (isBotDifficulty(val)) this.difficulty = val;
      this.clearLocalError();
    });
    this.gameSelect.addEventListener('change', () => {
      const deathMatch = Number(this.gameSelect.value) === 1;
      this.settings = {
        ...this.settings,
        deathMatch,
        victory: { type: VICTORY_STANDARD },
        ...(deathMatch ? { resources: RESOURCES_DEFAULT } : {}),
      };
      this.clearLocalError();
      this.syncVictoryAmount();
      this.syncControls();
    });
    this.mapTypeSelect.addEventListener('change', () => {
      this.settings = { ...this.settings, mapType: Number(this.mapTypeSelect.value) };
      this.clearLocalError();
    });
    this.mapSizeSelect.addEventListener('change', () => {
      this.settings = { ...this.settings, mapSize: Number(this.mapSizeSelect.value) };
      this.clearLocalError();
    });
    this.victorySelect.addEventListener('change', () => {
      const type = Number(this.victorySelect.value);
      const victory =
        type === VICTORY_TIME_LIMIT
          ? { type, amount: DEFAULT_TIME_LIMIT }
          : type === VICTORY_SCORE
            ? { type, amount: DEFAULT_SCORE_LIMIT }
            : { type };
      this.settings = { ...this.settings, victory };
      this.clearLocalError();
      this.syncVictoryAmount();
    });
    this.victoryAmountSelect.addEventListener('change', () => {
      this.settings = {
        ...this.settings,
        victory: { type: this.settings.victory.type, amount: Number(this.victoryAmountSelect.value) },
      };
      this.clearLocalError();
    });
    this.startingAgeSelect.addEventListener('change', () => {
      this.settings = { ...this.settings, startingAge: Number(this.startingAgeSelect.value) };
      this.clearLocalError();
    });
    this.resourcesSelect.addEventListener('change', () => {
      this.settings = { ...this.settings, resources: Number(this.resourcesSelect.value) };
      this.clearLocalError();
    });
    this.populationSelect.addEventListener('change', () => {
      this.settings = { ...this.settings, populationLimit: Number(this.populationSelect.value) };
      this.clearLocalError();
    });
    this.revealMapCheckbox.addEventListener('change', () => {
      this.settings = { ...this.settings, revealMap: this.revealMapCheckbox.checked };
      this.clearLocalError();
    });
    this.fullTechTreeCheckbox.addEventListener('change', () => {
      this.settings = { ...this.settings, fullTechTree: this.fullTechTreeCheckbox.checked };
      this.clearLocalError();
    });
    this.fixedPositionsCheckbox.addEventListener('change', () => {
      this.settings = { ...this.settings, fixedPositions: this.fixedPositionsCheckbox.checked };
      this.clearLocalError();
    });

    this.startBtn.addEventListener('click', (e) => {
      (e as { preventDefault?: () => void }).preventDefault?.();
      this.submit();
    });
    this.root.addEventListener('submit', (e) => {
      (e as { preventDefault?: () => void }).preventDefault?.();
      this.submit();
    });
    this.cancelBtn.addEventListener('click', () => {
      this.clearLocalError();
      this.callbacks.onCancel();
    });
    this.root.addEventListener('keydown', (e) => {
      if ((e as { key?: string }).key === 'Escape') {
        (e as { preventDefault?: () => void }).preventDefault?.();
        this.clearLocalError();
        this.callbacks.onCancel();
      }
    });
  }

  private label(key: keyof typeof LABELS): string {
    const [id, fallback] = LABELS[key];
    return this.text(id, fallback);
  }

  private populateOptions(): void {
    this.gameLabel.textContent = this.label('game');
    this.mapTypeLabel.textContent = this.label('mapType');
    this.mapSizeLabel.textContent = this.label('mapSize');
    this.victoryLabel.textContent = this.label('victory');
    this.startingAgeLabel.textContent = this.label('startingAge');
    this.resourcesLabel.textContent = this.label('resources');
    this.populationLabel.textContent = this.label('populationLimit');
    this.revealMapLabel.textContent = this.label('revealMap');
    this.fullTechTreeLabel.textContent = this.label('fullTechTree');
    this.fixedPositionsLabel.textContent = this.label('fixedPositions');

    const civs: [string, string][] = Array.from({ length: CIV_RANDOM }, (_, i) => [
      String(i + 1),
      civName(this.text, i + 1),
    ]);
    setOptions(this.humanCivSelect, civs, String(this.humanCiv));
    setOptions(this.botCivSelect, civs, String(this.botCiv));

    setOptions(
      this.difficultySelect,
      BOT_DIFFICULTIES.map((d) => [d, DIFFICULTY_LABELS[d]]),
      this.difficulty,
    );
    setOptions(
      this.gameSelect,
      [0, 1].map((v) => [String(v), gameName(this.text, v === 1)]),
      this.settings.deathMatch ? '1' : '0',
    );
    setOptions(
      this.mapTypeSelect,
      LOBBY_MAP_TYPES.map((v) => [String(v), mapTypeName(this.text, v)]),
      String(this.settings.mapType),
    );
    setOptions(
      this.mapSizeSelect,
      LOBBY_MAP_SIZES.map((v) => [String(v), mapSizeName(this.text, v)]),
      String(this.settings.mapSize),
    );
    setOptions(
      this.victorySelect,
      LOBBY_VICTORY_TYPES.map((v) => [String(v), victoryName(this.text, v)]),
      String(this.settings.victory.type),
    );
    setOptions(
      this.startingAgeSelect,
      LOBBY_STARTING_AGES.map((v) => [String(v), ageName(this.text, v)]),
      String(this.settings.startingAge),
    );
    setOptions(
      this.resourcesSelect,
      LOBBY_RESOURCES.map((v) => [String(v), resourcesName(this.text, v)]),
      String(this.settings.resources),
    );
    setOptions(
      this.populationSelect,
      LOBBY_POPULATION_LIMITS.map((v) => [String(v), String(v)]),
      String(this.settings.populationLimit),
    );
    this.syncVictoryAmount();
  }

  private syncVictoryAmount(): void {
    const { type, amount } = this.settings.victory;
    if (type === VICTORY_TIME_LIMIT) {
      this.victoryAmountField.hidden = false;
      this.victoryAmountLabelText.textContent = this.label('timeLimit');
      setOptions(
        this.victoryAmountSelect,
        LOBBY_TIME_LIMITS.map((v) => [String(v), timeLimitName(this.text, v)]),
        String(amount ?? DEFAULT_TIME_LIMIT),
      );
    } else if (type === VICTORY_SCORE) {
      this.victoryAmountField.hidden = false;
      this.victoryAmountLabelText.textContent = this.label('score');
      setOptions(
        this.victoryAmountSelect,
        LOBBY_SCORE_LIMITS.map((v) => [String(v), String(v)]),
        String(amount ?? DEFAULT_SCORE_LIMIT),
      );
    } else {
      this.victoryAmountField.hidden = true;
    }
  }

  private syncControls(): void {
    this.nameInput.value = this.playerName;
    this.humanCivSelect.value = String(this.humanCiv);
    this.botCivSelect.value = String(this.botCiv);
    this.difficultySelect.value = this.difficulty;
    this.gameSelect.value = this.settings.deathMatch ? '1' : '0';
    this.mapTypeSelect.value = String(this.settings.mapType);
    this.mapSizeSelect.value = String(this.settings.mapSize);
    this.victorySelect.value = String(this.settings.victory.type);
    this.startingAgeSelect.value = String(this.settings.startingAge);
    this.resourcesSelect.value = String(this.settings.resources);
    this.resourcesSelect.disabled = this.launching || this.settings.deathMatch;
    this.populationSelect.value = String(this.settings.populationLimit);
    this.revealMapCheckbox.checked = this.settings.revealMap;
    this.fullTechTreeCheckbox.checked = this.settings.fullTechTree;
    this.fixedPositionsCheckbox.checked = this.settings.fixedPositions;
  }
}
