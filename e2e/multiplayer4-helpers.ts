import { createServer } from 'node:net';
import { expect, type Browser, type BrowserContext, type Locator, type Page, type TestInfo } from '@playwright/test';

export const DEFAULT_MP4_URL = '/?debug=net&map=test&speed=20';
export const DEFAULT_RANDOM_MP4_URL = '/?debug=net&speed=20';
export const STATUS_PLAYING = 0;
export const STATUS_WON = 1;
export const STATUS_LOST = 2;
export const SYNC_INTERVAL = 4;

const RESERVED_PORTS = new Set([5273, 8887, 8787]);

export interface ClientDiagnostics {
  label: string;
  slot: number;
  consoleErrors: string[];
  consoleWarnings: string[];
  pageErrors: string[];
  failedRequests: string[];
  httpErrors: string[];
  wsEvents: string[];
}

export interface ClientHandle {
  label: string;
  slot: number;
  context: BrowserContext;
  page: Page;
  diagnostics: ClientDiagnostics;
}

export interface OpenClientOptions {
  url?: string;
  label?: string;
  slot?: number;
  viewport?: { width: number; height: number };
}

export interface CreateRoomOptions {
  capacity?: 2 | 4;
  mapSize?: string;
  mapType?: string;
  victory?: string;
  victoryAmount?: string;
}

export interface StartFourPlayerOptions {
  url?: string;
  names?: readonly [string, string, string, string];
  civs?: readonly [number, number, number, number];
  settings?: Omit<CreateRoomOptions, 'capacity'>;
  joinViaInvite?: boolean;
  viewport?: { width: number; height: number };
}

export interface FourPlayerMatch {
  clients: [ClientHandle, ClientHandle, ClientHandle, ClientHandle];
  code: string;
  inviteUrl: string;
}

/** Opens an isolated Playwright browser context with console, pageerror, HTTP, and WebSocket diagnostics attached. */
export async function openClient(browser: Browser, options: OpenClientOptions = {}): Promise<ClientHandle> {
  const label = options.label ?? `slot-${options.slot ?? 0}`;
  const slot = options.slot ?? 0;
  const context = await browser.newContext({
    viewport: options.viewport ?? { width: 1280, height: 800 },
  });
  const page = await context.newPage();
  const diagnostics: ClientDiagnostics = {
    label,
    slot,
    consoleErrors: [],
    consoleWarnings: [],
    pageErrors: [],
    failedRequests: [],
    httpErrors: [],
    wsEvents: [],
  };

  page.on('console', (msg) => {
    const type = msg.type();
    if (type === 'error') diagnostics.consoleErrors.push(msg.text());
    else if (type === 'warning') diagnostics.consoleWarnings.push(msg.text());
  });
  page.on('pageerror', (err) => {
    diagnostics.pageErrors.push(err.stack ?? err.message);
  });
  page.on('requestfailed', (req) => {
    diagnostics.failedRequests.push(`${req.method()} ${req.url()} -> ${req.failure()?.errorText ?? 'failed'}`);
  });
  page.on('response', (res) => {
    if (res.status() >= 400) {
      diagnostics.httpErrors.push(`${res.status()} ${res.request().method()} ${res.url()}`);
    }
  });
  page.on('websocket', (ws) => {
    diagnostics.wsEvents.push(`open ${ws.url()}`);
    ws.on('close', () => diagnostics.wsEvents.push(`close ${ws.url()}`));
    ws.on('socketerror', (error) => diagnostics.wsEvents.push(`error ${ws.url()}: ${error}`));
  });

  await page.goto(options.url ?? DEFAULT_MP4_URL);
  return { label, slot, context, page, diagnostics };
}

/** Attaches diagnostic logs and page screenshots to Playwright test artifacts on failure (or when forced). */
export async function attachDiagnostics(
  clients: readonly ClientHandle[],
  testInfo: TestInfo,
  forceAttach = false,
): Promise<void> {
  const failed = testInfo.status !== testInfo.expectedStatus;
  if (!failed && !forceAttach) return;

  const summary = clients.map((c) => c.diagnostics);
  await testInfo.attach('multiplayer4-diagnostics.json', {
    body: JSON.stringify(summary, null, 2),
    contentType: 'application/json',
  });

  for (const client of clients) {
    if (client.page.isClosed()) continue;
    try {
      const png = await client.page.screenshot({ fullPage: true, timeout: 5_000 });
      await testInfo.attach(`client-${client.slot}-${client.label}.png`, {
        body: png,
        contentType: 'image/png',
      });
    } catch {
      // Page/context may already be torn down during failure handling.
    }
  }
}

