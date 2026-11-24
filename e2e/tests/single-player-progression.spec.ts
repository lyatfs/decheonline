import { expect, test } from '@playwright/test';

// Exercise the production AiBot spawned by the single-player controller, not the fuzz Bot in soak.spec.ts.
const requestedMinutes = Number(process.env.SP_SOAK_MINUTES ?? 1);
const minutes = Number.isFinite(requestedMinutes) && requestedMinutes > 0 ? requestedMinutes : 1;

for (const difficulty of ['easy', 'medium', 'hard']) {
  test(`production AiBot ${difficulty}: sustained economy and synchronized progression`, async ({ browser }) => {
    test.setTimeout(Math.max(240_000, minutes * 60_000));
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    try {
      const page = await context.newPage();
      await page.goto('/?debug=net&map=test&speed=20');
      await page.getByTestId('single-player').click();
      await page.getByTestId('sp-human-civ').selectOption('1');
      await page.getByTestId('sp-bot-civ').selectOption('2');
      await page.getByTestId('sp-difficulty').selectOption(difficulty);
      await page.getByTestId('sp-start').click();
      await page.waitForFunction(() => window.__game !== undefined);
      const startTime = await page.evaluate(() => window.__game!.gameTime());
      await page.waitForFunction((goal) => window.__game!.desync() !== null || window.__game!.gameResult() !== null || window.__game!.gameTime() >= goal,
        startTime + minutes * 60_000);
      const result = await page.evaluate(() => ({
        desync: window.__game!.desync(), time: window.__game!.gameTime(), turn: window.__game!.turn(),
        commands: window.__game!.applied()[1] ?? [],
      }));
      expect(result.desync).toBeNull();
      expect(result.time).toBeGreaterThanOrEqual(startTime + minutes * 60_000);
      expect(result.commands.some((c) => c.type === 'work')).toBe(true);
      expect(result.commands.some((c) => c.type === 'build')).toBe(true);
      expect(result.commands.some((c) => c.type === 'queue')).toBe(true);
      console.log(JSON.stringify({ difficulty, gameMs: result.time - startTime, turn: result.turn, commands: result.commands.length }));
    } finally {
      await context.close();
    }
  });
}
