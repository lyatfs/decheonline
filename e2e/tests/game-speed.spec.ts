import { expect, test, type Browser, type Page } from '@playwright/test';

// Game speed 1.0, 1.5 and 2.0 on two clients (docs/spec/lobby.md §8): + and - (`char_action`) and the Menu's Game
// Settings dialog send the game speed command; every step then adds G * speed ms of game time to the same G ms of wall
// time. No `speed=` pace multiplier here: the test measures game seconds per real second.
const URL = '/?debug=net&map=test';

async function open(browser: Browser): Promise<Page> {
  const page = await (await browser.newContext({ viewport: { width: 1280, height: 800 } })).newPage();
  await page.goto(URL);
  return page;
}

async function startGame(browser: Browser): Promise<[Page, Page]> {
  const host = await open(browser);
  const guest = await open(browser);
  await host.getByTestId('name').fill('Alice');
  await host.getByTestId('create').click();
  const code = (await host.getByTestId('invite-code').textContent())!;
  await guest.getByTestId('name').fill('Bob');
  await guest.getByTestId('code').fill(code);
  await guest.getByTestId('join').click();
  await expect(host.getByTestId('player-1')).toContainText('Bob');
  await host.getByTestId('ready').click();
  await guest.getByTestId('ready').click();
  await host.getByTestId('start').click();
  for (const page of [host, guest]) await page.waitForFunction(() => window.__game?.selection() != null && window.__game.turn() > 8);
  return [host, guest];
}

interface Rate {
  /** Game seconds per real second. */
  real: number;
  /** Base seconds (the steps' G, which the turn loop paces to the wall clock) per real second. */
  base: number;
  /** Game time per base time: the game speed. */
  speed: number;
  /** The step sizes G and buffer frames F the server's speed control (turn-timing.md §4) chose meanwhile. */
  gf: string;
}

/** Game time against wall time and base time over `seconds`, measured between two turn starts. */
async function rate(page: Page, seconds: number): Promise<Rate> {
  return page.evaluate(async (s) => {
    const g = window.__game!;
    const turnStart = async () => {
      const t = g.turn();
      while (g.turn() === t) await new Promise((r) => setTimeout(r, 2));
      return { game: g.gameTime(), base: g.baseTime(), real: performance.now() };
    };
    const a = await turnStart();
    const gf = new Set<string>();
    const end = performance.now() + s * 1000;
    while (performance.now() < end) {
      const n = g.net();
      gf.add(`${n.granularity}/${n.frames}`);
      await new Promise((r) => setTimeout(r, 500));
    }
    const b = await turnStart();
    const [game, base, real] = [b.game - a.game, b.base - a.base, b.real - a.real];
    return { real: game / real, base: base / real, speed: game / base, gf: [...gf].join(' ') };
  }, seconds);
}

const clock = (page: Page) => page.getByTestId('game-clock');

test('1.0, 1.5 and 2.0: game time runs 1.5x and 2x as fast on both clients, the clock shows the speed', async ({ browser }) => {
  const [host, guest] = await startGame(browser);
  for (const page of [host, guest]) {
    await expect(clock(page)).toHaveText(/^\d\d:\d\d:\d\d \(1\.0\)$/);
  }
  // Both clients measure at the same time, so a slow stretch of the machine counts in every speed's baseline alike.
  const measure = () => Promise.all([rate(host, 12), rate(guest, 12)]);
  const base = await measure();

  // The host's +: 1.5 on both once the command runs. ("Game speed changed." goes to the chat lines only with the pack's
  // strings, which this suite runs without.)
  await host.keyboard.press('+');
  for (const page of [host, guest]) {
    await expect(clock(page)).toHaveText(/\(1\.5\)$/);
  }
  const fast = await measure();

  // The guest's Game Settings dialog: Fast is checked; Very Fast and OK make it 2.0 for both.
  await guest.getByTestId('menu-menu').click();
  await guest.getByTestId('menu-settings').click();
  await expect(guest.getByTestId('game-speed-1.5')).toBeChecked();
  await guest.getByTestId('game-speed-2').check();
  await guest.getByTestId('options-ok').click();
  for (const page of [host, guest]) {
    await expect(clock(page)).toHaveText(/\(2\.0\)$/);
  }
  const veryFast = await measure();

  // Game time per real second is the speed times the base time per real second the turn loop keeps (about 1 on an idle
  // machine, turn-timing.md §2); on a loaded one stalls and the server's G and F move the latter, so the speed is
  // checked against base time and the wall-clock figures are printed.
  const speeds = { '1.0': base, '1.5': fast, '2.0': veryFast };
  for (const [name, [h, g]] of Object.entries(speeds)) {
    console.log(
      `speed ${name}: ${h.real.toFixed(3)} (host), ${g.real.toFixed(3)} (guest) game s per real s, ${(h.real / base[0].real).toFixed(2)}x, ${(g.real / base[1].real).toFixed(2)}x of 1.0;` +
        ` base s per real s ${h.base.toFixed(3)}, ${g.base.toFixed(3)}; game per base ${h.speed.toFixed(3)}, ${g.speed.toFixed(3)}; G/F ${h.gf}`,
    );
  }
  for (const [name, rates] of Object.entries(speeds)) {
    const expected = Number(name);
    for (let i = 0; i < rates.length; i++) {
      const r = rates[i]!;
      expect(r.speed).toBeCloseTo(expected, 2);
      // baseTime / realTime is paced independently of gameSpeed (no paceScale /= gameSpeed).
      expect(r.base).toBeGreaterThan(0.5);
      expect(r.base).toBeLessThan(1.35);
      expect(r.base / base[i]!.base).toBeGreaterThan(0.65);
      expect(r.base / base[i]!.base).toBeLessThan(1.3);
      // gameTime / realTime scales linearly with gameSpeed (not gameSpeed²).
      expect(r.real).toBeCloseTo(expected * r.base, 2);
      const ratioReal = r.real / base[i]!.real;
      if (expected === 1.5) {
        expect(ratioReal).toBeGreaterThan(1.1);
        expect(ratioReal).toBeLessThan(1.9);
      } else if (expected === 2) {
        expect(ratioReal).toBeGreaterThan(1.45);
        expect(ratioReal).toBeLessThan(2.55);
      }
    }
  }

  // - steps back down the ladder (one change a second at most).
  await guest.keyboard.press('-');
  for (const page of [host, guest]) await expect(clock(page)).toHaveText(/\(1\.5\)$/);
  for (const page of [host, guest]) expect(await page.evaluate(() => window.__game!.desync())).toBeNull();
});
