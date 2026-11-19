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
import { AiBot } from '../bot/ai-bot';

const ERROR_TEXT: Record<string, string> = {
  'bad-code': 'No game with that invite code.',
  'room-full': 'That game is full.',
  'room-started': 'That game has already started.',
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

/** A drop-down of `options` ([value, label]) showing `value`; `onPick` gets the picked value. */
function select(testid: string, label: string, options: [number, string][], value: number, onPick: (v: number) => void): HTMLSelectElement {
  const node = el('select', { ariaLabel: label, testid });
  for (const [v, text] of options) node.append(el('option', { value: String(v), selected: v === value }, text));
  node.addEventListener('change', () => onPick(Number(node.value)));
  return node;
}

/** A check box showing `value`; `onPick` gets the new state. */
function checkbox(testid: string, label: string, value: boolean, onPick: (v: boolean) => void): HTMLInputElement {
  const node = el('input', { type: 'checkbox', ariaLabel: label, testid, checked: value });
  node.addEventListener('change', () => onPick(node.checked));
  return node;
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
  private text: Text = englishText;
  private bot: AiBot | null = null;
  private autoSinglePlayer = false;
  /** The room's chat, kept across redraws: the box of lines and the input. */
  private readonly chatLog = el('div', { className: 'chat-log', testid: 'lobby-chat' });
  private readonly chatInput = el('input', { maxLength: CHAT_LENGTH, testid: 'lobby-chat-input', ariaLabel: 'Chat', autocomplete: 'off' });
  private readonly chatTitle = el('h3', {});
  private readonly chat = el('div', { className: 'chat' }, this.chatTitle, this.chatLog, this.chatInput);
  private inRoom = false;

  constructor(private readonly session: Session) {
    session.onChange = (state) => this.render(state);
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
  }

  render(state: LobbyState): void {
    this.root.hidden = state.phase === 'playing';
    // A new setup screen starts with an empty chat (`chat->ClearChat()`, src/scr_mps.cpp:52).
    if (state.phase === 'lobby' && !this.inRoom) this.chatLog.replaceChildren();
    this.inRoom = state.phase === 'lobby';

    if (state.phase === 'ended') {
      if (this.bot) {
        this.bot.destroy();
        this.bot = null;
      }
      this.autoSinglePlayer = false;
    }

    if (state.phase === 'lobby' && this.autoSinglePlayer) {
      if (!this.bot && state.players.length === 1) {
        AiBot.spawn(state.code, 'Computer (Hard)', Math.floor(Math.random() * 16) + 1).then((b) => {
          this.bot = b;
        });
      }
      const me = state.players.find((p) => p.slot === state.you);
      if (me && !me.ready) {
        this.session.setReady(true);
      }
      const everyoneReady = state.players.length === 2 && state.players.every((p) => p.ready);
      if (everyoneReady && state.you === 0) {
        this.autoSinglePlayer = false;
        setTimeout(() => this.session.start(), 300);
      }
    }

    // The chat moves into the new panel; typing in it goes on.
    const typing = document.activeElement === this.chatInput;
    this.root.replaceChildren(state.phase === 'lobby' ? this.room(state) : this.entry(state));
    if (typing && this.chatInput.isConnected) this.chatInput.focus();
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
      this.autoSinglePlayer = true;
      this.session.create(this.name);
    });

    const name = el('input', { value: this.name, maxLength: 24, testid: 'name', ariaLabel: 'Your name', placeholder: 'Your name' });
    name.addEventListener('input', () => (this.name = name.value.trim() || 'Player'));
    const code = el('input', { maxLength: 12, placeholder: 'Invite code', testid: 'code', ariaLabel: 'Invite code' });
    const create = el('button', { testid: 'create' }, 'Tạo phòng (Create)');
    create.addEventListener('click', () => this.session.create(this.name));
    const join = el('button', { testid: 'join' }, 'Vào phòng (Join)');
    join.addEventListener('click', () => this.session.join(code.value, this.name));

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
      el('div', { className: 'row' }, create),
      el('p', { className: 'or' }, 'hoặc nhập mã phòng để vào chơi cùng bạn bè'),
      el('div', { className: 'row' }, code, join),
    );
    if (state.phase === 'ended') box.append(el('p', { className: 'note', testid: 'ended' }, 'The game ended.'));
    this.appendError(box, state);
    return box;
  }

  private room(state: LobbyState): HTMLElement {
    const me = state.players.find((p) => p.slot === state.you);
    const host = state.you === 0;
    const everyoneReady = state.players.length === 2 && state.players.every((p) => p.ready);
    const list = el('ul', { testid: 'players', className: 'players' });
    for (const p of state.players) {
      // Each player picks its own civ while it is not ready (`TribeMPSetupScreen::fillPlayers`); the other's is text.
      const civ =
        p.slot === state.you && !p.ready
          ? select(`civ-${p.slot}`, this.label('civ'), this.civOptions(), p.civ, (c) => this.session.setCiv(c))
          : el('span', { className: 'civ', testid: `civ-${p.slot}` }, civName(this.text, p.civ));
      list.append(el('li', { testid: `player-${p.slot}` }, `${p.name}${p.slot === 0 ? ' (host)' : ''} - ${p.ready ? 'ready' : 'not ready'} `, civ));
    }
    if (state.players.length < 2) {
      list.append(el('li', {}, 'Waiting for a second player...'));
      if (host && !this.bot) {
        const addBot = el('button', { testid: 'add-bot-btn', className: 'primary' }, '🤖 Thêm Máy (Add AI Bot)');
        addBot.addEventListener('click', () => {
          if (!this.bot) {
            AiBot.spawn(state.code, 'Computer (Hard)', Math.floor(Math.random() * 16) + 1).then((b) => {
              this.bot = b;
            });
          }
        });
        list.append(el('li', { style: 'margin-top: 0.5rem; list-style: none;' }, addBot));
      }
    }
    const ready = el('button', { testid: 'ready', className: 'primary' }, me?.ready ? 'Not ready' : 'Ready');
    ready.addEventListener('click', () => this.session.setReady(!me?.ready));
    const leave = el('button', { testid: 'leave' }, 'Leave');
    leave.addEventListener('click', () => {
      if (this.bot) {
        this.bot.destroy();
        this.bot = null;
      }
      this.session.leave();
    });
    const box = el(
      'div',
      { className: 'panel' },
      el('h2', {}, 'Game lobby'),
      el('p', { className: 'invite' }, 'Invite code ', el('strong', { testid: 'invite-code' }, state.code)),
      list,
      this.settings(state.settings, host && !me?.ready),
      this.chatPanel(),
      el('div', { className: 'row' }, ready, leave),
    );
    if (host) {
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
