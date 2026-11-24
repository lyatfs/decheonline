import { expect, test } from '@playwright/test';
import {
  closeClients,
  createRoom,
  DEFAULT_MP4_URL,
  extractInviteUrl,
  joinByCode,
  joinByInvite,
  openClient,
  readyClient,
  seatLocator,
  setClientCiv,
  waitForGameReady,
  withInviteParams,
  type ClientHandle,
} from '../multiplayer4-helpers';

test('A01/U05/I06: 4 contexts create capacity-4 room, 3 join by invite URL without auto-ready, and start synced 5-player world', async ({ browser }, testInfo) => {
  const clients: ClientHandle[] = [];
  try {
    const host = await openClient(browser, { label: 'Alice', slot: 0 });
    clients.push(host);

    const code = await createRoom(host, 'Alice', { capacity: 4 });
    const inviteUrl = await extractInviteUrl(host, code);

    // Opening the plain invite URL pre-fills room code without auto-ready or auto-start (I01/I02).
    const probeGuest = await openClient(browser, { url: inviteUrl, label: 'Bob', slot: 1 });
    clients.push(probeGuest);
    await expect(probeGuest.page.getByTestId('code')).toHaveValue(code);
    await expect(probeGuest.page.getByTestId('ready')).toHaveCount(0);
    await expect(probeGuest.page.getByTestId('start')).toHaveCount(0);

    // Join Bob, Carol, and Dave via invite URL (preserving ?debug=net&map=test&speed=20).
    await joinByInvite(probeGuest, inviteUrl, 'Bob', 'debug=net&map=test&speed=20');
    await expect(seatLocator(host.page, 1)).toContainText('Bob');

    const carol = await openClient(browser, { url: 'about:blank', label: 'Carol', slot: 2 });
    clients.push(carol);
    await joinByInvite(carol, inviteUrl, 'Carol', 'debug=net&map=test&speed=20');
    await expect(seatLocator(host.page, 2)).toContainText('Carol');

    // Start must stay disabled with 3/4 players even if all 3 are ready (R02).
    for (const c of [host, probeGuest, carol]) await readyClient(c);
    await expect(host.page.getByTestId('start')).toBeDisabled();

    const dave = await openClient(browser, { url: 'about:blank', label: 'Dave', slot: 3 });
    clients.push(dave);
    await joinByInvite(dave, inviteUrl, 'Dave', 'debug=net&map=test&speed=20');
    await expect(seatLocator(host.page, 3)).toContainText('Dave');

    // Joining resets ready flags; pick distinct civs, ready all 4, and verify only host gets Start.
    const desiredCivs = [1, 2, 10, 11] as const;
    for (let slot = 0; slot < 4; slot++) {
      await setClientCiv(clients[slot]!, desiredCivs[slot]!);
    }
    await expect(host.page.getByTestId('start')).toBeDisabled();
    for (const client of clients) await readyClient(client);
    await expect(host.page.getByTestId('start')).toBeEnabled();
    for (const guest of clients.slice(1)) {
      await expect(guest.page.getByTestId('start')).toHaveCount(0);
    }

    await host.page.getByTestId('start').click();
    await Promise.all(clients.map((c) => waitForGameReady(c)));

    const setups = await Promise.all(
      clients.map((c) =>
        c.page.evaluate(() => ({
          player: window.__game!.player(),
          setup: window.__game!.gameSetup(),
        })),
      ),
    );
    expect(setups.map((s) => s.player)).toEqual([1, 2, 3, 4]);
    for (const s of setups) {
      expect(s.setup.civs).toEqual([0, 1, 2, 10, 11]);
    }
  } finally {
    await closeClients(clients, testInfo);
  }
});

