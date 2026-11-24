import { expect, type Browser, type BrowserContext, type Page } from '@playwright/test';
import {
  ARCHERY_RANGE,
  BARRACKS,
  BOWMAN,
  BUILDER,
  CIV_RANDOM,
  CLUBMAN,
  CrtRand,
  DEFAULT_GAME_SETTINGS,
  FARM,
  FORAGE,
  FORAGER,
  GAZELLE,
  GRANARY,
  HOUSE,
  HUNTER,
  LUMBERJACK,
  MAP_CONTINENTAL,
  MAP_HILLY,
  MAP_LARGE,
  MAP_MEDIUM,
  MAP_MOSTLY_LAND,
  MARKET,
  MINE_GOLD,
  MINE_STONE,
  MINER_GOLD,
  MINER_STONE,
  SCOUT,
  SLINGER,
  SMALL_WALL,
  STABLE,
  STORAGE_PIT,
  TOOL_AGE,
  TOWN_CENTER,
  TREES,
  VICTORY_SCORE,
  VILLAGER,
  World,
  lobbyWorldOptions,
  type Command,
  type GameSettings,
  type ReplayLog,
  type SpeedChange,
} from '@aoe/sim';

/** Three fixed seeds for reproducible 4-player soak coverage (`A06`). */
export const SOAK4_DEFAULT_SEEDS = [20260401, 20260402, 20260403] as const;

export const SOAK4_PLAYER_NAMES = ['Alice', 'Bob', 'Carol', 'Dave'] as const;

/** Turns between two rounds of commands (~1s of game time per turn). */
export const SOAK4_ROUND_TURNS = 2;

/** Stall deadline per turn wait (ms); high enough for loaded CI/host machines without masking real stalls. */
export const SOAK4_STALL_MS = 180_000;

/** Safety cap against degenerate zero-duration game loops. */
export const SOAK4_MAX_GAMES_PER_SEED = 60;

/** Forced disconnect hold duration (ms): past the 25s not-responding notice, safely under `DROP_AFTER_MS=40000` in shared config. */
export const SOAK4_AWAY_MS = Number(process.env['SOAK4_AWAY_MS'] ?? 26_000);

export interface Soak4SeedPreset {
  readonly label: string;
  readonly mapSeed: number;
  readonly botSeed: number;
  readonly mapTypeLabel: string;
  readonly mapTypeId: number;
  readonly mapSizeValue: string;
  readonly mapSizeId: number;
  readonly civs: readonly [number, number, number, number];
}

const SEED_PRESET_TEMPLATES: readonly Omit<Soak4SeedPreset, 'mapSeed' | 'botSeed'>[] = [
  {
    label: 'hill-country-mixed-random',
    mapTypeLabel: 'Hill Country',
    mapTypeId: MAP_HILLY,
    mapSizeValue: String(MAP_MEDIUM),
    mapSizeId: MAP_MEDIUM,
    civs: [1, 5, 9, CIV_RANDOM],
  },
  {
    label: 'mostly-land-large',
    mapTypeLabel: 'Mostly Land',
    mapTypeId: MAP_MOSTLY_LAND,
    mapSizeValue: String(MAP_LARGE),
    mapSizeId: MAP_LARGE,
    civs: [2, 6, 10, 14],
  },
  {
    label: 'continental-large',
    mapTypeLabel: 'Continental',
    mapTypeId: MAP_CONTINENTAL,
    mapSizeValue: String(MAP_LARGE),
    mapSizeId: MAP_LARGE,
    civs: [3, 7, 12, 16],
  },
];

export function resolveSoak4Seeds(): number[] {
  const rawList = process.env['SOAK4_SEEDS'];
  if (rawList) {
    const parsed = rawList
      .split(',')
      .map((s) => Number(s.trim()))
      .filter((n) => Number.isInteger(n) && n >= 0);
    if (parsed.length > 0) return parsed;
  }
  const single = process.env['SOAK4_SEED'];
  if (single !== undefined && Number.isInteger(Number(single))) {
    return [Number(single)];
  }
  return [...SOAK4_DEFAULT_SEEDS];
}

