// The Diplomacy button's dialog (`TribeDiplomacyDialog`, src/dlg_dip.cpp; docs/spec/diplomacy.md §7) and the
// notifications the stance and tribute commands make (`TRIBE_Game::notification`, src/tribegam.cpp:1857-1903): a row per
// player with its colour bar, name and civilization, the Ally / Neutral / Enemy radio buttons for every other player,
// the tribute buttons and this player's stock while it has a Market, the Allied Victory check box and OK / Clear
// Tributes / Cancel. Modal, centred, in the in-game dialogs' look (`dlg6_<culture>`).
import {
  MARKET,
  NOTIFY_DIPLOMACY_CHANGED,
  NOTIFY_TRIBUTE_PAID,
  ObjectState,
  RELATION_ALLY,
  RELATION_ENEMY,
  RELATION_NEUTRAL,
  ATTR_TRIBUTE_FEE,
  TECH_DONE,
  type Command,
  type World,
} from '@aoe/sim';
import type { AssetProvider } from '../assets';
import { CHECK_FRAMES, label, PictureButton, PLAYER_BAR, RADIO_FRAMES } from './chat';
import { bevel3, easyButton, FONT, GAME_DIALOG_INFO, lookOf, paintPanel, placed, textColours, type PanelLook } from './easy-panel';
import { paintFrame } from './frame-image';
import { Modal } from './menu';

/** `STRING_ID_DIPLOMACY_*` (include/resource_ids.h:144-153) and `STRING_ID_BUTTON_OK`, `_CANCEL`, `_HELP`. */
export const STRING_DIPLOMACY = {
  title: 0x267b,
  civilization: 0x267c,
  ally: 0x267d,
  neutral: 0x267e,
  enemy: 0x267f,
  payTribute: 0x2680,
  alliedVictory: 0x2681,
  clearTributes: 0x2683,
  name: 0x2686,
  needMarket: 0x2687,
  ok: 4001,
  cancel: 4002,
  help: 4009,
} as const;
/** `STRING_ID_MESSAGE_TRIBUTE_FOOD`, `_WOOD`, `_STONE`, `_GOLD` by resource: "%s paid %d food in tribute to you." */
const MESSAGE_TRIBUTE = [0xbc8, 0xbc7, 0xbc9, 0xbc1];
/** `STRING_ID_MESSAGE_DIPLOMACY_ALLY`, `_NEUTRAL`, `_ENEMY` by stance: "%s changed diplomatic stance with you to Ally." */
const MESSAGE_DIPLOMACY: Record<number, number> = { [RELATION_ALLY]: 0xbd2, [RELATION_NEUTRAL]: 0xbd1, [RELATION_ENEMY]: 0xbd3 };
/** `TRIBE_Game::sounds[4]`, tribute.wav: a tribute received (src/tribegam.cpp:1859). */
export const SOUND_TRIBUTE = 4;
/** `tradicon.shp` (0xC62C): the tribute buttons' resource pictures. */
const TRADE_ICONS = 0xc62c;
/** Coinage (tech 30): once researched the fee text is hidden (src/dlg_dip.cpp:322-324). */
const TECH_COINAGE = 30;
/** `g_diplomacy_attribute_percent_scale` (src/game_globals.cpp:216): the fee shown as a percent. */
const PERCENT_SCALE = 100;
/** What one tribute click adds (src/dlg_dip.cpp:557-678). */
const TRIBUTE_STEP = 100;
const DIALOG = { w: 625, h: 405 };
const ROW_TOP = 80;
const ROW_HEIGHT = 30;
/**
 * The tribute columns left to right: wood, food, gold, stone, their resource, `tradicon` frame and button x
 * (src/dlg_dip.cpp:201-218); this player's stock shows in the same columns on its own row (:277-300).
 */
const COLUMNS = [
  { resource: 1, frame: 0, x: 440, name: 'wood' },
  { resource: 0, frame: 2, x: 480, name: 'food' },
  { resource: 3, frame: 3, x: 520, name: 'gold' },
  { resource: 2, frame: 1, x: 560, name: 'stone' },
] as const;
/** OK sends the tributes in this resource order: gold, wood, food, stone (src/dlg_dip.cpp:457-482). */
const SEND_ORDER = [3, 1, 0, 2];