test('A02/R01: 5th client join is rejected with room-full and late join after start is rejected with room-started', async ({ browser }, testInfo) => {
  const clients: ClientHandle[] = [];
  try {
    const host = await openClient(browser, { label: 'Alice', slot: 0 });
    clients.push(host);
    const code = await createRoom(host, 'Alice', { capacity: 4 });
    const inviteUrl = await extractInviteUrl(host, code);

    for (const [slot, name] of [[1, 'Bob'], [2, 'Carol'], [3, 'Dave']] as const) {
      const guest = await openClient(browser, { url: 'about:blank', label: name, slot });
      clients.push(guest);
      await joinByInvite(guest, inviteUrl, name, 'debug=net&map=test&speed=20');
      await expect(seatLocator(host.page, slot)).toContainText(name);
    }

    // 5th client attempts to join full room4.
    const fifth = await openClient(browser, { label: 'Eve', slot: 4 });
    clients.push(fifth);
    await joinByCode(fifth, code, 'Eve');
    await expect(fifth.page.getByTestId('error')).toHaveText('That game is full.');
    await expect(fifth.page.getByTestId('invite-code')).toHaveCount(0);

    // Existing 4 seats remain intact.
    for (let slot = 0; slot < 4; slot++) {
      await expect(seatLocator(host.page, slot)).toBeVisible();
    }

    // Start the 4-player game, then Eve attempts join again -> room-started.
    for (const client of clients.slice(0, 4)) await readyClient(client);
    await host.page.getByTestId('start').click();
    await Promise.all(clients.slice(0, 4).map((c) => waitForGameReady(c)));

    await fifth.page.getByTestId('join').click();
    await expect(fifth.page.getByTestId('error')).toHaveText('That game has already started.');
    await expect(fifth.page.getByTestId('invite-code')).toHaveCount(0);
  } finally {
    await closeClients(clients, testInfo);
  }
});

test('A02/I03/I05: invalid or malformed invite links show clear error, prevent XSS, and preserve form for retry', async ({ browser }, testInfo) => {
  const clients: ClientHandle[] = [];
  try {
    const host = await openClient(browser, { label: 'Alice', slot: 0 });
    clients.push(host);
    const validCode = await createRoom(host, 'Alice', { capacity: 4 });

    const origin = new URL(host.page.url()).origin;
    const xssProbeUrl = `${origin}/?room=${encodeURIComponent('<img src=x onerror="window.__xss=1">')}&debug=net&map=test&speed=20`;
    const guest = await openClient(browser, { url: xssProbeUrl, label: 'RetryGuest', slot: 1 });
    clients.push(guest);

    expect(await guest.page.evaluate(() => (window as unknown as { __xss?: unknown }).__xss)).toBeUndefined();

    // Try a non-existent 5-character code while user name is filled.
    await joinByCode(guest, 'ZZZZZ', 'RetryGuest');
    await expect(guest.page.getByTestId('error')).toHaveText('No game with that invite code.');
    await expect(guest.page.getByTestId('invite-code')).toHaveCount(0);

    // User's entered name and code input remain preserved and editable for retry.
    await expect(guest.page.getByTestId('name')).toHaveValue('RetryGuest');
    await expect(guest.page.getByTestId('code')).toHaveValue('ZZZZZ');

    // Retry with the real room code succeeds without re-typing the name.
    await guest.page.getByTestId('code').fill(validCode);
    await guest.page.getByTestId('join').click();
    await expect(seatLocator(host.page, 1)).toContainText('RetryGuest');
    await expect(seatLocator(guest.page, 1)).toContainText('RetryGuest');
  } finally {
    await closeClients(clients, testInfo);
  }
});