export function presetForSeed(seed: number, index: number): Soak4SeedPreset {
  const tpl = SEED_PRESET_TEMPLATES[index % SEED_PRESET_TEMPLATES.length]!;
  const botSeed = process.env['SOAK4_BOT_SEED'] !== undefined && index === 0
    ? Number(process.env['SOAK4_BOT_SEED'])
    : (seed ^ 0x5bd1e995) >>> 0;
  return {
    ...tpl,
    mapSeed: seed,
    botSeed,
  };
}

export function derivedMapSeed(baseSeed: number, gameIndex: number): number {
  return (baseSeed + Math.imul(gameIndex, 0x9e3779b1)) & 0x7fffffff;
}

export function derivedBotSeed(baseBotSeed: number, mapSeed: number, gameIndex: number): number {
  return gameIndex === 0 ? baseBotSeed : (mapSeed ^ 0x5bd1e995) >>> 0;
}

export const hexHash = (h: number | undefined): string =>
  h === undefined ? 'none' : (h >>> 0).toString(16).padStart(8, '0');

export const soak4DebugUrl = (seed: number, extra = ''): string =>
  `/?debug=net&speed=20&resources=20000&bowmen=6&market=1&seed=${seed}${extra}`;

export interface Rng {
  next(): number;
  int(n: number): number;
  pick<T>(items: readonly T[]): T;
  chance(p: number): boolean;
}

/** Deterministic SplitMix32 PRNG keyed by seed. */
export function createRng(seed: number): Rng {
  let s = seed >>> 0;
  const next = () => {
    s = (s + 0x9e3779b9) >>> 0;
    let z = s ^ (s >>> 16);
    z = Math.imul(z, 0x21f0aaad) >>> 0;
    z ^= z >>> 15;
    z = Math.imul(z, 0x735a2d97) >>> 0;
    return ((z ^ (z >>> 15)) >>> 0) / 0x100000000;
  };
  return {
    next,
    int: (n: number) => Math.floor(next() * n),
    pick: <T>(items: readonly T[]): T => items[Math.floor(next() * items.length)]!,
    chance: (p: number) => next() < p,
  };
}

export interface CommandTraceEntry {
  turn: number;
  slot: number;
  player: number;
  command: Command;
}

/** Bounded ring buffer keeping the most recent commands across all 4 peers for mismatch diagnostics. */
export class CommandTraceBuffer {
  private readonly entries: CommandTraceEntry[] = [];

  constructor(private readonly maxEntries = 120) {}

  record(entry: CommandTraceEntry): void {
    this.entries.push(entry);
    if (this.entries.length > this.maxEntries) {
      this.entries.shift();
    }
  }

  formatRecent(limit = 32): string {
    const slice = this.entries.slice(-limit);
    if (slice.length === 0) return '(no commands recorded)';
    return slice
      .map((e) => `turn=${e.turn} slot=${e.slot}(p${e.player}) ${JSON.stringify(e.command)}`)
      .join('\n  ');
  }
}

export interface Soak4Session {
  readonly contexts: [BrowserContext, BrowserContext, BrowserContext, BrowserContext];
  readonly pages: [Page, Page, Page, Page];
  readonly code: string;
  readonly seed: number;
  closeAll(): Promise<void>;
}

/**
 * Selects 4-player room capacity on the lobby entry screen.
 * Supports `<select data-testid="capacity">`, `<select data-testid="room-capacity">`,
 * or `<button/input data-testid="capacity-4">`.
 */
async function selectCapacity4(page: Page): Promise<void> {
  const selectById = page.getByTestId('capacity');
  if ((await selectById.count()) > 0) {
    const tag = await selectById.evaluate((el) => el.tagName.toLowerCase());
    if (tag === 'select') {
      await selectById.selectOption('4');
      return;
    }
  }
  const roomCap = page.getByTestId('room-capacity');
  if ((await roomCap.count()) > 0) {
    const tag = await roomCap.evaluate((el) => el.tagName.toLowerCase());
    if (tag === 'select') {
      await roomCap.selectOption('4');
      return;
    }
  }
  const cap4Btn = page.getByTestId('capacity-4');
  if ((await cap4Btn.count()) > 0) {
    await cap4Btn.click();
    return;
  }
  throw new Error('4-player capacity selector not found in lobby UI (expected data-testid="capacity", "room-capacity", or "capacity-4")');
}

