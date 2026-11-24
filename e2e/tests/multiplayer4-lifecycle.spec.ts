import { expect, test, type Page } from '@playwright/test';
import {
  closeClients,
  createRoom,
  DEFAULT_MP4_URL,
  joinByCode,
  openClient,
  readyClient,
  seatLocator,
  selectRoomCapacity,
  waitForGameReady,
  type ClientHandle,
} from '../multiplayer4-helpers';

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
  throw new Error(`Timed out waiting for pause barrier (last: turn=${prev.turn}, gameTime=${prev.gameTime})`);
}

test('A03/R03: legacy default capacity-2 room starts with 2 players without waiting for 4 and rejects a 3rd', async ({ browser }, testInfo) => {
  const clients: ClientHandle[] = [];
  try {
    const host = await openClient(browser, { label: 'Alice', slot: 0 });
    const guest = await openClient(browser, { label: 'Bob', slot: 1 });
    const third = await openClient(browser, { label: 'Carol', slot: 2 });
    clients.push(host, guest, third);

    // Create without touching capacity selector -> defaults to capacity 2.
    const code = await createRoom(host, 'Alice');
    await joinByCode(guest, code, 'Bob');
    await expect(seatLocator(host.page, 1)).toContainText('Bob');

    await joinByCode(third, code, 'Carol');
    await expect(third.page.getByTestId('error')).toHaveText('That game is full.');
    await expect(third.page.getByTestId('invite-code')).toHaveCount(0);

    await readyClient(host);
    await readyClient(guest);
    await expect(host.page.getByTestId('start')).toBeEnabled();
    await host.page.getByTestId('start').click();
    await Promise.all([waitForGameReady(host), waitForGameReady(guest)]);

    await host.page.evaluate(() => window.__game!.issueTest(10, 20));
    await guest.page.evaluate(() => window.__game!.issueTest(30, 40));

    for (const c of [host, guest]) {
      await c.page.waitForFunction(() => window.__game!.turn() > 40);
    }
    const [h0, h1] = await Promise.all([
      host.page.evaluate(() => window.__game!.hash(40)),
      guest.page.evaluate(() => window.__game!.hash(40)),
    ]);
    expect(h0).toBeDefined();
    expect(h0).toBe(h1);
    expect(await host.page.evaluate(() => window.__game!.gameSetup().civs)).toHaveLength(3);
  } finally {
    await closeClients(clients, testInfo);
  }
});

test('A03/U04: switching from room4 -> single-player cancel -> room2 resets capacity, bot, and ready state', async ({ browser }, testInfo) => {
  const clients: ClientHandle[] = [];
  try {
    const host = await openClient(browser, { label: 'Alice', slot: 0 });
    const guest = await openClient(browser, { label: 'Bob', slot: 1 });
    clients.push(host, guest);

    // Create a capacity-4 room, ready up, then leave.
    await createRoom(host, 'Alice', { capacity: 4 });
    await readyClient(host);
    await host.page.getByTestId('leave').click();

    // Open Single Player setup, customize, then cancel.
    await host.page.getByTestId('single-player').click();
    await expect(host.page.getByTestId('sp-setup')).toBeVisible();
    await host.page.getByTestId('sp-difficulty').selectOption('hard');
    await host.page.getByTestId('sp-bot-civ').selectOption({ label: 'Persian' });
    await host.page.getByTestId('sp-cancel').click();
    await expect(host.page.getByTestId('sp-setup')).toHaveCount(0);

    // Explicitly create capacity-2 room -> no bot auto-spawn, not auto-readied, starts with 2.
    await selectRoomCapacity(host.page, 2);
    const code = await createRoom(host, 'Alice', { capacity: 2 });
    await expect(host.page.getByTestId('ready')).toHaveText(/^Ready$/i);
    await expect(host.page.getByTestId('start')).toBeDisabled();

    await joinByCode(guest, code, 'Bob');
    await expect(seatLocator(host.page, 1)).toContainText('Bob');
    await readyClient(host);
    await readyClient(guest);
    await expect(host.page.getByTestId('start')).toBeEnabled();
  } finally {
    await closeClients(clients, testInfo);
  }
});

