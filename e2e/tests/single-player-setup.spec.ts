import { expect, test, type Browser, type Page } from '@playwright/test';

const URL = '/?debug=net&speed=20';

async function open(browser: Browser, url = URL, viewport?: { width: number; height: number }): Promise<Page> {
  const context = await browser.newContext(viewport ? { viewport } : undefined);
  const page = await context.newPage();
  await page.goto(url);
  return page;
}

test('U01: single-player setup propagates player name, human/bot civs, map type/size, victory, and difficulty to game start', async ({ browser }) => {
  const page = await open(browser);

  await page.getByTestId('single-player').click();
  await expect(page.getByTestId('sp-setup')).toBeVisible();
  await expect(page.getByTestId('invite-code')).toHaveCount(0);

  await page.getByTestId('sp-name').fill('Tester');
  await page.getByTestId('sp-human-civ').selectOption({ label: 'Shang' });
  await page.getByTestId('sp-bot-civ').selectOption({ label: 'Yamato' });
  await page.getByTestId('sp-difficulty').selectOption('hard');
  await page.getByTestId('sp-map-type').selectOption({ label: 'Hill Country' });
  await page.getByTestId('sp-map-size').selectOption('96');
  await page.getByTestId('sp-victory').selectOption({ label: 'Conquest' });

  await page.getByTestId('sp-start').click();

  await expect(page.getByTestId('game-canvas')).toBeVisible();
  await page.waitForFunction(() => window.__game !== undefined && window.__map !== undefined);

  const started = await page.evaluate(() => ({
    setup: window.__game!.gameSetup(),
    width: window.__map!.width,
    height: window.__map!.height,
  }));
  expect(started.setup.civs).toEqual([0, 10, 11]);
  expect(started.setup.victory.type).toBe(1);
  expect(started.width).toBe(96);
  expect(started.height).toBe(96);

  await page.waitForFunction(() => window.__game!.turn() > 12);
  expect(await page.evaluate(() => window.__game!.desync())).toBeNull();
});

test('U01/A04: validation error, keyboard Enter/Escape, Random civs, and narrow viewport usability', async ({ browser }) => {
  const page = await open(browser, URL, { width: 390, height: 844 });

  await page.getByTestId('single-player').click();
  await expect(page.getByTestId('sp-setup')).toBeVisible();

  const fitsViewport = await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 2);
  expect(fitsViewport).toBe(true);

  // Escape cancels back to entry screen
  await page.getByTestId('sp-name').press('Escape');
  await expect(page.getByTestId('sp-setup')).toHaveCount(0);
  await expect(page.getByTestId('create')).toBeVisible();

  // Re-open, validate empty name error
  await page.getByTestId('single-player').click();
  await page.getByTestId('sp-name').fill('   ');
  await page.getByTestId('sp-start').click();
  await expect(page.getByTestId('sp-error')).toBeVisible();
  await expect(page.getByTestId('sp-error')).toContainText('player name');

  // Fill valid name, pick Random civs, Easy difficulty, Tiny map, and submit via Enter
  await page.getByTestId('sp-name').fill('MobileHero');
  await page.getByTestId('sp-human-civ').selectOption({ label: 'Random' });
  await page.getByTestId('sp-bot-civ').selectOption({ label: 'Random' });
  await page.getByTestId('sp-difficulty').selectOption('easy');
  await page.getByTestId('sp-map-size').selectOption('72');
  await page.getByTestId('sp-name').press('Enter');

  await expect(page.getByTestId('game-canvas')).toBeVisible();
  await page.waitForFunction(() => window.__game !== undefined && window.__map !== undefined);
  const setup = await page.evaluate(() => ({
    civs: window.__game!.gameSetup().civs,
    width: window.__map!.width,
  }));
  expect(setup.width).toBe(72);
  expect(setup.civs[1]).toBeGreaterThanOrEqual(1);
  expect(setup.civs[1]).toBeLessThanOrEqual(16);
  expect(setup.civs[2]).toBeGreaterThanOrEqual(1);
  expect(setup.civs[2]).toBeLessThanOrEqual(16);
});

test('U02/U04: cancelling single-player setup and entering multiplayer never auto-readies, auto-starts, or retains bot', async ({ browser }) => {
  const host = await open(browser);

  // Open single-player, customize, then cancel
  await host.getByTestId('single-player').click();
  await host.getByTestId('sp-difficulty').selectOption('hard');
  await host.getByTestId('sp-bot-civ').selectOption({ label: 'Persian' });
  await host.getByTestId('sp-cancel').click();
  await expect(host.getByTestId('sp-setup')).toHaveCount(0);

  // Enter multiplayer create room
  await host.getByTestId('name').fill('Alice');
  await host.getByTestId('create').click();
  const code = (await host.getByTestId('invite-code').textContent())!;
  expect(code).toMatch(/^[A-Z0-9]{5}$/);

  await expect(host.getByTestId('player-0')).toContainText('Alice (host) - not ready');
  await expect(host.getByTestId('player-1')).toHaveCount(0);
  await expect(host.getByTestId('start')).toBeDisabled();

  // Normal multiplayer guest join works cleanly without bot interference
  const guest = await open(browser);
  await guest.getByTestId('name').fill('Bob');
  await guest.getByTestId('code').fill(code);
  await guest.getByTestId('join').click();

  await expect(host.getByTestId('player-1')).toContainText('Bob - not ready');
  await expect(host.getByTestId('start')).toBeDisabled();
});