const f = Math.fround;

/** `sprintf(format, ...)` of a language string: `%s` and `%d` take the values in turn, `%%` is a percent sign. */
function sprintf(format: string, ...values: (string | number)[]): string {
  let i = 0;
  return format.replace(/%[sd%]/g, (m) => (m === '%%' ? '%' : String(values[i++] ?? '')));
}

export interface DiplomacyOptions {
  parent: HTMLElement;
  provider: AssetProvider;
  world: World;
  /** This client's player number. */
  player: number;
  /** Player names by player number. */
  names: readonly string[];
  /** Struck out (`RGE_FONT_STRIKEOUT`): defeated, or no longer in the game (src/dlg_dip.cpp:133-150). */
  out(p: number): boolean;
  /** The game over mode (`ProgModeGameOver`): every button disabled, no OK or Clear Tributes. */
  gameOver(): boolean;
  /** Civilization name of player `p`. */
  civ(p: number): string;
  /** Send a command through the lockstep. */
  issue(command: Command): void;
  /** A button's click. */
  click(): void;
}

/** A tribute button (`create_button` + `set_picture`, `DrawPictureAndText`): the resource picture, the amount over it. */
class TributeButton {
  readonly el: HTMLButtonElement;
  private readonly text: HTMLDivElement;
  private off = false;

  constructor(parent: HTMLElement, provider: AssetProvider, private readonly look: PanelLook, x: number, y: number, frame: number, testid: string, run: () => void) {
    this.el = placed(parent, 'button', `aoe-button aoe-picture-button ${FONT.standard}`, x, y, 40, ROW_HEIGHT);
    this.el.dataset.testid = testid;
    this.el.tabIndex = -1;
    const icon = provider.interfaceFrame(TRADE_ICONS, frame);
    if (icon) {
      // `auto_pic_pos`: the picture centred in the button.
      const pic = placed(this.el, 'div', 'aoe-picture', 20 - Math.trunc(icon.w / 2), 15 - Math.trunc(icon.h / 2), icon.w, icon.h);
      paintFrame(pic, icon);
    }
    this.text = placed(this.el, 'div', `aoe-text ${FONT.standard}`, 0, 0, 40, ROW_HEIGHT);
    Object.assign(this.text.style, { display: 'flex', alignItems: 'center', justifyContent: 'center', pointerEvents: 'none' });
    textColours(this.text, look.text);
    this.el.addEventListener('mousedown', (e) => e.preventDefault());
    this.el.addEventListener('click', () => !this.off && run());
    this.paint();
  }

  set label(text: string) {
    this.text.textContent = text;
  }

  get label(): string {
    return this.text.textContent ?? '';
  }

  /** `set_disabled`: two plain rectangles instead of the bevel, and no click. */
  set disabled(off: boolean) {
    this.off = off;
    this.el.dataset.disabled = off ? '1' : '0';
    this.paint();
  }

  private paint(): void {
    const c = this.look.bevels;
    this.el.style.boxShadow = this.off ? `inset 0 0 0 1px ${c[5]}, inset 0 0 0 2px ${c[0]}` : bevel3(c);
  }
}

/** A tribute row: the other player's buttons and amounts by resource. */
interface TributeRow {
  player: number;
  buttons: Map<number, TributeButton>;
  amounts: Map<number, number>;
}

export class DiplomacyDialog {
  private modal: Modal | null = null;
  /** The open dialog's `check_*` for a resource, its totals and this player's stock texts. */
  private check: (resource: number) => boolean = () => true;
  private totals = new Map<number, number>();
  private stockText = new Map<number, HTMLDivElement>();

  constructor(private readonly o: DiplomacyOptions) {}

  get open(): boolean {
    return this.modal !== null;
  }

  close(): void {
    this.modal?.close();
    this.modal = null;
  }

  /** The player has an active Market (master 0x54): tribute is enabled (src/dlg_dip.cpp:302-320). */
  private hasMarket(): boolean {
    for (const e of this.o.world.entities.ofPlayer(this.o.player)) if (e.type === MARKET && e.state === ObjectState.Active) return true;
    return false;
  }