async function openSoak4Page(
  browser: Browser,
  seed: number,
  extra = '',
): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await context.newPage();
  await page.goto(soak4DebugUrl(seed, extra));
  return { context, page };
}

export interface StartSoak4Options {
  seed: number;
  civs: readonly [number, number, number, number];
  mapSizeValue?: string;
  mapTypeLabel?: string;
  useScoreLimit?: boolean;
  hostExtra?: string;
  guestExtra?: string;
  slotExtras?: Partial<Record<0 | 1 | 2 | 3, string>>;
}

/**
 * Launches 4 isolated browser contexts, creates a 4-seat room, joins 3 guests (two via `?room=CODE` invite URL
 * and one via code input), configures lobby settings & civs, readies all 4, and starts the match.
 */
export async function startMultiplayer4Game(
  browser: Browser,
  opts: StartSoak4Options,
): Promise<Soak4Session> {
  const hostExtra = `${opts.hostExtra ?? ''}${opts.slotExtras?.[0] ?? ''}`;
  const hostPair = await openSoak4Page(browser, opts.seed, hostExtra);
  const host = hostPair.page;

  try {
    await host.getByTestId('name').fill(SOAK4_PLAYER_NAMES[0]);
    await selectCapacity4(host);
    await host.getByTestId('create').click();
    const rawCode = await host.getByTestId('invite-code').textContent();
    const code = rawCode?.trim() ?? '';
    expect(code).toMatch(/^[A-Z0-9]{5}$/);

    // Join slots 1, 2, 3: slot 1 via manual code entry, slots 2 & 3 via invite link `?room=CODE`.
    const g1 = await openSoak4Page(browser, opts.seed, `${opts.guestExtra ?? ''}${opts.slotExtras?.[1] ?? ''}`);
    const g2 = await openSoak4Page(browser, opts.seed, `&room=${encodeURIComponent(code)}${opts.guestExtra ?? ''}${opts.slotExtras?.[2] ?? ''}`);
    const g3 = await openSoak4Page(browser, opts.seed, `&room=${encodeURIComponent(code)}${opts.guestExtra ?? ''}${opts.slotExtras?.[3] ?? ''}`);

    const contexts: [BrowserContext, BrowserContext, BrowserContext, BrowserContext] = [
      hostPair.context,
      g1.context,
      g2.context,
      g3.context,
    ];
    const pages: [Page, Page, Page, Page] = [host, g1.page, g2.page, g3.page];

    try {
      for (const slot of [1, 2, 3] as const) {
        const guest = pages[slot];
        await guest.getByTestId('name').fill(SOAK4_PLAYER_NAMES[slot]);
        const codeInput = guest.getByTestId('code');
        if ((await codeInput.inputValue()).trim().toUpperCase() !== code) {
          await codeInput.fill(code);
        }
        await guest.getByTestId('join').click();
      }

      for (const slot of [0, 1, 2, 3] as const) {
        await expect(host.getByTestId(`player-${slot}`)).toContainText(SOAK4_PLAYER_NAMES[slot]);
      }

      if (opts.mapSizeValue) {
        await host.getByTestId('map-size').selectOption(opts.mapSizeValue);
      }
      if (opts.mapTypeLabel) {
        await host.getByTestId('map-type').selectOption({ label: opts.mapTypeLabel });
      }
      if (opts.useScoreLimit !== false) {
        await host.getByTestId('victory').selectOption({ label: 'Score' });
        await host.getByTestId('victory-amount').selectOption('3000');
      }

      for (const slot of [0, 1, 2, 3] as const) {
        await pages[slot].getByTestId(`civ-${slot}`).selectOption(String(opts.civs[slot]));
      }
      for (const page of pages) {
        await page.getByTestId('ready').click();
      }

      await expect(host.getByTestId('start')).toBeEnabled();
      await host.getByTestId('start').click();

      for (const page of pages) {
        await page.waitForFunction(() => window.__game?.selection() != null && window.__map !== undefined);
      }

      return {
        contexts,
        pages,
        code,
        seed: opts.seed,
        async closeAll() {
          await Promise.allSettled(contexts.map((c) => c.close()));
        },
      };
    } catch (err) {
      await Promise.allSettled(contexts.map((c) => c.close()));
      throw err;
    }
  } catch (err) {
    await hostPair.context.close();
    throw err;
  }
}

