import { expect, test, type Page } from '@playwright/test';
import {
  closeClients,
  DEFAULT_MP4_URL,
  expectHashRangeEqual,
  expectSameTurnHashes,
  startFourPlayerMatch,
  STATUS_LOST,
  STATUS_PLAYING,
  STATUS_WON,
  waitForTurn,
} from '../multiplayer4-helpers';

const TOWN_CENTER = 109;
const VILLAGER = 83;

async function menuResign(page: Page): Promise<void> {
  await page.getByTestId('menu-menu').click();
  await page.getByTestId('menu-resign').click();
  await page.getByTestId('popup-yes').click();
}

test('A01/N01/N06: all 4 clients issue test and unit move commands and produce identical same-turn hashes', async ({ browser }, testInfo) => {
  const match = await startFourPlayerMatch(browser, testInfo, { url: DEFAULT_MP4_URL });
  const { clients } = match;
  try {
    // Out-of-slot-order test commands and real villager moves from all 4 clients.
    await clients[3].page.evaluate(() => window.__game!.issueTest(40, 44));
    await clients[1].page.evaluate(() => window.__game!.issueTest(20, 22));
    await clients[0].page.evaluate(() => window.__game!.issueTest(10, 12));
    await clients[2].page.evaluate(() => window.__game!.issueTest(30, 33));

    for (const client of clients) {
      await client.page.evaluate(() => {
        const g = window.__game!;
        const me = g.player();
        const myVillagers = g.units().filter((u) => u.owner === me);
        const first = myVillagers[0];
        if (first) g.issueMove([first.id], first.col + 2, first.row + 2);
      });
    }

    await waitForTurn(clients, 10);
    // Additional staggered command after single-step turns finish.
    await clients[2].page.evaluate(() => window.__game!.issueTest(55, 66));

    await waitForTurn(clients, 52);
    await expectHashRangeEqual(clients, 8, 48);

    const states = await Promise.all(
      clients.map((c) =>
        c.page.evaluate(() => ({
          player: window.__game!.player(),
          applied: window.__game!.applied().map((cmds) => cmds.map((cmd) => cmd.type)),
          owners: window.__game!.entityOwners().slice().sort((a, b) => a - b),
          villagers: window.__game!
            .units()
            .filter((u) => u.type === 83)
            .map((u) => ({ id: u.id, owner: u.owner, x: u.x, y: u.y })),
        })),
      ),
    );

    expect(states.map((s) => s.player)).toEqual([1, 2, 3, 4]);
    for (const state of states) {
      expect(state.applied).toEqual([
        ['test', 'move'],
        ['test', 'move'],
        ['test', 'move', 'test'],
        ['test', 'move'],
      ]);
      expect(state.owners).toEqual([1, 2, 3, 4]);
      expect(state.villagers).toEqual(states[0]!.villagers);
    }
  } finally {
    await closeClients(clients, testInfo);
  }
});