  /**
   * `TribeDiplomacyDialog::TribeDiplomacyDialog` (src/dlg_dip.cpp:16-345): 625 x 405, the headers at y 50, a row per
   * player 30 high from y 80, Allied Victory at (282, 327), OK, Clear Tributes and Cancel (Esc) at y 367.
   */
  show(): void {
    if (this.modal) return;
    const { provider, world, player, click } = this.o;
    const over = this.o.gameOver();
    const look = lookOf(provider, GAME_DIALOG_INFO);
    const modal = new Modal(this.o.parent, DIALOG.w, DIALOG.h, 'diplomacy', () => {
      click();
      this.close();
    });
    this.modal = modal;
    const panel = modal.panel;
    paintPanel(panel, look);
    const text = (id: number) => provider.string(id) ?? '';
    const title = label(panel, look, text(STRING_DIPLOMACY.title), FONT.copper21, 72, 5, 500, 30, true);
    title.dataset.testid = 'diplomacy-title';
    const needMarket = label(panel, look, text(STRING_DIPLOMACY.needMarket), FONT.standard, 440, 110, 175, 60, true);
    needMarket.classList.add('wrap');
    needMarket.style.textAlign = 'center';
    needMarket.style.whiteSpace = 'normal';
    needMarket.dataset.testid = 'diplomacy-need-market';
    label(panel, look, text(STRING_DIPLOMACY.name), FONT.standard, 5, 50, 130, 30, false);
    label(panel, look, text(STRING_DIPLOMACY.civilization), FONT.standard, 137, 50, 80, 30, false);
    label(panel, look, text(STRING_DIPLOMACY.ally), FONT.standard, 235, 50, 70, 30, false);
    label(panel, look, text(STRING_DIPLOMACY.neutral), FONT.standard, 290, 50, 70, 30, false);
    label(panel, look, text(STRING_DIPLOMACY.enemy), FONT.standard, 360, 50, 70, 30, false);
    const attributes = () => world.attributes[player]!;
    const fee = f(attributes()[ATTR_TRIBUTE_FEE] ?? 0);
    const feeText = label(panel, look, sprintf(text(STRING_DIPLOMACY.payTribute), Math.trunc(f(fee * PERCENT_SCALE))), FONT.standard, 440, 50, 180, 30, false);
    feeText.dataset.testid = 'diplomacy-fee';
    label(panel, look, text(STRING_DIPLOMACY.alliedVictory), FONT.standard, 318, 330, 300, 30, false);

    // `woodTotal` .. `goldTotal`: what the amounts chosen so far take from the stock, fee included.
    const totals = new Map<number, number>(COLUMNS.map((c) => [c.resource, 0]));
    const radios: { player: number; buttons: PictureButton[] }[] = [];
    const rows: TributeRow[] = [];
    const ownRow = player - 1;
    for (let p = 1; p < world.players; p++) {
      const row = p - 1;
      const y = ROW_TOP + ROW_HEIGHT * row;
      // `draw`: `dlg_plbn` at (10, 80 + 30 * row) in the player's colour.
      const frame = provider.interfaceFrame(PLAYER_BAR, 0, p);
      if (frame) {
        const bar = placed(panel, 'div', 'chat-player-bar', 10 - frame.hotspotX, y - frame.hotspotY, frame.w, frame.h);
        paintFrame(bar, frame);
      }
      label(panel, look, this.o.names[p] ?? '', this.o.out(p) ? FONT.strikeout : FONT.standard, 5, y, 130, 30, false).dataset.testid = 'diplomacy-player-name';
      label(panel, look, this.o.civ(p), FONT.standard, 137, y, 100, 30, false).dataset.testid = 'diplomacy-player-civ';
      if (p !== player) {
        const buttons: PictureButton[] = [];
        const pick = (i: number) => buttons.forEach((b, j) => (b.state = i === j));
        [240, 310, 380].forEach((x, i) => {
          const b = new PictureButton(panel, provider, look, x, y, RADIO_FRAMES, `diplomacy-${['ally', 'neutral', 'enemy'][i]}-${p}`, () => {
            click();
            pick(i);
          });
          b.el.tabIndex = -1;
          b.el.addEventListener('mousedown', (e) => e.preventDefault());
          b.el.disabled = over;
          buttons.push(b);
        });
        const r = world.relation(player, p);
        pick(r === RELATION_ALLY ? 0 : r === RELATION_NEUTRAL ? 1 : 2);
        radios.push({ player: p, buttons });
      }
      // No tribute buttons in the game over mode, on this player's row, or for a player out of the game (:124-131).
      if (over || p === player || this.o.out(p) || world.playerStatus(p) !== 0) continue;
      const tribute: TributeRow = { player: p, buttons: new Map(), amounts: new Map(COLUMNS.map((c) => [c.resource, 0])) };
      for (const c of COLUMNS) {
        tribute.buttons.set(c.resource, new TributeButton(panel, provider, look, c.x, y, c.frame, `diplomacy-tribute-${c.name}-${p}`, () => this.tribute(tribute, c.resource)));
      }
      rows.push(tribute);
    }

    // This player's stock less what the amounts take, in the tribute columns of its own row.
    const stockText = new Map<number, HTMLDivElement>();
    for (const c of COLUMNS) {
      const el = label(panel, look, String(Math.trunc(f(attributes()[c.resource]! - totals.get(c.resource)!))), FONT.standard, c.x, ROW_TOP + ROW_HEIGHT * ownRow, 40, 30, false);
      el.dataset.testid = `diplomacy-stock-${c.name}`;
      stockText.set(c.resource, el);
    }
    const market = this.hasMarket();
    needMarket.hidden = market;
    feeText.hidden = !market || world.techs[player]?.[TECH_COINAGE] === TECH_DONE;
    for (const el of stockText.values()) el.hidden = !market;

    // `check_gold` .. `check_stone`: a resource's buttons are disabled with nothing left to give (always in the game
    // over mode), and shown only with a Market. Returns 1 when disabled.
    const check = (resource: number): boolean => {
      const none = over || f(attributes()[resource]! - totals.get(resource)!) <= 0;
      for (const r of rows) {
        const b = r.buttons.get(resource)!;
        b.disabled = none;
        b.el.hidden = !market;
      }
      return none;
    };
    this.check = check;
    this.totals = totals;
    this.stockText = stockText;
    for (const c of COLUMNS) check(c.resource);

    const alliance = new PictureButton(panel, provider, look, 282, 327, CHECK_FRAMES, 'diplomacy-allied-victory', () => {
      click();
      alliance.state = !alliance.state;
    });
    alliance.el.tabIndex = -1;
    alliance.el.addEventListener('mousedown', (e) => e.preventDefault());
    alliance.state = world.diplomacy.alliedVictory[player] ?? false;
    alliance.el.disabled = over;

    // `action` (src/dlg_dip.cpp:426-500): the flag and every changed stance, then each row's tributes, then close.
    const ok = () => {
      const { issue } = this.o;
      if (alliance.state !== (world.diplomacy.alliedVictory[player] ?? false)) issue({ type: 'allied-victory', on: alliance.state });
      for (const { player: p, buttons } of radios) {
        const relation = buttons[0]!.state ? RELATION_ALLY : buttons[1]!.state ? RELATION_NEUTRAL : RELATION_ENEMY;
        if (world.relation(player, p) !== relation) issue({ type: 'relation', player: p, relation });
        const row = rows.find((r) => r.player === p);
        for (const resource of SEND_ORDER) {
          const amount = row?.amounts.get(resource) ?? 0;
          if (amount > 0) issue({ type: 'tribute', player: p, resource, amount });
        }
      }
      this.close();
    };
    const clear = () => {
      for (const c of COLUMNS) totals.set(c.resource, 0);
      for (const r of rows) {
        for (const b of r.buttons.values()) b.label = '';
        for (const c of COLUMNS) r.amounts.set(c.resource, 0);
      }
      for (const c of COLUMNS) stockText.get(c.resource)!.textContent = String(Math.trunc(attributes()[c.resource]!));
      for (const c of COLUMNS) check(c.resource);
    };
    const focusable: HTMLButtonElement[] = [];
    if (!over) {
      const okButton = easyButton(panel, look, { x: 10, y: 367, w: 190, h: 30 }, text(STRING_DIPLOMACY.ok), FONT.copper12, ok, click);
      okButton.dataset.testid = 'diplomacy-ok';
      const clearButton = easyButton(panel, look, { x: 215, y: 367, w: 190, h: 30 }, text(STRING_DIPLOMACY.clearTributes), FONT.copper12, clear, click);
      clearButton.dataset.testid = 'diplomacy-clear';
      focusable.push(okButton, clearButton);
    }
    const cancel = easyButton(panel, look, { x: 420, y: 367, w: 190, h: 30 }, text(STRING_DIPLOMACY.cancel), FONT.copper12, () => this.close(), click);
    cancel.dataset.testid = 'diplomacy-cancel';
    focusable.push(cancel);
    // Help (`setup_popup_help`) has no port: disabled, as the menu's Help.
    easyButton(panel, look, { x: 500, y: 327, w: 30, h: 30 }, text(STRING_DIPLOMACY.help), FONT.copper12, null).tabIndex = -1;
    // `set_curr_child(okButton)` and the tab order OK, Clear Tributes, Cancel: Enter or Space presses the focused one.
    focusable[0]!.focus();
  }