export async function readTurn(page: Page): Promise<number> {
  return page.evaluate(() => window.__game!.turn());
}

export async function readHashesAt(pages: readonly Page[], turn: number): Promise<(number | undefined)[]> {
  return Promise.all(pages.map((p) => p.evaluate((t) => window.__game!.hash(t), turn)));
}

export interface DesyncDiagnostic {
  seed: number;
  turn: number;
  hashes: (number | undefined)[];
  source: 'relay' | 'poll';
}

/**
 * Inspects active peers for relay-reported desync or per-turn hash divergence.
 * Returns a formatted diagnostic containing seed, first divergent turn, per-slot hashes, and recent command trace.
 */
export async function findDesync4(
  activePages: readonly { slot: number; page: Page }[],
  seed: number,
  trace: CommandTraceBuffer,
): Promise<string | null> {
  for (const { page } of activePages) {
    const reported = await page.evaluate(() => window.__game?.desync() ?? null);
    if (reported) {
      const slotSummary = reported.hashes.map((h, i) => `slot${i}=${hexHash(h)}`).join(', ');
      return (
        `Desync detected by relay: seed=${seed}, firstDivergentTurn=${reported.turn}, hashes=[${slotSummary}]\n` +
        `Recent command trace:\n  ${trace.formatRecent()}`
      );
    }
  }

  if (activePages.length < 2) return null;
  const turns = await Promise.all(activePages.map((p) => readTurn(p.page)));
  const minTurn = Math.min(...turns);
  const checkedTurn = Math.floor(minTurn / 4) * 4;
  if (checkedTurn < 0) return null;

  const samples = await Promise.all(
    activePages.map(async ({ slot, page }) => ({
      slot,
      hash: await page.evaluate((t) => window.__game!.hash(t), checkedTurn),
    })),
  );
  const first = samples[0]?.hash;
  if (first === undefined) return null;
  const mismatch = samples.some((s) => s.hash !== undefined && s.hash !== first);
  if (!mismatch) return null;

  const slotSummary = samples.map((s) => `slot${s.slot}=${hexHash(s.hash)}`).join(', ');
  return (
    `Desync detected by client poll: seed=${seed}, firstDivergentTurn=${checkedTurn}, hashes=[${slotSummary}]\n` +
    `Recent command trace:\n  ${trace.formatRecent()}`
  );
}

const VILLAGERS: readonly number[] = [VILLAGER, BUILDER, FORAGER, LUMBERJACK, HUNTER, MINER_STONE, MINER_GOLD, 259, 156];
const MILITARY: readonly number[] = [CLUBMAN, BOWMAN, SCOUT, SLINGER];
const RESOURCES: readonly number[] = [...TREES, FORAGE, MINE_GOLD, MINE_STONE, GAZELLE];
const TRAINS: Readonly<Record<number, readonly number[]>> = {
  [TOWN_CENTER]: [VILLAGER],
  [BARRACKS]: [CLUBMAN],
  [ARCHERY_RANGE]: [BOWMAN],
  [STABLE]: [SCOUT],
};
const BUILDINGS: readonly number[] = [
  HOUSE,
  HOUSE,
  HOUSE,
  FARM,
  FARM,
  FARM,
  BARRACKS,
  GRANARY,
  STORAGE_PIT,
  ARCHERY_RANGE,
  STABLE,
  MARKET,
];
const TECH_COUNT = 127;