/** Closes all client browser contexts and attaches failure diagnostics if `testInfo` reports a failure. */
export async function closeClients(clients: readonly ClientHandle[], testInfo?: TestInfo): Promise<void> {
  if (testInfo) {
    await attachDiagnostics(clients, testInfo);
  }
  await Promise.allSettled(clients.map((c) => c.context.close()));
}

/** Returns a locator matching either `player-{slot}` or `seat-{slot}` in the lobby UI. */
export function seatLocator(page: Page, slot: number): Locator {
  return page.locator(`[data-testid="player-${slot}"], [data-testid="seat-${slot}"]`).first();
}

/** Selects room capacity (2 or 4) on the lobby entry screen using the rendered capacity control. */
export async function selectRoomCapacity(page: Page, capacity: 2 | 4): Promise<void> {
  const selectEl = page.locator('select[data-testid="capacity"], select[data-testid="room-capacity"]').first();
  if (await selectEl.count() > 0 && await selectEl.isVisible()) {
    await selectEl.selectOption(String(capacity));
    return;
  }

  const directBtn = page.locator(`[data-testid="capacity-${capacity}"], [data-testid="room-capacity-${capacity}"]`).first();
  if (await directBtn.count() > 0 && await directBtn.isVisible()) {
    await directBtn.click();
    return;
  }

  const groupBtn = page
    .locator('[data-testid="capacity"], [data-testid="room-capacity"]')
    .locator(`button, input[type="radio"], [role="radio"]`)
    .filter({ hasText: new RegExp(`\\b${capacity}\\b`) })
    .first();
  if (await groupBtn.count() > 0 && await groupBtn.isVisible()) {
    await groupBtn.click();
    return;
  }

  const labeledSelect = page
    .locator('select')
    .filter({ has: page.locator(`option[value="${capacity}"]`) })
    .first();
  if (await labeledSelect.count() > 0 && await labeledSelect.isVisible()) {
    await labeledSelect.selectOption(String(capacity));
    return;
  }

  const accessibleRadio = page.getByRole('radio', { name: new RegExp(`\\b${capacity}\\b`) }).first();
  if (await accessibleRadio.count() > 0 && await accessibleRadio.isVisible()) {
    await accessibleRadio.click();
    return;
  }

  throw new Error(`Unable to locate room capacity selector for capacity=${capacity}`);
}

/** Host creates a multiplayer room with optional capacity (2 or 4) and optional lobby settings. */
export async function createRoom(host: ClientHandle, name: string, options: CreateRoomOptions = {}): Promise<string> {
  await host.page.getByTestId('name').fill(name);
  if (options.capacity !== undefined) {
    await selectRoomCapacity(host.page, options.capacity);
  }
  await host.page.getByTestId('create').click();
  const codeEl = host.page.getByTestId('invite-code');
  await expect(codeEl).toBeVisible();
  const code = (await codeEl.textContent())?.trim() ?? '';
  expect(code).toMatch(/^[A-Z0-9]{5}$/);

  if (options.mapSize !== undefined) {
    await host.page.getByTestId('map-size').selectOption(options.mapSize);
  }
  if (options.mapType !== undefined) {
    await host.page.getByTestId('map-type').selectOption({ label: options.mapType });
  }
  if (options.victory !== undefined) {
    await host.page.getByTestId('victory').selectOption({ label: options.victory });
  }
  if (options.victoryAmount !== undefined) {
    await host.page.getByTestId('victory-amount').selectOption(options.victoryAmount);
  }
  return code;
}

/** Extracts the shareable invite URL from the lobby UI (or builds it from origin + code) and checks it leaks no tokens. */
export async function extractInviteUrl(host: ClientHandle, expectedCode: string): Promise<string> {
  const urlField = host.page.locator('[data-testid="invite-url"], [data-testid="invite-link"]').first();
  let rawUrl = '';
  if (await urlField.count() > 0 && await urlField.isVisible()) {
    const tag = await urlField.evaluate((el) => el.tagName.toLowerCase());
    if (tag === 'input' || tag === 'textarea') {
      rawUrl = await urlField.inputValue();
    } else if (tag === 'a') {
      rawUrl = (await urlField.getAttribute('href')) ?? (await urlField.textContent()) ?? '';
    } else {
      rawUrl = (await urlField.textContent()) ?? '';
    }
    rawUrl = rawUrl.trim();
  }

  const origin = new URL(host.page.url()).origin;
  const resolved = rawUrl ? new URL(rawUrl, origin) : new URL(`/?room=${expectedCode}`, origin);

  expect(resolved.searchParams.get('room')).toBe(expectedCode);
  for (const forbidden of ['token', 'botToken', 'rejoin', 'secret']) {
    expect(resolved.searchParams.has(forbidden)).toBe(false);
  }
  return resolved.toString();
}

