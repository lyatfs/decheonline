import { expect, test, type Browser, type Page } from '@playwright/test';

// speed=20 runs the lockstep clock 20x faster; resources=1000 pays for the stone of the wall line.
const URL = '/?debug=net&map=test&speed=20&resources=1000';

// Master ids (empires.dat): Villager, Small Wall (researched at the Granary after the Tool Age, tech 11; a Bronze Age start has it).
const VILLAGER = 83;
const SMALL_WALL = 72;
/** `object_state` of a finished building. */
const ACTIVE = 2;

async function open(browser: Browser): Promise<Page> {
  const page = await (await browser.newContext({ viewport: { width: 1280, height: 800 } })).newPage();
  await page.goto(URL);
  return page;
}

/** Host creates a Bronze Age game, guest joins by code, both ready, host starts; resolves once both have drawn the map. */
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
  await host.getByTestId('starting-age').selectOption({ label: 'Bronze Age' });
  await host.getByTestId('ready').click();
  await guest.getByTestId('ready').click();
  await expect(host.getByTestId('start')).toBeEnabled();
  await host.getByTestId('start').click();
  for (const page of [host, guest]) await page.waitForFunction(() => window.__game?.selection() != null && window.__map !== undefined);
  return [host, guest];
}

const slot = (page: Page, command: string, unit?: number) =>
  page.locator(`[data-testid=command-slot][data-command=${command}]${unit === undefined ? '' : `[data-unit="${unit}"]`}`);

/** Canvas-page point of the middle of tile (col, row). */
/** Build, then the Small Wall (on the build menu's second page when the first has no room), which starts the line mode. */
async function chooseWall(page: Page): Promise<void> {
  await slot(page, 'build').click();
  await expect(slot(page, 'cancel')).toHaveCount(1);
  if ((await slot(page, 'place', SMALL_WALL).count()) === 0) await slot(page, 'more').click();
  await slot(page, 'place', SMALL_WALL).click();
}

async function tilePoint(page: Page, col: number, row: number): Promise<{ x: number; y: number }> {
  const box = (await page.getByTestId('game-canvas').boundingBox())!;
  const at = await page.evaluate(([c, r]) => window.__map!.tileScreenPos(c, r), [col, row] as const);
  return { x: box.x + at.x, y: box.y + at.y };
}

/** Player 1's walls as `col,row:facet`, west to east then north to south. */
const walls = (page: Page) =>
  page.evaluate(
    (wall) =>
      window.__game!
        .buildings()
        .filter((b) => b.owner === 1 && b.type === wall)
        .sort((a, b) => a.x - b.x || b.y - a.y)
        .map((b) => ({ tile: `${Math.trunc(b.x)},${Math.trunc(b.y)}`, facet: b.facet, state: b.state })),
    SMALL_WALL,
  );

test('one player drags a wall line; the villager builds it and both clients show the joined walls', async ({ browser }) => {
  const [host, guest] = await startGame(browser);

  // The host's villager: Build, then the Small Wall in the build menu enters the line placing mode.
  const villager = (await host.evaluate(() => window.__game!.units())).find((u) => u.owner === 1 && u.type === VILLAGER)!;
  const box = (await host.getByTestId('game-canvas').boundingBox())!;
  const vAt = (await host.evaluate((i) => window.__game!.unitScreenPos(i), villager.id))!;
  await host.mouse.click(box.x + vAt.x, box.y + vAt.y - 15);
  await expect.poll(() => host.evaluate(() => window.__game!.selection())).toEqual([villager.id]);
  await chooseWall(host);
  await expect(slot(host, 'cancel')).toHaveCount(1);

  // Before the press the outline is one segment, an end (facet 2), on the tile under the pointer.
  const start = await tilePoint(host, 9, 9);
  await host.mouse.move(start.x, start.y);
  await expect
    .poll(() => host.evaluate(() => window.__game!.ghost()))
    .toEqual({ unit: SMALL_WALL, x: 9.5, y: 9.5, fits: true, segments: [{ x: 9.5, y: 9.5, facet: 2, fits: true }] });

  // Dragging to (13, 7), inside the explored ground (`check_vis`): along the start row to the end column, then up it; ends and the corner facet 2.
  await host.mouse.down();
  const end = await tilePoint(host, 13, 7);
  await host.mouse.move(end.x, end.y, { steps: 8 });
  const outline = await host.evaluate(() => window.__game!.ghost());
  expect(outline).toMatchObject({ unit: SMALL_WALL, x: 13.5, y: 7.5, fits: true });
  expect(outline!.segments!.map((s) => `${s.x - 0.5},${s.y - 0.5}:${s.facet}`)).toEqual(['9,9:2', '10,9:0', '11,9:0', '12,9:0', '13,9:2', '13,8:1', '13,7:2']);
  await host.mouse.up();
  // The release sends the line and ends placing.
  await expect.poll(() => host.evaluate(() => window.__game!.ghost())).toBeNull();
  await expect(slot(host, 'build')).toHaveCount(1);

  // Both clients get 7 foundations, the villager builds them all, and the built walls join: the line's middle west-east
  // (0), the column's middle north-south (1), the ends and the corner 2.
  const joined = [
    { tile: '9,9', facet: 2, state: ACTIVE },
    { tile: '10,9', facet: 0, state: ACTIVE },
    { tile: '11,9', facet: 0, state: ACTIVE },
    { tile: '12,9', facet: 0, state: ACTIVE },
    { tile: '13,9', facet: 2, state: ACTIVE },
    { tile: '13,8', facet: 1, state: ACTIVE },
    { tile: '13,7', facet: 2, state: ACTIVE },
  ];
  for (const page of [host, guest]) await expect.poll(() => walls(page), { timeout: 180_000 }).toEqual(joined);
  expect((await host.evaluate(() => window.__game!.resources(1))).stone).toBe(1000 - 7 * 5);

  // Both clients agree on the hash of a turn both have run.
  const turns = await Promise.all([host, guest].map((p) => p.evaluate(() => window.__game!.turn())));
  const turn = Math.max(...turns) + 2;
  for (const page of [host, guest]) await page.waitForFunction((t) => window.__game!.turn() > t, turn);
  const [a, b] = await Promise.all([host, guest].map((p) => p.evaluate((t) => window.__game!.hash(t), turn)));
  expect(a).toBeDefined();
  expect(a).toBe(b);
  console.log(`turn ${turn} hash ${a}: ${joined.length} joined walls on both clients`);
});