test('A01/W02/W05: 4 clients play a seeded random map with distinct civs, distinct spawns, and equal hashes', async ({ browser }, testInfo) => {
  const match = await startFourPlayerMatch(browser, testInfo, {
    url: '/?debug=net&speed=20&seed=12345',
    civs: [1, 2, 10, 11],
    settings: { mapSize: '120', mapType: 'Mostly Land' },
  });
  const { clients } = match;
  try {
    const maps = await Promise.all(
      clients.map((c) =>
        c.page.evaluate(
          ({ tcType, villagerType }) => {
            const g = window.__game!;
            const m = window.__map!;
            const tcs = [1, 2, 3, 4].map((p) => {
              const tc = g.buildings().find((b) => b.owner === p && b.type === tcType);
              const v = g.units().find((u) => u.owner === p && u.type === villagerType);
              return tc ? { x: tc.x, y: tc.y } : v ? { x: v.x, y: v.y } : null;
            });
            return {
              width: m.width,
              height: m.height,
              mapHash: m.mapHash,
              civs: g.gameSetup().civs,
              spawns: tcs,
            };
          },
          { tcType: TOWN_CENTER, villagerType: VILLAGER },
        ),
      ),
    );

    for (const m of maps) {
      expect(m.width).toBe(120);
      expect(m.height).toBe(120);
      expect(m.mapHash).toBe(maps[0]!.mapHash);
      expect(m.civs).toEqual([0, 1, 2, 10, 11]);
      for (const spawn of m.spawns) expect(spawn).not.toBeNull();
    }

    // All 4 spawns on the random map are distinct and separated.
    const spawns = maps[0]!.spawns as { x: number; y: number }[];
    for (let i = 0; i < spawns.length; i++) {
      for (let j = i + 1; j < spawns.length; j++) {
        const dist = Math.hypot(spawns[i]!.x - spawns[j]!.x, spawns[i]!.y - spawns[j]!.y);
        expect(dist, `spawn ${i + 1} vs ${j + 1}`).toBeGreaterThan(10);
      }
    }

    for (const client of clients) {
      await client.page.evaluate(() => {
        const g = window.__game!;
        const me = g.player();
        const mine = g.units().filter((u) => u.owner === me).map((u) => u.id);
        if (mine.length > 0) g.issueMove(mine, 60, 60);
      });
    }

    await waitForTurn(clients, 40);
    await expectHashRangeEqual(clients, 8, 36);
  } finally {
    await closeClients(clients, testInfo);
  }
});

test('A01/H01/H03: 4-player scoreboard, targeted chat, and diplomacy/tribute work across all 4 players in sync', async ({ browser }, testInfo) => {
  const match = await startFourPlayerMatch(browser, testInfo, {
    url: '/?debug=net&map=test&speed=20&resources=1000&market=1',
  });
  const { clients } = match;
  try {
    // F4 scoreboard displays all 4 players.
    await clients[0].page.keyboard.press('F4');
    await expect(clients[0].page.getByTestId('score-line').filter({ visible: true })).toHaveCount(4);
    for (const name of ['Alice', 'Bob', 'Carol', 'Dave']) {
      await expect(clients[0].page.getByTestId('score-line').filter({ hasText: new RegExp(`^${name}: \\d+/\\d+$`) })).toBeVisible();
    }

    // Send Messages dialog lists all 4 players and routes targeted message only to chosen recipient (player 4 / Dave).
    await clients[0].page.getByTestId('menu-chat').click();
    const chatDialog = clients[0].page.getByTestId('send-message');
    await expect(chatDialog).toBeVisible();
    await expect(chatDialog.getByTestId('chat-player-name')).toHaveText(['Alice', 'Bob', 'Carol', 'Dave']);
    await chatDialog.getByTestId('chat-to-2').click();
    await chatDialog.getByTestId('chat-to-3').click();
    await expect(chatDialog.getByTestId('chat-to-4')).toHaveAttribute('data-state', '1');
    await chatDialog.getByTestId('chat-input').fill('secret for dave');
    await chatDialog.getByTestId('chat-input').press('Enter');
    await chatDialog.getByTestId('chat-return').click();

    await expect(clients[3].page.getByTestId('chat-line').filter({ hasText: 'Alice: secret for dave' })).toBeVisible();
    await expect(clients[1].page.getByTestId('chat-line').filter({ hasText: 'secret for dave' })).toHaveCount(0);
    await expect(clients[2].page.getByTestId('chat-line').filter({ hasText: 'secret for dave' })).toHaveCount(0);

    // Diplomacy dialog lists all 4 players; Alice allies and tributes Dave (player 4).
    await clients[0].page.getByTestId('menu-diplomacy').click();
    const dipDialog = clients[0].page.getByTestId('diplomacy');
    await expect(dipDialog).toBeVisible();
    await expect(dipDialog.getByTestId('diplomacy-player-name')).toHaveText(['Alice', 'Bob', 'Carol', 'Dave']);
    await dipDialog.getByTestId('diplomacy-ally-4').click();
    await dipDialog.getByTestId('diplomacy-tribute-food-4').click();
    await dipDialog.getByTestId('diplomacy-ok').click();

    await expect(clients[3].page.getByTestId('chat-line').filter({ hasText: 'Alice changed diplomatic stance with you to Ally.' })).toBeVisible();
    await expect(clients[3].page.getByTestId('chat-line').filter({ hasText: 'Alice paid 100 food in tribute to you.' })).toBeVisible();

    const turn = await clients[0].page.evaluate(() => window.__game!.turn());
    await waitForTurn(clients, turn + 12);
    await expectSameTurnHashes(clients, turn + 8);

    const relationAndFood = await clients[3].page.evaluate(() => ({
      rel14: window.__game!.relation(1, 4),
      rel41: window.__game!.relation(4, 1),
      food1: window.__game!.resources(1).food,
      food4: window.__game!.resources(4).food,
    }));
    expect(relationAndFood.rel14).toBe(0); // Ally
    expect(relationAndFood.rel41).toBe(3); // Enemy (one-sided)
    expect(relationAndFood.food1).toBe(875);
    expect(relationAndFood.food4).toBe(1100);
  } finally {
    await closeClients(clients, testInfo);
  }
});