interface BotWorldSnapshot {
  me: number;
  turn: number;
  status: number;
  units: { id: number; type: number; x: number; y: number }[];
  buildings: { id: number; type: number; x: number; y: number; complete: boolean }[];
  headroom: number;
  resources: { id: number; x: number; y: number }[];
  enemies: { id: number; x: number; y: number }[];
  refreshed: boolean;
}

/**
 * Seeded 4-player soak bot driving one connected browser peer.
 * Reads only local `window.__game` / `window.__map` state and submits commands via `window.__game.issue`.
 */
export class Soak4Bot {
  readonly issued = new Map<string, number>();
  private readonly rng: Rng;
  private resources: { id: number; x: number; y: number }[] = [];
  private enemies: { id: number; x: number; y: number }[] = [];
  private hills: [number, number][] = [];
  private size = 0;
  private rounds = 0;
  resigned = false;

  constructor(
    readonly slot: number,
    readonly page: Page,
    seed: number,
    private readonly trace: CommandTraceBuffer,
  ) {
    this.rng = createRng(seed);
  }

  async prepare(): Promise<void> {
    const map = await this.page.evaluate(() => {
      const m = window.__map!;
      const hills: [number, number][] = [];
      for (let r = 0; r < m.height; r += 2) {
        for (let c = 0; c < m.width; c += 2) {
          if (m.tileInfo(c, r).height > 0) hills.push([c, r]);
        }
      }
      return { width: m.width, hills };
    });
    this.size = map.width;
    this.hills = map.hills;
  }

  private async look(): Promise<BotWorldSnapshot> {
    const refreshObjects = this.rounds++ % 10 === 0;
    const snap = await this.page.evaluate(
      ([resourceTypes, refresh]) => {
        const g = window.__game!;
        const me = g.player();
        const result = g.gameResult();
        const status = result?.status[me] ?? 0;
        const units = g.units().filter((u) => u.owner === me).map((u) => ({ id: u.id, type: u.type, x: u.x, y: u.y }));
        const buildings = g.buildings().filter((b) => b.owner === me).map((b) => ({ id: b.id, type: b.type, x: b.x, y: b.y, complete: b.progress >= 100 }));
        const objects = refresh ? g.objects() : [];
        const resources = objects.filter((o) => o.owner === 0 && resourceTypes.includes(o.type)).map((o) => ({ id: o.id, x: o.x, y: o.y }));
        const enemies = objects.filter((o) => o.owner !== 0 && o.owner !== me).map((o) => ({ id: o.id, x: o.x, y: o.y }));
        return {
          me,
          turn: g.turn(),
          status,
          units,
          buildings,
          headroom: g.population(me).headroom,
          resources,
          enemies,
          refreshed: refresh,
        };
      },
      [RESOURCES, refreshObjects] as const,
    );
    if (snap.refreshed) {
      this.resources = snap.resources;
      this.enemies = snap.enemies;
    }
    return snap;
  }

  private async issue(turn: number, player: number, command: Command): Promise<void> {
    this.issued.set(command.type, (this.issued.get(command.type) ?? 0) + 1);
    this.trace.record({ turn, slot: this.slot, player, command });
    await this.page.evaluate((c) => window.__game!.issue(c), command as { type: string; [field: string]: unknown });
  }

  private nearest<T extends { x: number; y: number }>(list: readonly T[], x: number, y: number, among = 8): T | undefined {
    const sorted = [...list].sort((a, b) => (a.x - x) ** 2 + (a.y - y) ** 2 - ((b.x - x) ** 2 + (b.y - y) ** 2));
    return sorted.length > 0 ? this.rng.pick(sorted.slice(0, among)) : undefined;
  }

  private some<T>(list: readonly T[], most: number): T[] {
    const copy = [...list];
    const out: T[] = [];
    for (let n = 1 + this.rng.int(most); n > 0 && copy.length > 0; n--) {
      out.push(copy.splice(this.rng.int(copy.length), 1)[0]!);
    }
    return out;
  }

