import { expect, test, type Locator } from '@playwright/test';
import {
  closeClients,
  createRoom,
  DEFAULT_MP4_URL,
  expectHashRangeEqual,
  expectSameTurnHashes,
  extractInviteUrl,
  joinByInvite,
  openClient,
  readyClient,
  seatLocator,
  startFourPlayerMatch,
  waitForGameReady,
  waitForTurn,
  type ClientHandle,
} from '../multiplayer4-helpers';

const icons = (line: Locator) =>
  line
    .locator('[data-testid^="score-"]:visible')
    .evaluateAll((els) => els.map((el) => `${el.getAttribute('data-testid')} ${el.getAttribute('data-frame')}`));

test('A04/N03: fake RTT and slow frames on 1 of 4 peers adapt G/F, show F4 icons, and preserve same-turn hashes', async ({ browser }, testInfo) => {
  test.setTimeout(120_000);
  const match = await startFourPlayerMatch(browser, testInfo, { url: DEFAULT_MP4_URL });
  const { clients } = match;
  try {
    await clients[0].page.keyboard.press('F4');
    for (const c of clients) {
      await c.page.evaluate(() => window.__game!.forceFrameMs(30));
    }
    await clients[0].page.waitForFunction(() => window.__game!.net().rtt.length === 4);

    // Issue moves from all 4 players, then inject fake 1500 ms RTT and 150 ms frames on slot 3 (Dave).
    for (const c of clients) {
      await c.page.evaluate(() => {
        const g = window.__game!;
        const ids = g.units().filter((u) => u.owner === g.player()).map((u) => u.id);
        g.issueMove(ids, 20, 20);
      });
    }

    await clients[3].page.evaluate(() => {
      window.__game!.forceFrameMs(150);
      window.__game!.delayPongs(1500);
    });

    await clients[0].page.waitForFunction(() => (window.__game!.net().rtt[3] ?? 0) >= 1500, undefined, { timeout: 30_000 });
    for (const c of clients) {
      await c.page.waitForFunction(
        () => {
          const { granularity, frames } = window.__game!.net();
          return frames === 20 || granularity * frames >= 1500;
        },
        undefined,
        { timeout: 30_000 },
      );
    }

    const hostNet = await clients[0].page.evaluate(() => window.__game!.net());
    for (const guest of clients.slice(1)) {
      const guestNet = await guest.page.evaluate(() => window.__game!.net());
      expect({ granularity: guestNet.granularity, frames: guestNet.frames }).toEqual({
        granularity: hostNet.granularity,
        frames: hostNet.frames,
      });
    }

    const daveLine = clients[0].page.getByTestId('score-line').filter({ hasText: /^Dave:/ });
    await expect.poll(() => icons(daveLine), { timeout: 30_000 }).toContain('score-latency 20');

    const baseTurn = await clients[0].page.evaluate(() => window.__game!.turn());
    const target = baseTurn + 24;
    await waitForTurn(clients, target);
    await expectHashRangeEqual(clients, baseTurn, target - 4);
  } finally {
    await closeClients(clients, testInfo);
  }
});

test('A04/N05: mid-game drop and rejoin replays missed turns once without duplicate commands or slot drift', async ({ browser }, testInfo) => {
  test.setTimeout(120_000);
  const match = await startFourPlayerMatch(browser, testInfo, { url: DEFAULT_MP4_URL });
  const { clients } = match;
  const [alice, bob, carol, dave] = clients;
  try {
    await dave.page.evaluate(() => window.__game!.issueTest(77, 88));
    await dave.page.waitForFunction(() => window.__game!.applied()[3]?.length === 1);
    const droppedAt = await dave.page.evaluate(() => window.__game!.turn());

    // Break Dave's socket for 10 s (< DROP_AFTER_MS=40s) while the other 3 submit commands.
    await dave.page.evaluate(() => window.__game!.dropLink(10_000));
    await alice.page.evaluate(() => window.__game!.issueTest(11, 12));
    await bob.page.evaluate(() => window.__game!.issueTest(21, 22));
    await carol.page.evaluate(() => window.__game!.issueTest(31, 32));

    const targetTurn = droppedAt + 40;
    await waitForTurn(clients, targetTurn);
    await expectHashRangeEqual(clients, Math.max(0, droppedAt - 4), targetTurn - 4);

    const states = await Promise.all(
      clients.map((c) =>
        c.page.evaluate(() => ({
          player: window.__game!.player(),
          applied: window.__game!.applied(),
        })),
      ),
    );
    expect(states.map((s) => s.player)).toEqual([1, 2, 3, 4]);
    for (const s of states) {
      expect(s.applied).toEqual(states[0]!.applied);
    }
    expect(states[0]!.applied[0]).toEqual([{ type: 'test', x: 11, y: 12 }]);
    expect(states[0]!.applied[1]).toEqual([{ type: 'test', x: 21, y: 22 }]);
    expect(states[0]!.applied[2]).toEqual([{ type: 'test', x: 31, y: 32 }]);
    expect(states[0]!.applied[3]).toEqual([{ type: 'test', x: 77, y: 88 }]);

    for (const c of clients) {
      await expect(c.page.getByTestId('opponent-left')).toHaveCount(0);
    }
  } finally {
    await closeClients(clients, testInfo);
  }
});

