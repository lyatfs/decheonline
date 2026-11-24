import { expect, test, type Browser, type Page } from '@playwright/test';

const URL = '/?debug=net&map=test';
const VILLAGER = 83;

const applied = (page: Page, type: string) => page.evaluate((t) => window.__game!.applied().flat().filter((c) => c.type === t), type);

async function waitForPauseBarrier(page: Page, timeoutMs = 10_000): Promise<{ turn: number; gameTime: number }> {
  const deadline = Date.now() + timeoutMs;
  let prev = await page.evaluate(() => ({ turn: window.__game!.turn(), gameTime: window.__game!.gameTime() }));
  let stableSamples = 0;
  while (Date.now() < deadline) {
    await page.waitForTimeout(350);
    const curr = await page.evaluate(() => ({ turn: window.__game!.turn(), gameTime: window.__game!.gameTime() }));
    if (curr.turn === prev.turn && curr.gameTime === prev.gameTime) {
      stableSamples += 1;
      if (stableSamples >= 2) return curr;
    } else {
      stableSamples = 0;
      prev = curr;
    }
  }
  throw new Error(`Timed out waiting for pause barrier to stabilize (last: turn=${prev.turn}, gameTime=${prev.gameTime})`);
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
  await page.waitForFunction(() => window.__game?.selection() != null && window.__game.turn() > 4);
  return page;
}

async function startMultiplayer(browser: Browser): Promise<[Page, Page]> {
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
  for (const page of [host, guest]) {
    await page.waitForFunction(() => window.__game?.selection() != null && window.__game.turn() > 4);
  }
  return [host, guest];
}

test('single-player F3 pauses and resumes cleanly without stall or desync, and respects input/modal guards (Q01-Q05, A04)', async ({ browser }) => {
  const page = await startSinglePlayer(browser);
  const indicator = page.getByTestId('pause-indicator');
  await expect(indicator).toBeHidden();

  // F3 pauses the game and freezes turn and gameTime once coasting reaches pauseBoundary
  await page.keyboard.press('F3');
  await expect(indicator).toBeVisible();
  await expect(indicator).toHaveText('PAUSED');

  const { turn: pausedTurn, gameTime: pausedTime } = await waitForPauseBarrier(page);
  await page.waitForTimeout(1500);
  expect(await page.evaluate(() => window.__game!.turn())).toBe(pausedTurn);
  expect(await page.evaluate(() => window.__game!.gameTime())).toBe(pausedTime);
  expect(await page.getByTestId('chat-line').filter({ hasText: 'Problem communicating' }).count()).toBe(0);

  // A04: F3 inside quick-chat input does NOT toggle pause
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('quick-chat')).toBeVisible();
  await page.keyboard.press('F3');
  await expect(indicator).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('quick-chat')).toHaveCount(0);

  // A04: F3 while Menu modal is open does NOT toggle pause
  await page.getByTestId('menu-menu').click();
  await expect(page.getByTestId('menu-dialog')).toBeVisible();
  await page.keyboard.press('F3');
  await expect(indicator).toBeVisible();
  await page.getByTestId('menu-cancel').click();

  // F3 resumes; turn and gameTime continue advancing with zero desync
  await page.keyboard.press('F3');
  await expect(indicator).toBeHidden();
  await page.waitForFunction((t) => window.__game!.turn() > t + 3, pausedTurn);
  expect(await page.evaluate(() => window.__game!.gameTime())).toBeGreaterThan(pausedTime);
  expect(await page.evaluate(() => window.__game!.desync())).toBeNull();

  // Game Settings options-pause button toggles pause and resume in single-player
  await page.getByTestId('menu-menu').click();
  await page.getByTestId('menu-settings').click();
  await expect(page.getByTestId('options-pause')).toBeVisible();
  await expect(page.getByTestId('options-pause')).toBeEnabled();
  await page.getByTestId('options-pause').click();
  await expect(indicator).toBeVisible();

  const optionsPaused = await waitForPauseBarrier(page);
  await page.waitForTimeout(1500);
  expect(await page.evaluate(() => window.__game!.turn())).toBe(optionsPaused.turn);
  expect(await page.evaluate(() => window.__game!.gameTime())).toBe(optionsPaused.gameTime);

  await page.getByTestId('menu-menu').click();
  await page.getByTestId('menu-settings').click();
  await expect(page.getByTestId('options-pause')).toHaveText('Resume Game');
  await page.getByTestId('options-pause').click();
  await expect(indicator).toBeHidden();
  await page.waitForFunction((t) => window.__game!.turn() > t + 2, optionsPaused.turn);
  expect(await page.evaluate(() => window.__game!.gameTime())).toBeGreaterThan(optionsPaused.gameTime);
  expect(await page.evaluate(() => window.__game!.desync())).toBeNull();
});

test('multiplayer blocks F3 pause and hides options pause control while keeping Shift+F3 formation (Q04)', async ({ browser }) => {
  const [host, guest] = await startMultiplayer(browser);

  await host.keyboard.press('F3');
  await expect(host.getByTestId('pause-indicator')).toBeHidden();
  await expect(guest.getByTestId('pause-indicator')).toBeHidden();

  await host.getByTestId('menu-menu').click();
  await host.getByTestId('menu-settings').click();
  await expect(host.getByTestId('options-pause')).toBeHidden();
  await host.getByTestId('options-cancel').click();

  // Shift+F3 keeps formation 1 behavior in multiplayer
  const villagers = (await host.evaluate(() => window.__game!.units())).filter((u) => u.owner === 1 && u.type === VILLAGER);
  const box = (await host.getByTestId('game-canvas').boundingBox())!;
  const at = await Promise.all(villagers.map((v) => host.evaluate((id) => window.__game!.unitScreenPos(id)!, v.id)));
  const xs = at.map((p) => p.x);
  const ys = at.map((p) => p.y);
  await host.mouse.move(box.x + Math.min(...xs) - 30, box.y + Math.min(...ys) - 40);
  await host.mouse.down();
  await host.mouse.move(box.x + Math.max(...xs) + 30, box.y + Math.max(...ys) + 20, { steps: 5 });
  await host.mouse.up();
  await expect.poll(async () => (await host.evaluate(() => window.__game!.selection()))?.length ?? 0).toBe(villagers.length);
  await host.keyboard.press('Shift+F3');
  for (const page of [host, guest]) {
    await expect.poll(() => applied(page, 'formation')).toHaveLength(1);
    const [cmd] = (await applied(page, 'formation')) as unknown as { units: number[]; formation: number }[];
    expect(cmd!.formation).toBe(1);
    expect([...cmd!.units].sort()).toEqual(villagers.map((v) => v.id).sort());
  }
  await expect(host.getByTestId('pause-indicator')).toBeHidden();
  await expect(guest.getByTestId('pause-indicator')).toBeHidden();

  // Game continues advancing in multiplayer
  const turn = await host.evaluate(() => window.__game!.turn());
  await host.waitForFunction((t) => window.__game!.turn() > t + 2, turn);
  expect(await host.evaluate(() => window.__game!.desync())).toBeNull();
});