  /**
   * A tribute button's click (src/dlg_dip.cpp:557-678): with some of the resource left, 100 more when 100 and its fee
   * are left, else what is left less its fee; the button shows the amount and the stock what is left.
   */
  private tribute(row: TributeRow, resource: number): void {
    const a = this.o.world.attributes[this.o.player]!;
    const fee = f(a[ATTR_TRIBUTE_FEE] ?? 0);
    let cost = fee > 0 ? fee : 0;
    const total = this.totals.get(resource)!;
    const stock = this.stockText.get(resource)!;
    this.o.click();
    if (!this.check(resource)) {
      cost = f(cost + 1);
      const left = f(a[resource]! - total);
      let amount: number;
      if (!(left < f(cost * TRIBUTE_STEP))) {
        amount = TRIBUTE_STEP;
        this.totals.set(resource, f(total + f(cost * TRIBUTE_STEP)));
      } else {
        amount = f(left / cost);
        this.totals.set(resource, f(total + f(amount * cost)));
      }
      const sum = f(row.amounts.get(resource)! + amount);
      row.amounts.set(resource, sum);
      stock.textContent = String(Math.trunc(f(a[resource]! - this.totals.get(resource)!)));
      row.buttons.get(resource)!.label = String(Math.trunc(sum));
    } else {
      const left = f(a[resource]! - total);
      stock.textContent = String(Math.trunc(left >= 0 ? left : 0));
    }
    this.check(resource);
  }
}