test('A04/L01: resigned player closing tab leaves remaining 3 active and synced without ending match', async ({ browser }, testInfo) => {
  const match = await startFourPlayerMatch(browser, testInfo, { url: DEFAULT_MP4_URL });
  const [alice, bob, carol, dave] = match.clients;
  try {
    await carol.page.getByTestId('menu-menu').click();
    await carol.page.getByTestId('menu-resign').click();
    await carol.page.getByTestId('popup-yes').click();
    await expect(alice.page.getByTestId('chat-line').filter({ hasText: 'Carol resigned.' })).toBeVisible();

    await carol.page.close();
    await carol.context.close();

    const remaining = [alice, bob, dave];
    const currentTurn = await alice.page.evaluate(() => window.__game!.turn());
    await alice.page.evaluate(() => window.__game!.issueTest(91, 92));
    await dave.page.evaluate(() => window.__game!.issueTest(93, 94));

    const target = currentTurn + 24;
    await waitForTurn(remaining, target);
    await expectSameTurnHashes(remaining, target - 4);

    for (const active of remaining) {
      expect(await active.page.evaluate(() => window.__game!.gameResult())).toBeNull();
      await expect(active.page.getByTestId('opponent-left')).toHaveCount(0);
    }
  } finally {
    await closeClients([alice, bob, dave], testInfo);
  }
});

test('A04/L02: prolonged drop past DROP_AFTER_MS removes timed-out peer and remaining 3 continue in sync', async ({ browser }, testInfo) => {
  test.setTimeout(150_000);
  const match = await startFourPlayerMatch(browser, testInfo, { url: DEFAULT_MP4_URL });
  const [alice, bob, carol, dave] = match.clients;
  try {
    await alice.page.keyboard.press('F4');
    const daveScore = alice.page.getByTestId('score-line').filter({ hasText: /^Dave:/ }).first();
    await expect(daveScore).toBeVisible();

    // Hold Dave's socket disconnected past e2e DROP_AFTER_MS (40s).
    await dave.page.evaluate(() => window.__game!.dropLink(90_000));
    await expect
      .poll(() => daveScore.evaluate((el) => getComputedStyle(el).textDecorationLine), { timeout: 90_000 })
      .toContain('line-through');

    const remaining = [alice, bob, carol];
    const turnAfterDrop = await alice.page.evaluate(() => window.__game!.turn());
    await alice.page.evaluate(() => window.__game!.issueTest(5, 6));
    await waitForTurn(remaining, turnAfterDrop + 16);
    await expectSameTurnHashes(remaining, turnAfterDrop + 12);

    for (const active of remaining) {
      expect(await active.page.evaluate(() => window.__game!.gameResult())).toBeNull();
      await expect(active.page.getByTestId('opponent-left')).toHaveCount(0);
    }
  } finally {
    await closeClients(match.clients, testInfo);
  }
});

test('A04/L05/C02: host-role transfer in lobby and mid-game host resign never terminate match or allow pause', async ({ browser }, testInfo) => {
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

    // Alice (slot 0) leaves -> hostSlot transfers to Bob (slot 1).
    await alice.page.getByTestId('leave').click();
    await expect(seatLocator(bob.page, 1)).toContainText('(host)');
    await expect(bob.page.getByTestId('start')).toBeVisible();

    const eve = await openClient(browser, { url: 'about:blank', label: 'Eve', slot: 0 });
    clients.push(eve);
    await joinByInvite(eve, inviteUrl, 'Eve', 'debug=net&map=test&speed=20');
    await expect(seatLocator(bob.page, 0)).toContainText('Eve');
    await expect(eve.page.getByTestId('start')).toHaveCount(0);

    const active = [eve, bob, carol, dave];
    for (const c of active) await readyClient(c);
    await expect(bob.page.getByTestId('start')).toBeEnabled();
    await bob.page.getByTestId('start').click();
    await Promise.all(active.map((c) => waitForGameReady(c)));

    // Bob (the match host) resigns and quits -> remaining 3 continue and cannot pause via F3.
    await bob.page.getByTestId('menu-menu').click();
    await bob.page.getByTestId('menu-quit').click();
    await bob.page.getByTestId('popup-yes').click();
    await expect(bob.page.getByTestId('achievements')).toBeVisible();

    const survivors = [eve, carol, dave];
    for (const s of survivors) {
      await s.page.keyboard.press('F3');
      await expect(s.page.getByTestId('pause-indicator')).toBeHidden();
    }

    const turnAfter = await eve.page.evaluate(() => window.__game!.turn());
    await waitForTurn(survivors, turnAfter + 12);
    await expectSameTurnHashes(survivors, turnAfter + 8);
    for (const s of survivors) {
      expect(await s.page.evaluate(() => window.__game!.gameResult())).toBeNull();
    }
  } finally {
    await closeClients(clients, testInfo);
  }
});