  async round(): Promise<void> {
    if (this.resigned) return;
    const s = await this.look();
    if (s.status !== 0) {
      this.resigned = true;
      return;
    }
    const villagers = s.units.filter((u) => VILLAGERS.includes(u.type));
    const military = s.units.filter((u) => MILITARY.includes(u.type));
    const centre = s.buildings.find((b) => b.type === TOWN_CENTER) ?? s.buildings[0] ?? villagers[0];

    for (let n = 2 + this.rng.int(3); n > 0; n--) {
      const roll = this.rng.next();
      if (roll < 0.24 && villagers.length > 0) {
        const group = this.some(villagers, 4);
        const target = this.nearest(this.resources, group[0]!.x, group[0]!.y);
        if (target) {
          await this.issue(s.turn, s.me, { type: 'work', units: group.map((u) => u.id), target: target.id, x: target.x, y: target.y });
        }
      } else if (roll < 0.40 && villagers.length > 0 && centre) {
        const unitType = s.headroom < 3 && this.rng.chance(0.7) ? HOUSE : this.rng.pick(BUILDINGS);
        const x = Math.round(centre.x) + this.rng.int(25) - 12;
        const y = Math.round(centre.y) + this.rng.int(25) - 12;
        await this.issue(s.turn, s.me, { type: 'build', units: this.some(villagers, 2).map((u) => u.id), unitType, x, y });
      } else if (roll < 0.58) {
        const building = this.rng.pick(s.buildings.filter((b) => b.type in TRAINS));
        if (building) {
          const trainList = TRAINS[building.type]!;
          const count = this.rng.chance(0.1) ? -1 : 1 + this.rng.int(3);
          await this.issue(s.turn, s.me, { type: 'queue', building: building.id, unit: this.rng.pick(trainList), count });
        }
      } else if (roll < 0.70 && s.units.length > 0) {
        const group = this.some(s.units, 6);
        const [x, y] = this.hills.length > 0 && this.rng.chance(0.35)
          ? this.rng.pick(this.hills)
          : [this.rng.int(this.size), this.rng.int(this.size)];
        await this.issue(s.turn, s.me, { type: 'move', units: group.map((u) => u.id), x: x + 0.5, y: y + 0.5 });
      } else if (roll < 0.80 && military.length > 0) {
        const group = this.some(military, 5);
        const target = this.nearest(this.enemies, group[0]!.x, group[0]!.y, 12);
        if (target) {
          await this.issue(s.turn, s.me, { type: 'attack', units: group.map((u) => u.id), target: target.id });
        }
      } else if (roll < 0.87 && s.buildings.length > 0) {
        await this.issue(s.turn, s.me, { type: 'research', building: this.rng.pick(s.buildings).id, tech: this.rng.int(TECH_COUNT) });
      } else if (roll < 0.91 && villagers.length > 0 && s.buildings.length > 0) {
        await this.issue(s.turn, s.me, { type: 'repair', units: this.some(villagers, 3).map((u) => u.id), target: this.rng.pick(s.buildings).id });
      } else if (roll < 0.94 && s.units.length > 0) {
        const ids = this.some(s.units, 4).map((u) => u.id);
        await this.issue(s.turn, s.me, this.rng.chance(0.5) ? { type: 'stop', objects: ids } : { type: 'stand-ground', units: ids });
      } else if (roll < 0.97) {
        // Exercise 4-player diplomacy/tribute across peers 1..4 without permanently breaking FFA victory.
        const targetPlayer = 1 + this.rng.int(4);
        if (targetPlayer !== s.me) {
          await this.issue(s.turn, s.me, { type: 'tribute', player: targetPlayer, resource: this.rng.int(4), amount: 25 });
        }
      } else if (s.buildings.length > 0) {
        await this.issue(s.turn, s.me, { type: 'cancel', target: this.rng.pick(s.buildings).id });
      }
    }
  }
}

