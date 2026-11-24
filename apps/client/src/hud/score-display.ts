// The in-game score (`TRIBE_Screen_Game::command_score`, `reset_score_display`, src/scr_game.cpp:3286, 3991): F4 or
// the score button shows or hides it. Eight 200 x 20 lines stacked up from 4 pixels above the main view's bottom right
// corner, each "name: score/team score", sorted best team first; refreshed every 3 s while shown. A defeated player's
// line is struck out. In a multiplayer game a human player's line has the latency and slow-player icons left of its
// text (scr_game.cpp:3360-3478, pnl_msg.cpp:467-487).
import { STATUS_LOST, type World } from '@aoe/sim';
import type { ImageFrame } from '../assets';
import { FONT, placed, textColours } from './easy-panel';
import { paintFrame } from './frame-image';

const LINES = 8;
/** `score_interval`. */
const REFRESH_MS = 3000;
/** Text colour and second colour by colour table (scr_game.cpp:3398-3438), Windows COLORREFs (0x00BBGGRR). */
export const COLOURS: [number, number][] = [
  [0xff0000, 0xb3b3b3],
  [0x2139c6, 0],
  [0xffff, 0],
  [0x4f73a3, 0],
  [0x0f77f3, 0],
  [0xc700, 0],
  [0x7b90a2, 0],
  [0xadad00, 0],
];

export const colorref = (c: number) => `rgb(${c & 0xff}, ${(c >> 8) & 0xff}, ${(c >> 16) & 0xff})`;

/** A line of the score display. */
export interface ScoreLine {
  player: number;
  text: string;
  struck: boolean;
}

/**
 * The lines in their order: `scr_game_score_compare` sorts by team score, then team id, then score, then player id,
 * all from the highest. Without allied victory each player is its own team, numbered in player order.
 */
export function scoreLines(world: World, names: readonly string[]): ScoreLine[] {
  const rows = Array.from({ length: world.players - 1 }, (_, i) => {
    const player = i + 1;
    const score = Math.trunc(world.victory.totals[player] ?? 0);
    return { player, team: player, score };
  });
  rows.sort((a, b) => b.score - a.score || b.team - a.team || b.player - a.player);
  return rows.map((r) => ({ player: r.player, text: `${names[r.player] ?? ''}: ${r.score}/${r.score}`, struck: world.playerStatus(r.player) === STATUS_LOST }));
}

/** `button_pics` (`btn6`) frames: the slow player, latency 300-1000 ms, latency past 1000 ms. */
export const ICON_SLOW = 17;
export const ICON_LATENCY = 19;
export const ICON_HIGH_LATENCY = 20;

/** What the score display reads of the relay: this client's player, the round trips and frame times by slot. */
export interface ScoreNet {
  player: number;
  /** The server's round trip to each slot and each slot's mean frame time, ms (`Lockstep.rtt`, `frameTimes`). */
  status(): { rtt: readonly number[]; frameMs: readonly number[] };
  /** Has the server dropped player `p` (no longer `ME_HUMAN`)? */
  dropped(p: number): boolean;
  /** Frame `frame` of the player's culture's `btn6`, or null without a pack. */
  icon(frame: number): ImageFrame | null;
}

/**
 * The icons of each line's player, `[latency frame, slow frame]` (0: none), for `order` the players in line order. The
 * latency to a player is the round trip between this client and it: through the relay the sum of both legs, kept in
 * [30, 6000] ms as `SetActualLatency` keeps it; this client's own stays the initial 30 (com_spd.cpp:34, 71-79). Above
 * 299 ms it shows frame 20, frame 19 while also below 1001. The slow icon goes to the first player in line order with
 * the lowest frame rate, `1000 / frameMs` (100 under 10 ms, 1 from 1000 ms), when that is under 11 fps.
 */
export function netIcons(order: readonly number[], me: number, rtt: readonly number[], frameMs: readonly number[], human: (p: number) => boolean): Map<number, [number, number]> {
  let slow = 0;
  let best = 11;
  for (const p of order) {
    if (!human(p)) continue;
    const ms = frameMs[p - 1] ?? 0;
    const fps = ms >= 1000 ? 1 : ms < 10 ? 100 : Math.trunc(1000 / ms);
    if (fps < best) {
      slow = p;
      best = fps;
    }
  }
  const icons = new Map<number, [number, number]>();
  for (const p of order) {
    if (!human(p)) continue;
    const latency = p === me ? 30 : Math.min(6000, Math.max(30, (rtt[me - 1] ?? 0) + (rtt[p - 1] ?? 0)));
    icons.set(p, [latency > 299 ? (latency < 1001 ? ICON_LATENCY : ICON_HIGH_LATENCY) : 0, p === slow ? ICON_SLOW : 0]);
  }
  return icons;
}