/** Merges extra query parameters (e.g. `debug=net&map=test&speed=20`) onto an invite URL while preserving `room`. */
export function withInviteParams(inviteUrl: string, extraQuery: string): string {
  const url = new URL(inviteUrl);
  const extra = new URLSearchParams(extraQuery.startsWith('?') ? extraQuery.slice(1) : extraQuery);
  for (const [k, v] of extra.entries()) {
    if (k !== 'room') url.searchParams.set(k, v);
  }
  return url.toString();
}

/** Joins a room by filling the invite code manually on the entry screen. */
export async function joinByCode(guest: ClientHandle, code: string, name: string): Promise<void> {
  await guest.page.getByTestId('name').fill(name);
  await guest.page.getByTestId('code').fill(code);
  await guest.page.getByTestId('join').click();
}

/** Opens an invite URL, asserts the invite code input is prefilled without auto-ready/auto-start, fills name, and joins. */
export async function joinByInvite(
  guest: ClientHandle,
  inviteUrl: string,
  name: string,
  extraQuery?: string,
): Promise<void> {
  const expectedCode = new URL(inviteUrl).searchParams.get('room') ?? '';
  const targetUrl = extraQuery ? withInviteParams(inviteUrl, extraQuery) : inviteUrl;
  await guest.page.goto(targetUrl);
  await expect(guest.page.getByTestId('code')).toHaveValue(expectedCode);
  await expect(guest.page.getByTestId('ready')).toHaveCount(0);
  await expect(guest.page.getByTestId('start')).toHaveCount(0);
  await guest.page.getByTestId('name').fill(name);
  await guest.page.getByTestId('join').click();
}

/** Selects a civilization for `client`'s own unready seat. */
export async function setClientCiv(client: ClientHandle, civ: number): Promise<void> {
  const civSelect = client.page.getByTestId(`civ-${client.slot}`);
  await civSelect.selectOption(String(civ));
}

/** Clicks Ready for a client and waits until its lobby seat reflects ready. */
export async function readyClient(client: ClientHandle): Promise<void> {
  const readyBtn = client.page.getByTestId('ready');
  await expect(readyBtn).toBeEnabled();
  await readyBtn.click();
  await expect(readyBtn).toHaveText(/not ready/i);
}

/** Waits until the game canvas, `window.__game`, `window.__map`, and `turn > minTurn` are active on a client. */
export async function waitForGameReady(client: ClientHandle, minTurn = 5): Promise<void> {
  await expect(client.page.getByTestId('game-canvas')).toBeVisible();
  await client.page.waitForFunction(
    (t) => window.__game?.selection() != null && window.__map !== undefined && window.__game.turn() > t,
    minTurn,
  );
}

/** Opens 4 isolated contexts, creates a capacity-4 room, joins 3 guests, readies all 4, and starts the match. */
export async function startFourPlayerMatch(
  browser: Browser,
  testInfo: TestInfo,
  options: StartFourPlayerOptions = {},
): Promise<FourPlayerMatch> {
  const names = options.names ?? (['Alice', 'Bob', 'Carol', 'Dave'] as const);
  const url = options.url ?? DEFAULT_MP4_URL;
  const parsedUrl = new URL(url, 'http://localhost');
  const queryTail = parsedUrl.searchParams.toString();

  const clients: ClientHandle[] = [];
  try {
    const host = await openClient(browser, { url, label: names[0], slot: 0, viewport: options.viewport });
    clients.push(host);

    const code = await createRoom(host, names[0], { capacity: 4, ...options.settings });
    const inviteUrl = await extractInviteUrl(host, code);

    for (let slot = 1; slot < 4; slot++) {
      const guestName = names[slot] ?? `Player${slot + 1}`;
      const guest = await openClient(browser, {
        url: options.joinViaInvite === false ? url : 'about:blank',
        label: guestName,
        slot,
        viewport: options.viewport,
      });
      clients.push(guest);
      if (options.joinViaInvite === false) {
        await joinByCode(guest, code, guestName);
      } else {
        await joinByInvite(guest, inviteUrl, guestName, queryTail);
      }
      await expect(seatLocator(host.page, slot)).toContainText(guestName);
    }

    for (let slot = 0; slot < 4; slot++) {
      await expect(seatLocator(clients[slot]!.page, slot)).toContainText(names[slot]!);
    }

    if (options.civs) {
      for (let slot = 0; slot < 4; slot++) {
        await setClientCiv(clients[slot]!, options.civs[slot]!);
      }
    }

    await expect(host.page.getByTestId('start')).toBeDisabled();
    for (const client of clients) {
      await readyClient(client);
    }
    await expect(host.page.getByTestId('start')).toBeEnabled();
    for (const guest of clients.slice(1)) {
      await expect(guest.page.getByTestId('start')).toHaveCount(0);
    }

    await host.page.getByTestId('start').click();
    await Promise.all(clients.map((c) => waitForGameReady(c)));

    return {
      clients: clients as [ClientHandle, ClientHandle, ClientHandle, ClientHandle],
      code,
      inviteUrl,
    };
  } catch (err) {
    await closeClients(clients, testInfo);
    throw err;
  }
}

