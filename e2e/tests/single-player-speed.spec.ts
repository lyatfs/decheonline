import { expect, test, type Browser, type Page } from '@playwright/test';

const URL = '/?debug=net&map=test';

interface Rate {
  real: number;
  base: number;
  speed: number;
}

async function open(browser: Browser): Promise<Page> {
  const page = await (await browser.newContext({ viewport: { width: 1280, height: 800 } })).newPage();
  await page.goto(URL);
  return page;
}

async function startSinglePlayer(browser: Browser): Promise<Page> {
  const page = await open(browser);
  await page.getByTestId('single-player').click();
  await page.getByTestId('sp-start').click();
  await page.waitForFunction(() => window.__game?.selection() != null && window.__game.turn() > 8);
  return page;
}

async function rate(page: Page, seconds: number): Promise<Rate> {
  return page.evaluate(async (s) => {
    const g = window.__game!;
    const turnStart = async () => {
      const t = g.turn();
      while (g.turn() === t) await new Promise((r) => setTimeout(r, 2));
      return { game: g.gameTime(), base: g.baseTime(), real: performance.now() };
    };
    const a = await turnStart();
    const end = performance.now() + s * 1000;
    while (performance.now() < end) {
      await new Promise((r) => setTimeout(r, 250));
    }
    const b = await turnStart();
    const [game, base, real] = [b.game - a.game, b.base - a.base, b.real - a.real];
    return { real: game / real, base: base / real, speed: game / base };
  }, seconds);
}

const clock = (page: Page) => page.getByTestId('game-clock');

test('single-player bounded speed [0.5, 4.0] scales gameTime linearly without squaring, and applies across pause/resume (S01-S03)', async ({ browser }) => {
  const page = await startSinglePlayer(browser);
  await expect(clock(page)).toHaveText(/^\d\d:\d\d:\d\d \(1\.0\)$/);

  const base1 = await rate(page, 8);
  expect(base1.speed).toBeCloseTo(1.0, 2);

  // Options dialog in single-player shows bounded slider/buttons instead of multiplayer radios
  await page.getByTestId('menu-menu').click();
  await page.getByTestId('menu-settings').click();
  await expect(page.getByTestId('sp-speed-control')).toBeVisible();
  await expect(page.getByTestId('game-speed-1')).toHaveCount(0);
  await expect(page.getByTestId('sp-speed-value')).toHaveText('1.0x');

  // Set speed to 0.5x via slider and confirm
  await page.getByTestId('sp-speed-slider').fill('0.5');
  await expect(page.getByTestId('sp-speed-value')).toHaveText('0.5x');
  await expect(page.getByTestId('sp-speed-dec')).toBeDisabled();
  await page.getByTestId('options-ok').click();
  await expect(clock(page)).toHaveText(/\(0\.5\)$/);

  const slow = await rate(page, 8);
  expect(slow.speed).toBeCloseTo(0.5, 2);
  expect(slow.base).toBeGreaterThan(0.5);
  expect(slow.base).toBeLessThan(1.35);
  expect(slow.real / base1.real).toBeGreaterThan(0.3);
  expect(slow.real / base1.real).toBeLessThan(0.75);

  // Keyboard + steps by 0.25 -> 0.75, 1.0
  await page.keyboard.press('+');
  await page.keyboard.press('+');
  await expect(clock(page)).toHaveText(/\(1\.0\)$/);

  // Pause with F3, change speed to 3.0x in Options while paused, resume with F3 -> applies cleanly without burst or desync
  await page.keyboard.press('F3');
  await expect(page.getByTestId('pause-indicator')).toBeVisible();
  await page.getByTestId('menu-menu').click();
  await page.getByTestId('menu-settings').click();
  await page.getByTestId('sp-speed-slider').fill('3');
  await expect(page.getByTestId('sp-speed-value')).toHaveText('3.0x');
  await page.getByTestId('options-ok').click();

  await page.keyboard.press('F3');
  await expect(page.getByTestId('pause-indicator')).toBeHidden();
  await expect(clock(page)).toHaveText(/\(3\.0\)$/);

  const fast = await rate(page, 8);
  expect(fast.speed).toBeCloseTo(3.0, 2);
  expect(fast.base).toBeGreaterThan(0.5);
  expect(fast.base).toBeLessThan(1.35);
  expect(fast.real / base1.real).toBeGreaterThan(2.0);
  expect(fast.real / base1.real).toBeLessThan(4.2);

  // Set maximum 4.0x via Options
  await page.getByTestId('menu-menu').click();
  await page.getByTestId('menu-settings').click();
  await page.getByTestId('sp-speed-slider').fill('4');
  await expect(page.getByTestId('sp-speed-value')).toHaveText('4.0x');
  await expect(page.getByTestId('sp-speed-inc')).toBeDisabled();
  await page.getByTestId('options-ok').click();
  await expect(clock(page)).toHaveText(/\(4\.0\)$/);

  const maxRate = await rate(page, 6);
  expect(maxRate.speed).toBeCloseTo(4.0, 2);
  expect(maxRate.base).toBeGreaterThan(0.5);
  expect(maxRate.base).toBeLessThan(1.35);
  expect(await page.evaluate(() => window.__game!.desync())).toBeNull();
});
