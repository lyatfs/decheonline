import {
  DEFAULT_ROOM_CAPACITY,
  isRoomCapacity,
  type CompatibilityVersions,
  type PlayerInfo,
  type RoomCapacity,
  type RoomSeat,
  type Slot,
} from '@aoe/protocol';
import {
  CIV_RANDOM,
  DEFAULT_SCORE_LIMIT,
  DEFAULT_TIME_LIMIT,
  LOBBY_MAP_SIZES,
  LOBBY_MAP_TYPES,
  LOBBY_PATH_FINDING,
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
import type { LobbyState } from './session';
import type { Session } from './session';
import { ageName, civName, englishText, gameName, LABELS, mapSizeName, mapTypeName, pathFindingName, resourcesName, summaryLines, timeLimitName, victoryName, type Text } from './setting-text';
import { SinglePlayerController } from './single-player-controller';
import { SinglePlayerSetupView } from './single-player-setup';
import { AiBot } from '../bot/ai-bot';

const ERROR_TEXT: Record<string, string> = {
  'bad-code': 'No game with that invite code.',
  'room-full': 'That game is full.',
  'room-started': 'That game has already started.',
  'version-mismatch': 'Version mismatch: your game build or assets do not match this room.',
  'bad-result': 'Invalid match result reported.',
  'not-ready': 'All seats must be filled and ready before starting.',
  'not-host': 'Only the room host can perform this action.',
  unauthorized: 'You are not authorized to join this room.',
};

export interface LobbyViewOptions {
  testMap?: boolean;
  speed?: number;
  initialRoomCode?: string;
  buildInviteUrl?: (code: string) => string | null;
  copyInvite?: (url: string) => Promise<{ copied: boolean; method: string } | boolean>;
  isLocalOrigin?: (origin: string) => boolean;
  versions?: CompatibilityVersions | (() => CompatibilityVersions);
}

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

/** A drop-down of `options` ([value, label]) showing `value`; `onPick` gets the picked value. */
function select(testid: string, label: string, options: [number, string][], value: number, onPick: (v: number) => void): HTMLSelectElement {
  const node = el('select', { ariaLabel: label, testid });
  for (const [v, text] of options) node.append(el('option', { value: String(v), selected: v === value }, text));
  node.value = String(value);
  node.addEventListener('change', () => onPick(Number(node.value)));
  return node;
}

/** A check box showing `value`; `onPick` gets the new state. */
function checkbox(testid: string, label: string, value: boolean, onPick: (v: boolean) => void): HTMLInputElement {
  const node = el('input', { type: 'checkbox', ariaLabel: label, testid, checked: value });
  node.addEventListener('change', () => onPick(node.checked));
  return node;
}

function inferStateCapacity(state: LobbyState): RoomCapacity {
  if (isRoomCapacity(state.capacity)) return state.capacity;
  if (state.seats && isRoomCapacity(state.seats.length)) return state.seats.length;
  if (state.players.some((p) => p.slot >= 2) || state.players.length > 2) return 4;
  return DEFAULT_ROOM_CAPACITY;
}

function normalizeSeats(capacity: RoomCapacity, seats: readonly RoomSeat[] | undefined, players: readonly PlayerInfo[]): RoomSeat[] {
  return Array.from({ length: capacity }, (_, slot) => {
    const existing = seats?.find((s) => s.slot === slot);
    if (existing) return existing;
    const player = players.find((p) => p.slot === slot);
    if (!player) return { slot, status: 'open', name: null, civ: null, ready: false };
    return { slot, status: 'occupied', name: player.name, civ: player.civ, ready: player.ready };
  });
}

/** The setup screen's chat box keeps 100 lines (`fillChat`, src/scr_mps.cpp:1704-1716). */
const CHAT_LINES = 100;
/** Its input takes 247 characters (`create_edit(..., 247, ...)`, src/scr_mps.cpp:235). */
const CHAT_LENGTH = 247;

/**
 * DOM for the lobby: entry (name, create, join by code) and the room (invite code, players with their civs, the host's
 * settings, chat, ready, start), as the original's multiplayer setup screen offers them (docs/spec/lobby.md,
 * docs/spec/chat.md §5).
 */
export class LobbyView {
  readonly root = el('section', { id: 'lobby', testid: 'lobby' });
  private name = 'Player';
  private joinCode = '';
  private createCapacity: RoomCapacity = DEFAULT_ROOM_CAPACITY;
  private text: Text = englishText;
  private bot: AiBot | null = null;
  private botSpawning = false;
  private botGeneration = 0;
  private spOpen = false;
  private suppressRender = false;
  private copyFeedback: string | null = null;
  private lastRoomCode = '';
  private readonly options: LobbyViewOptions;
  private readonly spController: SinglePlayerController;
  private readonly spSetup: SinglePlayerSetupView;
  /** The room's chat, kept across redraws: the box of lines and the input. */
  private readonly chatLog = el('div', { className: 'chat-log', testid: 'lobby-chat' });
  private readonly chatInput = el('input', { maxLength: CHAT_LENGTH, testid: 'lobby-chat-input', ariaLabel: 'Chat', autocomplete: 'off' });
  private readonly chatTitle = el('h3', {});
  private readonly chat = el('div', { className: 'chat' }, this.chatTitle, this.chatLog, this.chatInput);
  private inRoom = false;

  constructor(private readonly session: Session, options: LobbyViewOptions = {}) {
    this.options = options;
    this.joinCode = options.initialRoomCode ?? '';
    const botDebug = { testMap: options.testMap, speed: options.speed };
    this.spController = new SinglePlayerController({
      session,
      spawnBot: (code, spawnOptions) => AiBot.spawn(code, { ...spawnOptions, ...botDebug }),
      onStateChange: () => {
        if (!this.suppressRender) this.render(this.session.state);
      },
    });
    this.spSetup = new SinglePlayerSetupView({
      onStart: (playerName, setup) => {
        this.name = playerName.trim() || this.name;
        this.spController.start(playerName, setup);
      },
      onCancel: () => {
        this.spController.cancel();
        this.spOpen = false;
        this.createCapacity = DEFAULT_ROOM_CAPACITY;
        this.render(this.session.state);
      },
    });
    session.onChange = (state) => {
      this.suppressRender = true;
      try {
        this.spController.onSessionState(state);
      } finally {
        this.suppressRender = false;
      }
      this.render(state);
    };
    session.onChat = (line) => this.addChat(line);
    this.chatInput.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter' || !this.chatInput.value) return;
      this.session.sendChat(this.chatInput.value);
      this.chatInput.value = '';
    });
    this.render(session.state);
  }

  /**
   * Use the pack's language strings from the next redraw on (the next lobby message). Not redrawn now: a redraw at an
   * arbitrary moment swaps the input or button the player is using. The English fallbacks are the retail strings.
   */
  setText(text: Text): void {
    this.text = text;
    this.spSetup.setText(text);
  }

  destroy(): void {
    this.cleanupBot();
    this.spController.destroy();
    this.spOpen = false;
  }

  render(state: LobbyState): void {
    this.root.hidden = state.phase === 'playing';
    // A new setup screen starts with an empty chat (`chat->ClearChat()`, src/scr_mps.cpp:52).
    if (state.phase === 'lobby' && (!this.inRoom || this.lastRoomCode !== state.code)) {
      this.chatLog.replaceChildren();
      this.copyFeedback = null;
      this.lastRoomCode = state.code;
    }
    const leftRoom = (state.phase === 'idle' && this.inRoom) || state.phase === 'ended';
    if (leftRoom) {
      this.createCapacity = DEFAULT_ROOM_CAPACITY;
      this.copyFeedback = null;
      this.lastRoomCode = '';
      if (state.phase === 'idle') this.joinCode = '';
    }
    this.inRoom = state.phase === 'lobby';

    if (state.phase === 'playing') {
      this.spOpen = false;
    }

    if (state.phase === 'ended' || state.phase === 'idle') {
      this.cleanupBot();
      if (state.phase === 'ended') this.spOpen = false;
    }

    if (this.spOpen) {
      this.spSetup.update(this.spController.state);
      this.root.replaceChildren(this.spSetup.root);
      return;
    }

    // The chat moves into the new panel; typing in it goes on.
    const typing = document.activeElement === this.chatInput;
    this.root.replaceChildren(state.phase === 'lobby' ? this.room(state) : this.entry(state));
    if (typing && this.chatInput.isConnected) this.chatInput.focus();
  }

  private resolveVersions(): CompatibilityVersions | undefined {
    const v = this.options.versions;
    if (!v) return undefined;
    return typeof v === 'function' ? v() : v;
  }

  private cleanupBot(): void {
    this.botGeneration++;
    this.botSpawning = false;
    if (this.bot) {
      this.bot.destroy();
      this.bot = null;
    }
  }

  private spawnBot(code: string): void {
    if (this.bot || this.botSpawning || !code) return;
    const gen = this.botGeneration;
    this.botSpawning = true;
    const civ = Math.floor(Math.random() * 16) + 1;
    void AiBot.spawn(code, 'Computer (Hard)', civ)
      .then((b) => {
        if (gen !== this.botGeneration || this.session.state.phase !== 'lobby' || this.session.state.code !== code) {
          b.destroy();
          return;
        }
        this.bot = b;
      })
      .catch(() => {
        // Spawn failed (e.g. network error); allow future retry while still in lobby
      })
      .finally(() => {
        if (gen === this.botGeneration) this.botSpawning = false;
      });
  }

  /** `word_wrap_append` a line; the box follows the newest line when it was showing the last one. */
  private addChat(line: string): void {
    const log = this.chatLog;
    const atEnd = log.scrollTop + log.clientHeight >= log.scrollHeight - 1;
    if (log.childElementCount >= CHAT_LINES) log.firstElementChild?.remove();
    log.append(el('div', { className: 'chat-line', testid: 'lobby-chat-line' }, line));
    if (atEnd) log.scrollTop = log.scrollHeight;
  }

  private entry(state: LobbyState): HTMLElement {
    const singlePlayerBtn = el(
      'button',
      { testid: 'single-player', className: 'primary' },
      '⚔️ Chơi Đơn Với Máy (Single Player vs AI)',
    );
    singlePlayerBtn.style.width = '100%';
    singlePlayerBtn.style.padding = '0.9rem';
    singlePlayerBtn.style.fontSize = '1.15rem';
    singlePlayerBtn.style.marginBottom = '1.2rem';
    singlePlayerBtn.style.background = 'linear-gradient(180deg, #947a32 0%, #d4af37 50%, #7d6322 100%)';
    singlePlayerBtn.style.color = '#fffbe8';
    singlePlayerBtn.style.border = '2px solid #ffe57f';
    singlePlayerBtn.style.boxShadow = '0 0 15px rgba(212, 175, 55, 0.4)';
    singlePlayerBtn.addEventListener('click', () => {
      this.createCapacity = DEFAULT_ROOM_CAPACITY;
      this.cleanupBot();
      this.spController.cancel();
      this.spSetup.setPlayerName(this.name);
      this.spOpen = true;
      this.render(this.session.state);
    });

    const name = el('input', { value: this.name, maxLength: 24, testid: 'name', ariaLabel: 'Your name', placeholder: 'Your name' });
    name.addEventListener('input', () => (this.name = name.value.trim() || 'Player'));
    const capacitySelect = select(
      'capacity',
      'Room capacity',
      [
        [2, '2 Players (1v1)'],
        [4, '4 Players (FFA)'],
      ],
      this.createCapacity,
      (v) => {
        if (isRoomCapacity(v)) this.createCapacity = v;
      },
    );
    const code = el('input', { value: this.joinCode, maxLength: 12, placeholder: 'Invite code', testid: 'code', ariaLabel: 'Invite code' });
    code.addEventListener('input', () => (this.joinCode = code.value));
    const create = el('button', { testid: 'create' }, 'Tạo phòng (Create)');
    create.addEventListener('click', () => {
      this.spOpen = false;
      this.spController.cancel();
      this.cleanupBot();
      const versions = this.resolveVersions();
      if (versions) this.session.setVersions?.(versions);
      if (this.createCapacity === 4) {
        this.session.create(this.name, { capacity: 4, ...(versions ? { versions } : {}) });
      } else if (versions) {
        this.session.create(this.name, { capacity: 2, versions });
      } else {
        this.session.create(this.name);
      }
    });
    const join = el('button', { testid: 'join' }, 'Vào phòng (Join)');
    join.addEventListener('click', () => {
      this.spOpen = false;
      this.spController.cancel();
      this.cleanupBot();
      const versions = this.resolveVersions();
      if (versions) this.session.setVersions?.(versions);
      const targetCode = code.value || this.joinCode;
      if (versions) {
        this.session.join(targetCode, this.name, undefined, versions);
      } else {
        this.session.join(targetCode, this.name);
      }
    });

    const skirmish = el('button', { testid: 'skirmish-btn' }, '💥 Hỗn Chiến (Skirmish)');
    skirmish.addEventListener('click', () => {
      location.href = '/?debug=combat';
    });

    const map = el('button', { testid: 'map-btn' }, '🗺️ Bản Đồ (Map View)');
    map.addEventListener('click', () => {
      location.href = '/?debug=map';
    });

    const box = el(
      'div',
      { className: 'panel' },
      el('h2', {}, 'Age of Empires: Rise of Rome'),
      singlePlayerBtn,
      el('div', { className: 'row', style: 'margin-bottom: 1.2rem;' }, skirmish, map),
      el('h3', { style: 'margin: 0.5rem 0 0.8rem; text-align: center; font-size: 1.1rem; color: #5a4a32;' }, '── Nhiều Người Chơi (Multiplayer) ──'),
      el('label', {}, 'Tên người chơi (Player Name)', name),
      el('div', { className: 'capacity-row' }, el('label', {}, 'Số người chơi (Players)', capacitySelect)),
      el('div', { className: 'row' }, create),
      el('p', { className: 'or' }, 'hoặc nhập mã phòng để vào chơi cùng bạn bè'),
      el('div', { className: 'row' }, code, join),
    );
    if (state.phase === 'ended') box.append(el('p', { className: 'note', testid: 'ended' }, 'The game ended.'));
    this.appendError(box, state);
    return box;
  }

  private room(state: LobbyState): HTMLElement {
    const capacity = inferStateCapacity(state);
    const hostSlot: Slot = state.hostSlot ?? 0;
    const isHost = state.you >= 0 && state.you === hostSlot;
    const seats = normalizeSeats(capacity, state.seats, state.players);
    const me = state.players.find((p) => p.slot === state.you);
    const occupiedCount = seats.filter((s) => s.status === 'occupied').length;
    const everyoneReady = occupiedCount === capacity && seats.every((s) => s.status === 'occupied' && s.ready);

    const list = el('ul', { testid: 'players', className: 'players' });
    for (const seat of seats) {
      const playerNumber = seat.slot + 1;
      const colorBadge = el('span', { className: `seat-color seat-color-${playerNumber}`, testid: `seat-color-${seat.slot}` }, `P${playerNumber}`);
      if (seat.status === 'open') {
        const seatLabel = el('span', { className: 'seat-name', testid: `seat-name-${seat.slot}` }, `Seat ${playerNumber}`);
        const statusEl = el('span', { className: 'seat-status seat-status-open', testid: `seat-status-${seat.slot}` }, 'Open — Waiting for player...');
        const li = el('li', { testid: `seat-${seat.slot}`, className: 'seat-row seat-open' }, colorBadge, seatLabel, statusEl);
        li.dataset.seat = String(seat.slot);
        li.dataset.status = 'open';
        list.append(li);
        continue;
      }

      const nameEl = el('span', { className: 'seat-name', testid: `seat-name-${seat.slot}` }, seat.name ?? `Player ${playerNumber}`);
      const hostBadge = seat.slot === hostSlot ? el('span', { className: 'host-badge', testid: `host-badge-${seat.slot}` }, ' (host)') : null;
      const statusText = seat.status === 'occupied' ? (seat.ready ? 'ready' : 'not ready') : seat.status;
      const statusEl = el('span', { className: `seat-status seat-status-${seat.status}`, testid: `seat-status-${seat.slot}` }, ` - ${statusText} `);
      const civValue = seat.civ ?? 1;
      // Each player picks its own civ while it is not ready (`TribeMPSetupScreen::fillPlayers`); others see text.
      const civ =
        seat.slot === state.you && seat.status === 'occupied' && !seat.ready
          ? select(`civ-${seat.slot}`, this.label('civ'), this.civOptions(), civValue, (c) => this.session.setCiv(c))
          : el('span', { className: 'civ', testid: `civ-${seat.slot}` }, civName(this.text, civValue));
      const children: (Node | string)[] = [colorBadge, nameEl];
      if (hostBadge) children.push(hostBadge);
      children.push(statusEl, civ);
      const li = el('li', { testid: `player-${seat.slot}`, className: `seat-row seat-${seat.status}` }, ...children);
      li.dataset.seat = String(seat.slot);
      li.dataset.status = seat.status;
      list.append(li);
    }

    if (capacity === 2 && occupiedCount < 2 && state.mode !== 'single-player' && isHost && !this.bot && !this.botSpawning) {
      const addBot = el('button', { testid: 'add-bot-btn', className: 'primary' }, '🤖 Thêm Máy (Add AI Bot)');
      addBot.addEventListener('click', () => {
        addBot.disabled = true;
        this.spawnBot(state.code);
      });
      list.append(el('li', { style: 'margin-top: 0.5rem; list-style: none;' }, addBot));
    }

    const ready = el('button', { testid: 'ready', className: 'primary', disabled: !me }, me?.ready ? 'Not ready' : 'Ready');
    ready.addEventListener('click', () => {
      const versions = this.resolveVersions();
      if (versions) {
        this.session.setReady(!me?.ready, versions);
      } else {
        this.session.setReady(!me?.ready);
      }
    });
    const leave = el('button', { testid: 'leave' }, 'Leave');
    leave.addEventListener('click', () => {
      this.cleanupBot();
      this.spController.cancel();
      this.spOpen = false;
      this.createCapacity = DEFAULT_ROOM_CAPACITY;
      this.session.leave();
    });

    const inviteSection: HTMLElement[] = [];
    const inviteUrl = this.options.buildInviteUrl ? this.options.buildInviteUrl(state.code) : null;
    if (inviteUrl) {
      const inviteInput = el('input', {
        value: inviteUrl,
        readOnly: true,
        testid: 'invite-url',
        ariaLabel: 'Invite link',
        className: 'invite-url-input',
      });
      const copyBtn = el('button', { testid: 'copy-invite' }, 'Copy link');
      const statusNode = el('p', { className: 'note invite-copy-status', testid: 'copy-invite-status', hidden: !this.copyFeedback }, this.copyFeedback ?? '');
      copyBtn.addEventListener('click', () => {
        const selectInput = () => {
          inviteInput.focus();
          (inviteInput as { select?: () => void }).select?.();
        };
        if (this.options.copyInvite) {
          void this.options.copyInvite(inviteUrl).then((res) => {
            const copied = typeof res === 'boolean' ? res : res.copied;
            const msg = copied ? 'Invite link copied!' : 'Copy blocked — select and copy the link above.';
            this.copyFeedback = msg;
            statusNode.textContent = msg;
            statusNode.hidden = false;
            if (!copied) selectInput();
          });
        } else {
          selectInput();
          const msg = 'Select and copy the link above.';
          this.copyFeedback = msg;
          statusNode.textContent = msg;
          statusNode.hidden = false;
        }
      });
      inviteSection.push(el('div', { className: 'row invite-link-row' }, inviteInput, copyBtn));
      inviteSection.push(statusNode);
      if (this.options.isLocalOrigin && typeof location !== 'undefined' && location.origin && this.options.isLocalOrigin(location.origin)) {
        inviteSection.push(
          el('p', { className: 'note local-origin-warning', testid: 'local-origin-warning' }, 'Localhost link only works on this machine; use LAN or tunnel URL to invite others.'),
        );
      }
    }

    const box = el(
      'div',
      { className: 'panel' },
      el('h2', {}, 'Game lobby'),
      el('p', { className: 'invite' }, 'Invite code ', el('strong', { testid: 'invite-code' }, state.code)),
      ...inviteSection,
      list,
      this.settings(state.settings, isHost && !me?.ready),
      this.chatPanel(),
      el('div', { className: 'row' }, ready, leave),
    );
    if (isHost) {
      const start = el('button', { testid: 'start', className: 'primary', disabled: !everyoneReady }, 'Start game');
      start.addEventListener('click', () => this.session.start());
      box.append(el('div', { className: 'row' }, start));
    }
    this.appendError(box, state);
    return box;
  }

  private chatPanel(): HTMLElement {
    this.chatTitle.textContent = this.label('chat');
    return this.chat;
  }

  private label(key: keyof typeof LABELS): string {
    const [id, fallback] = LABELS[key];
    return this.text(id, fallback);
  }

  private civOptions(): [number, string][] {
    return Array.from({ length: CIV_RANDOM }, (_, i) => [i + 1, civName(this.text, i + 1)]);
  }

  /**
   * The host, while not ready, picks Random Map or Death Match, the map size, map type, victory condition, starting age,
   * resources, Path Finding, population limit, Fixed Positions, Full Tech Tree, Reveal Map and Enable Cheating (the Game
   * Settings screen, src/scr_set.cpp); otherwise
   * the setup screen's summary of them.
   */
  private settings(s: GameSettings, editable: boolean): HTMLElement {
    const box = el('div', { className: 'settings', testid: 'settings' }, el('h3', {}, this.label('settings')));
    if (!editable) {
      box.append(el('ul', { testid: 'settings-summary' }, ...summaryLines(this.text, s).map((line) => el('li', {}, line))));
      return box;
    }
    const change = (patch: Partial<GameSettings>) => this.session.setSettings({ ...this.session.state.settings, ...patch });
    const field = (key: keyof typeof LABELS, control: HTMLElement) => el('label', {}, this.label(key), control);
    // The scenario list's Random Map and Death Match lines (scr_set.cpp:616-623); picking another line selects the
    // victory drop-down's first line (`fillMissionText`, :642-644), and Death Match stores Default resources (:746-750).
    const games: [number, string][] = [0, 1].map((v) => [v, gameName(this.text, v === 1)]);
    const pickGame = (v: number) => change({ deathMatch: v === 1, victory: { type: VICTORY_STANDARD }, ...(v === 1 ? { resources: RESOURCES_DEFAULT } : {}) });
    box.append(
      field('game', select('game', this.label('game'), games, s.deathMatch ? 1 : 0, pickGame)),
      field('mapSize', select('map-size', this.label('mapSize'), LOBBY_MAP_SIZES.map((v) => [v, mapSizeName(this.text, v)]), s.mapSize, (mapSize) => change({ mapSize }))),
      field('mapType', select('map-type', this.label('mapType'), LOBBY_MAP_TYPES.map((v) => [v, mapTypeName(this.text, v)]), s.mapType, (mapType) => change({ mapType }))),
      field(
        'victory',
        select('victory', this.label('victory'), LOBBY_VICTORY_TYPES.map((v) => [v, victoryName(this.text, v)]), s.victory.type, (type) =>
          // Picking Time Limit or Score selects its default line (`TribeGameSettingsScreen::action`).
          change({ victory: type === VICTORY_TIME_LIMIT ? { type, amount: DEFAULT_TIME_LIMIT } : type === VICTORY_SCORE ? { type, amount: DEFAULT_SCORE_LIMIT } : { type } }),
        ),
      ),
    );
    const { type, amount } = s.victory;
    if (type === VICTORY_TIME_LIMIT || type === VICTORY_SCORE) {
      const options: [number, string][] =
        type === VICTORY_TIME_LIMIT ? LOBBY_TIME_LIMITS.map((v) => [v, timeLimitName(this.text, v)]) : LOBBY_SCORE_LIMITS.map((v) => [v, String(v)]);
      const pick = select('victory-amount', this.label(type === VICTORY_TIME_LIMIT ? 'timeLimit' : 'score'), options, amount ?? 0, (a) => change({ victory: { type, amount: a } }));
      box.append(field(type === VICTORY_TIME_LIMIT ? 'timeLimit' : 'score', pick));
    }
    const ages: [number, string][] = LOBBY_STARTING_AGES.map((v) => [v, ageName(this.text, v)]);
    box.append(field('startingAge', select('starting-age', this.label('startingAge'), ages, s.startingAge, (startingAge) => change({ startingAge }))));
    // Inactive in a Death Match (`activatePanels`, scr_set.cpp:786-792).
    const levels: [number, string][] = LOBBY_RESOURCES.map((v) => [v, resourcesName(this.text, v)]);
    const resources = select('resources', this.label('resources'), levels, s.resources, (v) => change({ resources: v }));
    resources.disabled = s.deathMatch;
    box.append(field('resources', resources));
    const paths: [number, string][] = LOBBY_PATH_FINDING.map((v) => [v, pathFindingName(this.text, v)]);
    box.append(field('pathFinding', select('path-finding', this.label('pathFinding'), paths, s.pathFinding, (pathFinding) => change({ pathFinding }))));
    box.append(field('fixedPositions', checkbox('fixed-positions', this.label('fixedPositions'), s.fixedPositions, (fixedPositions) => change({ fixedPositions }))));
    box.append(field('fullTechTree', checkbox('full-tech-tree', this.label('fullTechTree'), s.fullTechTree, (fullTechTree) => change({ fullTechTree }))));
    box.append(field('revealMap', checkbox('reveal-map', this.label('revealMap'), s.revealMap, (revealMap) => change({ revealMap }))));
    box.append(field('cheating', checkbox('cheating', this.label('cheating'), s.cheating, (cheating) => change({ cheating }))));
    // The dialog's numbers, "25" .. "200" (scr_set.cpp:189-192).
    const limits: [number, string][] = LOBBY_POPULATION_LIMITS.map((v) => [v, String(v)]);
    box.append(field('populationLimit', select('population-limit', this.label('populationLimit'), limits, s.populationLimit, (populationLimit) => change({ populationLimit }))));
    return box;
  }

  private appendError(box: HTMLElement, state: LobbyState): void {
    if (!state.error) return;
    const text = ERROR_TEXT[state.error.code] ?? state.error.message;
    box.append(el('p', { role: 'alert', className: 'error', testid: 'error' }, text));
  }
}