/** Waits for all supplied active clients to reach at least `targetTurn`. */
export async function waitForTurn(
  clients: readonly ClientHandle[],
  targetTurn: number,
  timeoutMs = 120_000,
): Promise<void> {
  await Promise.all(
    clients.map((c) =>
      c.page.waitForFunction((t) => window.__game!.turn() >= t, targetTurn, { timeout: timeoutMs }),
    ),
  );
}

/** Reads `window.__game.hash(turn)` and `desync()` across all clients, asserting identical defined checksums. */
export async function expectSameTurnHashes(clients: readonly ClientHandle[], turn: number): Promise<number> {
  const samples = await Promise.all(
    clients.map((c) =>
      c.page.evaluate((t) => ({
        slot: window.__game!.player() - 1,
        turn: window.__game!.turn(),
        hash: window.__game!.hash(t),
        desync: window.__game!.desync(),
      }), turn),
    ),
  );

  for (const s of samples) {
    expect(s.desync, `client slot ${s.slot} reported desync`).toBeNull();
    expect(s.hash, `client slot ${s.slot} missing hash at turn ${turn}`).toBeDefined();
  }
  const expected = samples[0]!.hash!;
  for (const s of samples.slice(1)) {
    expect(s.hash, `hash mismatch at turn ${turn} for slot ${s.slot}`).toBe(expected);
  }
  return expected;
}

/** Verifies every 4th-turn checksum in `[fromTurn, toTurn]` matches across all supplied clients. */
export async function expectHashRangeEqual(
  clients: readonly ClientHandle[],
  fromTurn: number,
  toTurn: number,
): Promise<number[]> {
  const start = Math.max(0, fromTurn - (fromTurn % SYNC_INTERVAL));
  const end = Math.max(start, toTurn - (toTurn % SYNC_INTERVAL));
  const turns: number[] = [];
  for (let t = start; t <= end; t += SYNC_INTERVAL) turns.push(t);

  const perClient = await Promise.all(
    clients.map((c) =>
      c.page.evaluate((turnList) => ({
        desync: window.__game!.desync(),
        hashes: turnList.map((t) => window.__game!.hash(t)),
      }), turns),
    ),
  );

  for (const entry of perClient) {
    expect(entry.desync).toBeNull();
    expect(entry.hashes.every((h) => h !== undefined)).toBe(true);
  }
  const baseline = perClient[0]!.hashes as number[];
  for (const entry of perClient.slice(1)) {
    expect(entry.hashes).toEqual(baseline);
  }
  return baseline;
}

/** Allocates an ephemeral free localhost TCP port distinct from 5273, 8887, and 8787. */
export async function allocateFreePort(): Promise<number> {
  for (let attempt = 0; attempt < 16; attempt++) {
    const port = await new Promise<number>((resolve, reject) => {
      const server = createServer();
      server.unref();
      server.on('error', reject);
      server.listen(0, '127.0.0.1', () => {
        const address = server.address();
        if (!address || typeof address === 'string') {
          server.close(() => reject(new Error('Failed to resolve ephemeral port')));
          return;
        }
        const boundPort = address.port;
        server.close((closeErr) => {
          if (closeErr) reject(closeErr);
          else resolve(boundPort);
        });
      });
    });
    if (!RESERVED_PORTS.has(port)) return port;
  }
  throw new Error('Could not allocate an ephemeral port outside reserved ports');
}
