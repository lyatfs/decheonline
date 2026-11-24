import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';
import {
  allocateFreePort,
  closeClients,
  createRoom,
  expectSameTurnHashes,
  extractInviteUrl,
  joinByInvite,
  openClient,
  readyClient,
  seatLocator,
  waitForGameReady,
  waitForTurn,
  type ClientHandle,
} from '../multiplayer4-helpers';
import { syntheticPackDir } from '../synthetic-pack';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '../..');
const SERVER_ENTRY = resolve(REPO_ROOT, 'apps/server/dist/main.js');
const CLIENT_DIST = resolve(REPO_ROOT, 'apps/client/dist');

interface ProductionServerHandle {
  port: number;
  baseUrl: string;
  process: ChildProcess;
  logs: string[];
  stop: () => Promise<void>;
}

async function startProductionServer(port: number): Promise<ProductionServerHandle> {
  if (!existsSync(SERVER_ENTRY) || !existsSync(resolve(CLIENT_DIST, 'index.html'))) {
    throw new Error(`Production bundles missing (${SERVER_ENTRY}, ${CLIENT_DIST}); run npm run build first.`);
  }

  const logs: string[] = [];
  const proc = spawn(process.execPath, [SERVER_ENTRY], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      HOST: '127.0.0.1',
      PORT: String(port),
      ASSETS_DIR: syntheticPackDir,
      CLIENT_DIR: CLIENT_DIST,
      LOBBY_CIV: '1',
      DROP_AFTER_MS: '15000',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  proc.stdout?.on('data', (chunk: Buffer) => logs.push(`[stdout] ${chunk.toString()}`));
  proc.stderr?.on('data', (chunk: Buffer) => logs.push(`[stderr] ${chunk.toString()}`));

  const baseUrl = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 20_000;
  let healthy = false;
  while (Date.now() < deadline) {
    if (proc.exitCode !== null) {
      throw new Error(`Production server exited early with code ${proc.exitCode}:\n${logs.join('')}`);
    }
    try {
      const res = await fetch(`${baseUrl}/health`);
      if (res.status === 200) {
        healthy = true;
        break;
      }
    } catch {
      // Server still starting up.
    }
    await new Promise((r) => setTimeout(r, 150));
  }
  if (!healthy) {
    proc.kill('SIGKILL');
    throw new Error(`Timed out waiting for ${baseUrl}/health:\n${logs.join('')}`);
  }

  const stop = async (): Promise<void> => {
    if (proc.exitCode !== null) return;
    await new Promise<void>((resolveStop) => {
      const killTimer = setTimeout(() => {
        if (proc.exitCode === null) proc.kill('SIGKILL');
      }, 4_000);
      proc.once('exit', () => {
        clearTimeout(killTimer);
        resolveStop();
      });
      proc.kill('SIGTERM');
    });
  };

  return { port, baseUrl, process: proc, logs, stop };
}

test('O05: closing host browser tab stops only the client tab while production server stays alive for remaining 3 players', async ({ browser }, testInfo) => {
  test.setTimeout(120_000);
  const port = await allocateFreePort();
  expect(port).not.toBe(5273);
  expect(port).not.toBe(8887);

  const server = await startProductionServer(port);
  const clients: ClientHandle[] = [];
  try {
    const entryUrl = `${server.baseUrl}/?debug=net&map=test&speed=20`;
    const host = await openClient(browser, { url: entryUrl, label: 'Alice', slot: 0 });
    clients.push(host);

    const code = await createRoom(host, 'Alice', { capacity: 4 });
    const inviteUrl = await extractInviteUrl(host, code);
    expect(new URL(inviteUrl).origin).toBe(server.baseUrl);

    for (const [slot, name] of [[1, 'Bob'], [2, 'Carol'], [3, 'Dave']] as const) {
      const guest = await openClient(browser, { url: 'about:blank', label: name, slot });
      clients.push(guest);
      await joinByInvite(guest, inviteUrl, name, 'debug=net&map=test&speed=20');
      await expect(seatLocator(host.page, slot)).toContainText(name);
    }

    for (const client of clients) await readyClient(client);
    await host.page.getByTestId('start').click();
    await Promise.all(clients.map((c) => waitForGameReady(c, 8)));

    await host.page.evaluate(() => window.__game!.issueTest(10, 10));
    await clients[1]!.page.evaluate(() => window.__game!.issueTest(20, 20));
    await waitForTurn(clients, 12);

    // Close ONLY the host browser tab/context — production server process must stay alive.
    await host.page.close();
    await host.context.close();

    expect(server.process.exitCode).toBeNull();
    const healthRes = await fetch(`${server.baseUrl}/health`);
    expect(healthRes.status).toBe(200);
    expect(await healthRes.json()).toEqual({ status: 'ok' });
    const versionsRes = await fetch(`${server.baseUrl}/api/versions`);
    expect(versionsRes.status).toBe(200);
    expect(await versionsRes.json()).toMatchObject({ protocol: 'mp4-v1', rules: 'sim-v1' });

    const remaining = clients.slice(1);
    const turnBeforeAdvance = await remaining[0]!.page.evaluate(() => window.__game!.turn());
    await remaining[0]!.page.evaluate(() => window.__game!.issueTest(33, 44));
    await waitForTurn(remaining, turnBeforeAdvance + 20);
    await expectSameTurnHashes(remaining, turnBeforeAdvance + 16);

    for (const active of remaining) {
      expect(await active.page.evaluate(() => window.__game!.gameResult())).toBeNull();
      await expect(active.page.getByTestId('opponent-left')).toHaveCount(0);
    }

    // Now stop the production server process itself -> clients detect connection loss cleanly.
    await server.stop();
    expect(server.process.exitCode).not.toBeNull();

    for (const guest of remaining) {
      await expect(
        guest.page.locator('[data-testid="opponent-left"], [data-testid="error"], [data-testid="popup"]').first(),
      ).toBeVisible({ timeout: 20_000 });
    }
  } finally {
    if (testInfo.status !== testInfo.expectedStatus) {
      await testInfo.attach('production-server-logs.txt', {
        body: server.logs.join(''),
        contentType: 'text/plain',
      });
    }
    await closeClients(clients, testInfo);
    await server.stop();
  }
});

test('O05: closing host browser tab in lobby preserves server process and transfers host role to slot 1', async ({ browser }, testInfo) => {
  test.setTimeout(90_000);
  const port = await allocateFreePort();
  expect(port).not.toBe(5273);
  expect(port).not.toBe(8887);

  const server = await startProductionServer(port);
  const clients: ClientHandle[] = [];
  try {
    const entryUrl = `${server.baseUrl}/?debug=net&map=test&speed=20`;
    const alice = await openClient(browser, { url: entryUrl, label: 'Alice', slot: 0 });
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

    // Host tab closes in lobby -> server keeps running and promotes Bob (slot 1) to hostSlot.
    await alice.page.close();
    await alice.context.close();

    expect(server.process.exitCode).toBeNull();
    expect((await fetch(`${server.baseUrl}/health`)).status).toBe(200);

    await expect(seatLocator(bob.page, 1)).toContainText('(host)');
    await expect(bob.page.getByTestId('start')).toBeVisible();
    await expect(bob.page.getByTestId('start')).toBeDisabled();

    // Replacement 4th player joins open slot 0 and new host Bob starts the match.
    const eve = await openClient(browser, { url: 'about:blank', label: 'Eve', slot: 0 });
    clients.push(eve);
    await joinByInvite(eve, inviteUrl, 'Eve', 'debug=net&map=test&speed=20');
    await expect(seatLocator(bob.page, 0)).toContainText('Eve');

    const active = [eve, bob, carol, dave];
    for (const client of active) await readyClient(client);
    await expect(bob.page.getByTestId('start')).toBeEnabled();
    await bob.page.getByTestId('start').click();
    await Promise.all(active.map((c) => waitForGameReady(c, 6)));
    await expectSameTurnHashes(active, 4);
  } finally {
    if (testInfo.status !== testInfo.expectedStatus) {
      await testInfo.attach('production-server-logs.txt', {
        body: server.logs.join(''),
        contentType: 'text/plain',
      });
    }
    await closeClients(clients, testInfo);
    await server.stop();
  }
});