/** Resign a peer cleanly via the in-game Menu -> Resign -> Yes flow (or direct resign command fallback). */
export async function resignPeerInGame(page: Page): Promise<void> {
  const menuBtn = page.getByTestId('menu-menu');
  if ((await menuBtn.count()) > 0 && (await menuBtn.isVisible())) {
    await menuBtn.click();
    const resignBtn = page.getByTestId('menu-resign');
    if ((await resignBtn.count()) > 0) {
      await resignBtn.click();
      await page.getByTestId('popup-yes').click();
      return;
    }
  }
  await page.evaluate(() => window.__game!.issue({ type: 'resign' }));
}

/**
 * Builds a deterministic 4-human / 5-sim-player (`Gaia + players 1..4`) `ReplayLog` for cross-engine determinism (`A07`).
 * Exercises random map generation, Random civ resolution, economy/build/wall/military/research/diplomacy/speed commands,
 * and mid-game player-4 resignation continuation across Node, Chromium, Firefox, and WebKit.
 */
export function buildSampleReplay4(seed = 20260401, turns = 120): ReplayLog {
  const settings: GameSettings = {
    ...DEFAULT_GAME_SETTINGS,
    mapType: MAP_HILLY,
    mapSize: MAP_MEDIUM,
    victory: { type: VICTORY_SCORE, amount: 3000 },
    fixedPositions: true,
  };
  const civsInput = [1, 5, 9, CIV_RANDOM];
  const options = lobbyWorldOptions(seed, settings, civsInput);
  const world = new World(options);
  const objects = [...world.entities.all()];

  const villagers = objects.filter((e) => e.type === VILLAGER).map((e) => ({ id: e.id, owner: e.owner }));
  const centers = objects.filter((e) => e.type === TOWN_CENTER).map((e) => ({ id: e.id, owner: e.owner, x: e.x, y: e.y }));
  const resources = objects.filter((e) => e.owner === 0 && e.heldAmount > 0).map((e) => ({ id: e.id, x: e.x, y: e.y }));
  const maxStartId = objects.reduce((m, e) => Math.max(m, e.id), 0);

  const gen = new CrtRand();
  gen.srand(seed);
  const fight = new CrtRand();
  fight.srand(seed + 7919);
  const study = new CrtRand();
  study.srand(seed + 104729);
  const diplo = new CrtRand();
  diplo.srand(seed + 15485863);

  const batches: ReplayLog['batches'] = [];
  const fraction = () => gen.rand() / 32768;

  for (let turn = 0; turn < turns; turn++) {
    for (const player of [4, 2, 1, 3]) {
      // Player 4 resigns at turn 80; remaining 3 players continue issuing commands through `turns`.
      if (player === 4 && turn > 80) continue;
      if (player === 4 && turn === 80) {
        batches.push({ turn, player, commands: [{ type: 'resign' }] });
        continue;
      }

      const commands: Command[] = [];
      const testCount = gen.rand() % 3;
      for (let i = 0; i < testCount; i++) {
        commands.push({ type: 'test', x: gen.rand() / 327.67, y: gen.rand() / 91.3 });
      }
      if (testCount === 0 && gen.rand() % 2 === 0) commands.push({ type: 'noop' });

      const ownTc = centers.find((c) => c.owner === player);
      const ownVillagers = villagers.filter((v) => v.owner === player).map((v) => v.id);

      if (ownVillagers.length > 0 && gen.rand() % 16 === 0) {
        commands.push({ type: 'move', units: ownVillagers, x: 10 + (gen.rand() % 80) + fraction(), y: 10 + (gen.rand() % 80) + fraction() });
      }
      if (ownVillagers.length > 0 && ownTc && resources.length > 0 && gen.rand() % 12 === 0) {
        const near = resources.filter((r) => Math.abs(r.x - ownTc.x) < 16 && Math.abs(r.y - ownTc.y) < 16);
        const target = (near.length > 0 ? near[gen.rand() % near.length] : resources[gen.rand() % resources.length])!;
        commands.push({ type: 'work', units: ownVillagers, target: target.id, x: target.x, y: target.y });
      }
      if (ownVillagers.length > 0 && ownTc && gen.rand() % 20 === 0) {
        const unitType = gen.rand() % 3 === 0 ? BARRACKS : HOUSE;
        commands.push({
          type: 'build',
          units: ownVillagers.slice(0, 2),
          unitType,
          x: ownTc.x + (gen.rand() % 11) - 5 + fraction(),
          y: ownTc.y + (gen.rand() % 11) - 5 + fraction(),
        });
      }
      if (ownVillagers.length > 0 && ownTc && gen.rand() % 36 === 0) {
        const tile = (v: number) => Math.min(255, Math.max(0, Math.trunc(v)));
        const x1 = tile(ownTc.x + (gen.rand() % 9) - 4);
        const y1 = tile(ownTc.y + (gen.rand() % 9) - 4);
        commands.push({ type: 'build-wall', units: ownVillagers.slice(0, 1), unitType: SMALL_WALL, x1, y1, x2: tile(x1 + 2), y2: y1 });
      }
      if (ownTc && gen.rand() % 10 === 0) {
        commands.push({ type: 'queue', building: ownTc.id, unit: gen.rand() % 5 === 0 ? CLUBMAN : VILLAGER, count: 1 + (gen.rand() % 2) });
      }
      if (ownVillagers.length > 0 && fight.rand() % 18 === 0) {
        const enemies = villagers.filter((v) => v.owner !== player);
        const target = enemies[fight.rand() % enemies.length];
        if (target) {
          commands.push({ type: 'attack', units: ownVillagers.slice(0, 2), target: target.id });
        }
      }
      if (ownTc && study.rand() % 16 === 0) {
        const techs = [TOOL_AGE, 10, 39, study.rand() % 130];
        commands.push({ type: 'research', building: ownTc.id, tech: techs[study.rand() % techs.length]! });
      }
      if (gen.rand() % 48 === 0) {
        commands.push({ type: 'cancel', target: maxStartId + 1 + (gen.rand() % 20) });
      }
      if (ownTc && study.rand() % 80 === 0) {
        commands.push({ type: 'stop', objects: [ownTc.id] });
      }
      if (diplo.rand() % 20 === 0) {
        const other = 1 + ((player + (diplo.rand() % 3)) % 4);
        commands.push({ type: 'relation', player: other, relation: [0, 1, 3][diplo.rand() % 3]! });
      }
      if (diplo.rand() % 35 === 0) {
        commands.push({ type: 'allied-victory', on: diplo.rand() % 2 === 0 });
      }
      if (diplo.rand() % 18 === 0) {
        const other = 1 + ((player + (diplo.rand() % 3)) % 4);
        commands.push({ type: 'tribute', player: other, resource: diplo.rand() % 4, amount: 50 });
      }

      if (commands.length > 0) batches.push({ turn, player, commands });
    }
  }

  const speeds: SpeedChange[] = [
    { turn: 24, granularity: 30, frames: 9 },
    { turn: 36, granularity: 150, frames: 8 },
    { turn: 60, granularity: 90, frames: 10 },
  ].filter((s) => s.turn < turns);

  return {
    players: 5,
    randomSeed: seed,
    randomMap: options.randomMap,
    civs: [...world.civs],
    victory: options.victory,
    populationLimit: options.populationLimit,
    start: {
      startingAge: options.startingAge,
      resourceLevel: options.resourceLevel,
      deathMatch: options.deathMatch,
      fullTechTree: options.fullTechTree,
      revealMap: options.revealMap,
      pathingIterations: options.pathingIterations,
      fixedPositions: options.fixedPositions,
      cheating: options.cheating,
    },
    turns,
    batches,
    speeds,
  };
}

/** Returns the first turn index where `candidate` diverges from `baseline`, or null if identical. */
export function firstDivergentTurn(
  baseline: readonly number[],
  candidate: readonly number[],
): { turn: number; expected: number | undefined; actual: number | undefined } | null {
  const len = Math.max(baseline.length, candidate.length);
  for (let i = 0; i < len; i++) {
    if (baseline[i] !== candidate[i]) {
      return { turn: i, expected: baseline[i], actual: candidate[i] };
    }
  }
  return null;
}