/** A notification's chat line and whether it plays tribute.wav. */
export interface DiplomacyNotice {
  text: string;
  tribute: boolean;
}

/**
 * The notifications for `me` in the sim's log from entry `from` on (`TRIBE_Game::notification`,
 * src/tribegam.cpp:1857-1903; `World.log`, victory.md §16): `GAME_NOTIFY_DIPLOMACY_CHANGED` when another player set its
 * stance towards `me` (src/tcommand.cpp:373; no sound), `GAME_NOTIFY_TRIBUTE_PAID` when another player's tribute reached
 * `me` (src/tcommand.cpp:482; tribute.wav), with the amount received (`(long) tribute_amount`) as the sim logged it.
 */
export function diplomacyNotices(world: World, me: number, from: number, provider: AssetProvider, names: readonly string[]): DiplomacyNotice[] {
  const notices: DiplomacyNotice[] = [];
  for (const { type, args } of world.log.notifications.slice(from)) {
    const [sender, to, value, amount] = args;
    if (to !== me) continue;
    if (type === NOTIFY_DIPLOMACY_CHANGED) {
      notices.push({ text: sprintf(provider.string(MESSAGE_DIPLOMACY[value]!) ?? '', names[sender] ?? ''), tribute: false });
    } else if (type === NOTIFY_TRIBUTE_PAID) {
      notices.push({ text: sprintf(provider.string(MESSAGE_TRIBUTE[value]!) ?? '', names[sender] ?? '', amount), tribute: true });
    }
  }
  return notices;
}