export class ScoreDisplay {
  private readonly lines: HTMLDivElement[];
  private shown = false;
  private refreshedAt = -Infinity;
  /** The icons and struck-out lines drawn at the last refresh, to see a change in between. */
  private netKey = '';
  private readonly onKey = (e: KeyboardEvent) => {
    // Unmodified F4 (Shift+F4 is a formation, `GameHud.commandFormation`).
    if (e.key !== 'F4' || e.shiftKey || e.ctrlKey || e.altKey || e.metaKey) return;
    e.preventDefault();
    this.toggle();
  };

  constructor(
    view: HTMLElement,
    private readonly world: World,
    private readonly names: readonly string[],
    private readonly net?: ScoreNet,
  ) {
    this.lines = Array.from({ length: LINES }, (_, i) => {
      const el = placed(view, 'div', 'aoe-text hud-score-line', 0, 0, 200, 20);
      Object.assign(el.style, { left: '', top: '', right: '4px', bottom: `${4 + 20 * (LINES - 1 - i)}px` });
      el.dataset.testid = 'score-line';
      el.hidden = true;
      // Slow icon, latency icon, text: each icon 4 px left of what follows it, the text's used rectangle 3 px wider.
      for (const kind of ['slow', 'latency']) {
        const icon = document.createElement('span');
        icon.className = 'hud-score-icon';
        icon.dataset.testid = `score-${kind}`;
        icon.hidden = true;
        el.append(icon);
      }
      el.append(document.createElement('span'));
      return el;
    });
    window.addEventListener('keydown', this.onKey);
  }

  get visible(): boolean {
    return this.shown;
  }

  /** `command_score(!score_displayed)`. */
  toggle(): void {
    this.shown = !this.shown;
    if (this.shown) this.refresh();
    else for (const el of this.lines) el.hidden = true;
  }

  /**
   * Every 3 s (`score_interval`); also at once when a player's icons or struck-out line change, so a player that slows
   * down or drops shows within a turn or two of the server's news rather than up to 3 s later (the port's addition).
   */
  update(now = performance.now()): void {
    if (!this.shown) return;
    if (now - this.refreshedAt >= REFRESH_MS || this.netKey !== this.netState(scoreLines(this.world, this.names)).key) this.refresh(now);
  }

  /** The lines shown now, top first (for the tests). */
  get texts(): string[] {
    return this.lines.flatMap((el) => (el.hidden ? [] : [el.textContent ?? '']));
  }

  destroy(): void {
    window.removeEventListener('keydown', this.onKey);
  }

  private refresh(now = performance.now()): void {
    this.refreshedAt = now;
    const lines = scoreLines(this.world, this.names);
    const { icons, key } = this.netState(lines);
    this.netKey = key;
    this.lines.forEach((el, i) => {
      const line = lines[i];
      el.hidden = !line;
      if (!line) return;
      const [slow, latency, text] = el.children as unknown as [HTMLElement, HTMLElement, HTMLElement];
      text.textContent = line.text;
      const [latencyFrame, slowFrame] = icons?.get(line.player) ?? [0, 0];
      this.paintIcon(latency, latencyFrame);
      this.paintIcon(slow, slowFrame);
      el.className = `aoe-text hud-score-line ${line.struck || this.net?.dropped(line.player) ? FONT.strikeout : FONT.standard}`;
      const [c1, c2] = COLOURS[line.player - 1] ?? [0xffffff, 0];
      textColours(el, [colorref(c1), colorref(c2)]);
    });
  }

  /** The icons of `lines`' players and a key of them with the dropped/struck players. */
  private netState(lines: readonly ScoreLine[]): { icons: Map<number, [number, number]> | null; key: string } {
    const net = this.net;
    const status = net?.status();
    if (!net || !status) return { icons: null, key: lines.map((l) => `${l.player}:${l.struck ? 1 : 0}`).join(' ') };
    const icons = netIcons(lines.map((l) => l.player), net.player, status.rtt, status.frameMs, (p) => !net.dropped(p));
    const key = lines.map((l) => `${l.player}:${icons.get(l.player)?.join(',') ?? ''}:${net.dropped(l.player) ? 1 : 0}:${l.struck ? 1 : 0}`).join(' ');
    return { icons, key };
  }

  /** `show_message2`'s icon: its frame `shape_draw`n 6 px below the line's top (pnl_msg.cpp:467-487). */
  private paintIcon(el: HTMLElement, frame: number): void {
    const art = frame && this.net ? this.net.icon(frame) : null;
    el.hidden = frame === 0;
    el.dataset.frame = String(frame);
    paintFrame(el, art);
    el.style.width = art ? `${art.w}px` : '16px';
    el.style.height = art ? `${art.h}px` : '8px';
  }
}