test('A03/L05: single-player bot, F3 pause/resume, bounded speed, and resign-while-paused stay regression-free', async ({ browser }, testInfo) => {
  const clients: ClientHandle[] = [];
  try {
    const solo = await openClient(browser, { url: '/?debug=net&map=test', label: 'Solo', slot: 0 });
    clients.push(solo);

    await solo.page.getByTestId('single-player').click();
    await expect(solo.page.getByTestId('sp-setup')).toBeVisible();
    await solo.page.getByTestId('sp-name').fill('SoloHero');
    await solo.page.getByTestId('sp-human-civ').selectOption({ label: 'Shang' });
    await solo.page.getByTestId('sp-bot-civ').selectOption({ label: 'Yamato' });
    await solo.page.getByTestId('sp-difficulty').selectOption('medium');
    await solo.page.getByTestId('sp-start').click();

    await waitForGameReady(solo, 4);
    expect(await solo.page.evaluate(() => window.__game!.gameSetup().civs)).toEqual([0, 10, 11]);
    expect(await solo.page.evaluate(() => window.__game!.desync())).toBeNull();

    // F3 pause and resume.
    const indicator = solo.page.getByTestId('pause-indicator');
    await expect(indicator).toBeHidden();
    await solo.page.keyboard.press('F3');
    await expect(indicator).toBeVisible();
    await expect(indicator).toHaveText('PAUSED');

    const paused = await waitForPauseBarrier(solo.page);
    await solo.page.waitForTimeout(1000);
    expect(await solo.page.evaluate(() => window.__game!.turn())).toBe(paused.turn);
    expect(await solo.page.evaluate(() => window.__game!.gameTime())).toBe(paused.gameTime);

    await solo.page.keyboard.press('F3');
    await expect(indicator).toBeHidden();
    await solo.page.waitForFunction((t) => window.__game!.turn() > t + 2, paused.turn);

    // Bounded single-player speed control via Options.
    await solo.page.getByTestId('menu-menu').click();
    await solo.page.getByTestId('menu-settings').click();
    await expect(solo.page.getByTestId('sp-speed-control')).toBeVisible();
    await solo.page.getByTestId('sp-speed-slider').fill('3');
    await expect(solo.page.getByTestId('sp-speed-value')).toHaveText('3.0x');
    await solo.page.getByTestId('options-ok').click();
    await expect(solo.page.getByTestId('game-clock')).toHaveText(/\(3\.0\)$/);

    // Pause then resign while paused -> must NOT deadlock on pause barrier; bot wins cleanly (L05).
    await solo.page.keyboard.press('F3');
    await expect(indicator).toBeVisible();
    await solo.page.getByTestId('menu-menu').click();
    await solo.page.getByTestId('menu-resign').click();
    await solo.page.getByTestId('popup-yes').click();

    await solo.page.waitForFunction(() => window.__game!.gameResult() !== null, undefined, { timeout: 20_000 });
    const result = await solo.page.evaluate(() => window.__game!.gameResult());
    expect(result).not.toBeNull();
    expect(result!.winners).toEqual([2]);
    await expect(solo.page.getByTestId('game-over-text')).toHaveText('You have been defeated!');
    expect(await solo.page.evaluate(() => window.__game!.desync())).toBeNull();
  } finally {
    await closeClients(clients, testInfo);
  }
});

test('A03: legacy room2 game handles ?debug=net&map=test&speed=20 with 2-player resign termination', async ({ browser }, testInfo) => {
  const clients: ClientHandle[] = [];
  try {
    const host = await openClient(browser, { url: DEFAULT_MP4_URL, label: 'Alice', slot: 0 });
    const guest = await openClient(browser, { url: DEFAULT_MP4_URL, label: 'Bob', slot: 1 });
    clients.push(host, guest);

    const code = await createRoom(host, 'Alice', { capacity: 2 });
    await joinByCode(guest, code, 'Bob');
    await readyClient(host);
    await readyClient(guest);
    await host.page.getByTestId('start').click();
    await Promise.all([waitForGameReady(host), waitForGameReady(guest)]);

    await guest.page.getByTestId('menu-menu').click();
    await guest.page.getByTestId('menu-resign').click();
    await guest.page.getByTestId('popup-yes').click();

    await host.page.waitForFunction(() => window.__game!.gameResult() !== null);
    await guest.page.waitForFunction(() => window.__game!.gameResult() !== null);
    expect((await host.page.evaluate(() => window.__game!.gameResult()))!.winners).toEqual([1]);
    await expect(host.page.getByTestId('game-over-text')).toHaveText('You are victorious!');
    await expect(guest.page.getByTestId('game-over-text')).toHaveText('You have been defeated!');
  } finally {
    await closeClients(clients, testInfo);
  }
});