test('A01/W04: sequential resignations keep match alive until final FFA winner triggers completed end screen', async ({ browser }, testInfo) => {
  const match = await startFourPlayerMatch(browser, testInfo, { url: DEFAULT_MP4_URL });
  const [alice, bob, carol, dave] = match.clients;
  try {
    await alice.page.keyboard.press('F4');

    // 1st resign (Bob): Bob loses, Alice/Carol/Dave stay active and match continues.
    await menuResign(bob.page);
    await bob.page.waitForFunction(() => window.__game!.gameResult() !== null || window.__game!.units().length >= 0);
    await expect(bob.page.getByTestId('game-over-text')).toHaveText('You have been defeated!');
    await expect(alice.page.getByTestId('chat-line').filter({ hasText: 'Bob resigned.' })).toBeVisible();
    await expect(alice.page.getByTestId('score-line').filter({ hasText: /^Bob:/ })).toHaveClass(/strikeout/);

    const turnAfter1 = await alice.page.evaluate(() => window.__game!.turn());
    await waitForTurn([alice, carol, dave], turnAfter1 + 8);
    for (const active of [alice, carol, dave]) {
      expect(await active.page.evaluate(() => window.__game!.gameResult())).toBeNull();
      await expect(active.page.getByTestId('opponent-left')).toHaveCount(0);
    }

    // 2nd resign (Carol): match STILL continues between Alice and Dave.
    await menuResign(carol.page);
    await expect(carol.page.getByTestId('game-over-text')).toHaveText('You have been defeated!');
    await expect(alice.page.getByTestId('chat-line').filter({ hasText: 'Carol resigned.' })).toBeVisible();

    const turnAfter2 = await alice.page.evaluate(() => window.__game!.turn());
    await waitForTurn([alice, dave], turnAfter2 + 8);
    for (const active of [alice, dave]) {
      expect(await active.page.evaluate(() => window.__game!.gameResult())).toBeNull();
      await expect(active.page.getByTestId('opponent-left')).toHaveCount(0);
    }

    // 3rd resign (Dave): Alice becomes last player standing -> FFA conquest completes cleanly.
    await menuResign(dave.page);
    await expect(alice.page.getByTestId('chat-line').filter({ hasText: 'Dave resigned.' })).toBeVisible();
    await alice.page.waitForFunction(() => window.__game!.gameResult() !== null);

    const results = await Promise.all(
      match.clients.map((c) => c.page.evaluate(() => window.__game!.gameResult())),
    );
    for (const res of results) {
      expect(res).not.toBeNull();
      expect(res!.winners).toEqual([1]);
      expect(res!.status).toEqual([STATUS_PLAYING, STATUS_WON, STATUS_LOST, STATUS_LOST, STATUS_LOST]);
    }

    await expect(alice.page.getByTestId('game-over-text')).toHaveText('You are victorious!');
    await expect(dave.page.getByTestId('game-over-text')).toHaveText('You have been defeated!');
    for (const client of match.clients) {
      await expect(client.page.getByTestId('opponent-left')).toHaveCount(0);
    }
  } finally {
    await closeClients(match.clients, testInfo);
  }
});