test('A02/U03/R04: non-0 host role transfers cleanly when host leaves lobby with a hole without renumbering seats', async ({ browser }, testInfo) => {
  const clients: ClientHandle[] = [];
  try {
    const alice = await openClient(browser, { label: 'Alice', slot: 0 });
    clients.push(alice);
    const code = await createRoom(alice, 'Alice', { capacity: 4 });
    const inviteUrl = await extractInviteUrl(alice, code);

    const bob = await openClient(browser, { url: 'about:blank', label: 'Bob', slot: 1 });
    const carol = await openClient(browser, { url: 'about:blank', label: 'Carol', slot: 2 });
    const dave = await openClient(browser, { url: 'about:blank', label: 'Dave', slot: 3 });
    clients.push(bob, carol, dave);

    await joinByInvite(bob, inviteUrl, 'Bob', 'debug=net&map=test&speed=20');
    await joinByInvite(carol, inviteUrl, 'Carol', 'debug=net&map=test&speed=20');
    await joinByInvite(dave, inviteUrl, 'Dave', 'debug=net&map=test&speed=20');
    await expect(seatLocator(alice.page, 3)).toContainText('Dave');

    // Carol picks a non-default civ and readies up before membership changes.
    await setClientCiv(carol, 9);
    await readyClient(carol);
    await readyClient(dave);

    // Bob (slot 1) leaves -> creates a hole; then Alice (slot 0, host) leaves -> host transfers to Carol (slot 2).
    await bob.page.getByTestId('leave').click();
    await alice.page.getByTestId('leave').click();

    // Carol (slot 2) is now host, keeps slot 2 & civ 9, and ready flags cleared after membership change (U02).
    await expect(seatLocator(carol.page, 2)).toContainText('Carol');
    await expect(seatLocator(carol.page, 2)).toContainText('(host)');
    await expect(seatLocator(carol.page, 3)).toContainText('Dave');
    await expect(carol.page.getByTestId('start')).toBeVisible();
    await expect(carol.page.getByTestId('start')).toBeDisabled();
    await expect(carol.page.getByTestId('map-size')).toBeEnabled();
    await expect(dave.page.getByTestId('start')).toHaveCount(0);
    await expect(carol.page.getByTestId('ready')).toHaveText(/^Ready$/i);
    await expect(carol.page.getByTestId('civ-2')).toHaveValue('9');

    // Newcomers fill lowest open slots (0, then 1) without stealing host role from Carol.
    const eve = await openClient(browser, { url: withInviteParams(inviteUrl, 'debug=net&map=test&speed=20'), label: 'Eve', slot: 0 });
    const frank = await openClient(browser, { url: withInviteParams(inviteUrl, 'debug=net&map=test&speed=20'), label: 'Frank', slot: 1 });
    clients.push(eve, frank);

    await eve.page.getByTestId('name').fill('Eve');
    await eve.page.getByTestId('join').click();
    await expect(seatLocator(carol.page, 0)).toContainText('Eve');
    await expect(eve.page.getByTestId('start')).toHaveCount(0);

    await frank.page.getByTestId('name').fill('Frank');
    await frank.page.getByTestId('join').click();
    await expect(seatLocator(carol.page, 1)).toContainText('Frank');

    const active = [eve, frank, carol, dave];
    for (const client of active) await readyClient(client);
    await expect(carol.page.getByTestId('start')).toBeEnabled();
    await carol.page.getByTestId('start').click();
    await Promise.all(active.map((c) => waitForGameReady(c)));

    const carolSetup = await carol.page.evaluate(() => ({
      player: window.__game!.player(),
      civs: window.__game!.gameSetup().civs,
    }));
    expect(carolSetup.player).toBe(3); // slot 2 -> sim player 3
    expect(carolSetup.civs[3]).toBe(9);
  } finally {
    await closeClients(clients, testInfo);
  }
});

test('A02/U01: 390px narrow viewport renders 4-seat lobby cleanly without horizontal overflow and locks scroll in game', async ({ browser }, testInfo) => {
  const clients: ClientHandle[] = [];
  const viewport = { width: 390, height: 844 };
  try {
    const host = await openClient(browser, { url: DEFAULT_MP4_URL, label: 'MobileHost', slot: 0, viewport });
    clients.push(host);

    const entryFits = await host.page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 2);
    expect(entryFits).toBe(true);

    const code = await createRoom(host, 'MobileHost', { capacity: 4 });
    const inviteUrl = await extractInviteUrl(host, code);

    for (const [slot, name] of [[1, 'Guest1'], [2, 'Guest2'], [3, 'Guest3']] as const) {
      const guest = await openClient(browser, { url: 'about:blank', label: name, slot, viewport });
      clients.push(guest);
      await joinByInvite(guest, inviteUrl, name, 'debug=net&map=test&speed=20');
      await expect(seatLocator(host.page, slot)).toContainText(name);
    }

    const lobbyFits = await host.page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 2);
    expect(lobbyFits).toBe(true);

    for (let slot = 0; slot < 4; slot++) {
      await expect(seatLocator(host.page, slot)).toBeVisible();
    }

    for (const client of clients) {
      await client.page.getByTestId('ready').scrollIntoViewIfNeeded();
      await readyClient(client);
    }

    const startBtn = host.page.getByTestId('start');
    await startBtn.scrollIntoViewIfNeeded();
    await expect(startBtn).toBeEnabled();
    await startBtn.click();

    await Promise.all(clients.map((c) => waitForGameReady(c)));
    await host.page.mouse.wheel(0, 500);
    await host.page.waitForTimeout(200);
    expect(await host.page.evaluate(() => [window.scrollY, document.documentElement.scrollTop, document.body.scrollTop])).toEqual([0, 0, 0]);
  } finally {
    await closeClients(clients, testInfo);
  }
});