test('a right click while dragging a wall line stops placing and sends nothing', async ({ browser }) => {
  const [host] = await startGame(browser);
  const villager = (await host.evaluate(() => window.__game!.units())).find((u) => u.owner === 1 && u.type === VILLAGER)!;
  const box = (await host.getByTestId('game-canvas').boundingBox())!;
  const vAt = (await host.evaluate((i) => window.__game!.unitScreenPos(i), villager.id))!;
  await host.mouse.click(box.x + vAt.x, box.y + vAt.y - 15);
  await expect.poll(() => host.evaluate(() => window.__game!.selection())).toEqual([villager.id]);
  await chooseWall(host);
  const start = await tilePoint(host, 12, 7);
  await host.mouse.move(start.x, start.y);
  await host.mouse.down();
  const end = await tilePoint(host, 15, 7);
  await host.mouse.move(end.x, end.y, { steps: 4 });
  await expect.poll(async () => (await host.evaluate(() => window.__game!.ghost()))?.segments?.length).toBe(4);
  await host.mouse.click(end.x, end.y, { button: 'right' });
  await host.mouse.up();
  expect(await host.evaluate(() => window.__game!.ghost())).toBeNull();
  const turn = await host.evaluate(() => window.__game!.turn());
  await host.waitForFunction((t) => window.__game!.turn() > t + 4, turn);
  expect(await walls(host)).toEqual([]);
});

test('right-drag camera pan onto HUD cleans up state and does not interfere with subsequent wall drag', async ({ browser }) => {
  const [host] = await startGame(browser);
  const villager = (await host.evaluate(() => window.__game!.units())).find((u) => u.owner === 1 && u.type === VILLAGER)!;
  const box = (await host.getByTestId('game-canvas').boundingBox())!;
  const vAt = (await host.evaluate((i) => window.__game!.unitScreenPos(i), villager.id))!;
  await host.mouse.click(box.x + vAt.x, box.y + vAt.y - 15);
  await expect.poll(() => host.evaluate(() => window.__game!.selection())).toEqual([villager.id]);

  // Right-drag from the canvas centre onto the bottom HUD panel, then release outside the playable canvas area.
  const camBefore = await host.evaluate(() => window.__map!.camera());
  const dragStart = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  const hudPoint = { x: box.x + box.width / 2 - 40, y: box.y + box.height - 25 };
  await host.mouse.move(dragStart.x, dragStart.y);
  await host.mouse.down({ button: 'right' });
  await host.mouse.move(dragStart.x - 20, dragStart.y + 30, { steps: 3 });
  await host.mouse.move(hudPoint.x, hudPoint.y, { steps: 4 });
  await host.mouse.up({ button: 'right' });

  const camAfter = await host.evaluate(() => window.__map!.camera());
  expect(camAfter).not.toEqual(camBefore);
  const cursor = await host.getByTestId('game-canvas').evaluate((el) => (el as HTMLElement).style.cursor);
  expect(cursor).not.toBe('grabbing');

  // Move pointer back inside the map, wait a few turns, and verify no right-click order was emitted.
  await host.mouse.move(dragStart.x, dragStart.y);
  const turnAfterDrag = await host.evaluate(() => window.__game!.turn());
  await host.waitForFunction((t) => window.__game!.turn() > t + 3, turnAfterDrag);
  expect(await host.evaluate(() => window.__game!.applied().flat())).toEqual([]);

  // Re-center and verify wall placement + drag works cleanly with zero stale rightDown interference.
  await host.evaluate(() => window.__map!.centerOnTile(11, 10));
  await chooseWall(host);
  const start = await tilePoint(host, 9, 9);
  await host.mouse.move(start.x, start.y);
  await host.mouse.down();
  const end = await tilePoint(host, 12, 9);
  await host.mouse.move(end.x, end.y, { steps: 5 });
  await expect.poll(async () => (await host.evaluate(() => window.__game!.ghost()))?.segments?.length).toBe(4);
  await host.mouse.up();
  await expect.poll(() => host.evaluate(() => window.__game!.ghost())).toBeNull();
  await expect
    .poll(() => host.evaluate(() => window.__game!.applied().flat().map((c) => c.type)))
    .toContain('build-wall');
});
