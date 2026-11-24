import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { chromium, expect, firefox, test, webkit, type Browser, type BrowserType, type Page } from '@playwright/test';
import { runReplay, type ReplayLog } from '@aoe/sim';
import {
  CommandTraceBuffer,
  SOAK4_AWAY_MS,
  SOAK4_DEFAULT_SEEDS,
  SOAK4_MAX_GAMES_PER_SEED,
  SOAK4_ROUND_TURNS,
  SOAK4_STALL_MS,
  Soak4Bot,
  buildSampleReplay4,
  derivedBotSeed,
  derivedMapSeed,
  findDesync4,
  firstDivergentTurn,
  hexHash,
  presetForSeed,
  readHashesAt,
  readTurn,
  resignPeerInGame,
  resolveSoak4Seeds,
  startMultiplayer4Game,
} from '../multiplayer4-soak-helpers';

// 4-player seeded soak and cross-engine determinism suite (`A06`, `A07`).
// Run manually with: `cd e2e && npx playwright test -c playwright.multiplayer4-soak.config.ts`
// Never part of `npm run test:e2e`, and independent from the legacy 2-player `npm run test:soak`.

const MINUTES_PER_SEED = Number(process.env['SOAK4_MINUTES'] ?? 20);
const simEntry = fileURLToPath(new URL('../../packages/sim/src/index.ts', import.meta.url));
const firefoxBrokenOnMac = process.platform === 'darwin';

interface Game4Report {
  turn: number;
  timeMs: number;
  ended: string | null;
  hashes: (number | undefined)[];
  rejoinedVerified: boolean;
  resignedContinued: boolean;
}

test('4-player desync detector catches single-peer perturbation and reports seed, turn, hashes, and trace', async ({ browser }) => {
  const PERTURB_TURN = 30;
  const seed = SOAK4_DEFAULT_SEEDS[0];
  const trace = new CommandTraceBuffer();
  const session = await startMultiplayer4Game(browser, {
    seed,
    civs: [1, 1, 1, 1],
    slotExtras: { 2: `&perturb=${PERTURB_TURN}` },
  });

  try {
    const [host, , perturbedPeer] = session.pages;
    await host.waitForFunction(() => window.__game!.desync() !== null, undefined, { timeout: SOAK4_STALL_MS });

    const active = session.pages.map((page, slot) => ({ slot, page }));
    const diagnostic = await findDesync4(active, seed, trace);
    expect(diagnostic).not.toBeNull();
    console.log(`soak4 forced desync caught:\n${diagnostic}`);

    const checked = Math.ceil((PERTURB_TURN + 1) / 4) * 4;
    expect(diagnostic).toContain(`seed=${seed}`);
    expect(diagnostic).toContain(`firstDivergentTurn=${checked}`);

    const hashes = await readHashesAt([host, perturbedPeer], checked);
    expect(hashes[0]).toBeDefined();
    expect(hashes[1]).toBeDefined();
    expect(hashes[0]).not.toBe(hashes[1]);
  } finally {
    await session.closeAll();
  }
});

async function playSoak4Game(
  browser: Browser,
  baseSeed: number,
  baseBotSeed: number,
  seedIndex: number,
  gameIndex: number,
  limitMs: number,
  issuedTotal: Map<string, number>,
): Promise<Game4Report> {
  const preset = presetForSeed(baseSeed, seedIndex);
  const mapSeed = derivedMapSeed(baseSeed, gameIndex);
  const botSeed = derivedBotSeed(baseBotSeed, mapSeed, gameIndex);
  const trace = new CommandTraceBuffer();

  console.log(
    `soak4: seed[${seedIndex + 1}] (${preset.label}) game ${gameIndex + 1}: mapSeed=${mapSeed}, botSeed=${botSeed}, ` +
      `map=${preset.mapTypeLabel}(${preset.mapSizeValue}), civs=[${preset.civs.join(',')}], limit=${Math.round(limitMs / 1000)}s`,
  );

  const session = await startMultiplayer4Game(browser, {
    seed: mapSeed,
    civs: preset.civs,
    mapSizeValue: preset.mapSizeValue,
    mapTypeLabel: preset.mapTypeLabel,
    useScoreLimit: true,
  });

  const activeSlots = new Set<number>([0, 1, 2, 3]);
  const activePeers = (): { slot: number; page: Page }[] =>
    session.pages
      .map((page, slot) => ({ slot, page }))
      .filter(({ slot }) => activeSlots.has(slot));

  try {
    const bots = session.pages.map((page, slot) => new Soak4Bot(slot, page, botSeed + slot * 101, trace));
    for (const bot of bots) await bot.prepare();

    let turn = await readTurn(session.pages[0]);
    let rounds = 0;
    let ended: string | null = null;
    let rejoinedVerified = false;
    let resignedContinued = false;
    const wallStart = Date.now();

    for (;;) {
      turn += SOAK4_ROUND_TURNS;
      for (const { page } of activePeers()) {
        await page.waitForFunction((t) => window.__game!.turn() >= t, turn, { timeout: SOAK4_STALL_MS });
      }

      const failure = await findDesync4(activePeers(), mapSeed, trace);
      if (failure) throw new Error(failure);

      const host = session.pages[0];
      const [timeMs, result] = await host.evaluate(() => [window.__game!.gameTime(), window.__game!.gameResult()] as const);
      if (result) {
        const scores = await host.evaluate(() => [1, 2, 3, 4].map((p) => window.__game!.score(p).total));
        ended = `${JSON.stringify(result)}, scores=[${scores.join(',')}]`;
        break;
      }
      if (timeMs >= limitMs) break;

      // On the first game of each seed, run forced disconnect/rejoin on slot 2 once turns pass 24.
      if (gameIndex === 0 && !rejoinedVerified && turn >= 24) {
        const slot2 = session.pages[2];
        const droppedAt = await readTurn(slot2);
        await host.evaluate(() => window.__game!.issueTest(17, 29));
        trace.record({ turn: await readTurn(host), slot: 0, player: 1, command: { type: 'test', x: 17, y: 29 } });
        await slot2.evaluate((ms) => window.__game!.dropLink(ms), SOAK4_AWAY_MS);

        const targetAfterRejoin = droppedAt + 32;
        for (const { page } of activePeers()) {
          await page.waitForFunction((t) => window.__game!.turn() >= t, targetAfterRejoin, { timeout: SOAK4_STALL_MS });
        }
        const rejoinDesync = await findDesync4(activePeers(), mapSeed, trace);
        if (rejoinDesync) throw new Error(`Post-rejoin ${rejoinDesync}`);

        const appliedAll = await Promise.all(session.pages.map((p) => p.evaluate(() => window.__game!.applied())));
        expect(appliedAll[2]).toEqual(appliedAll[0]);
        turn = Math.max(turn, await readTurn(host));
        rejoinedVerified = true;
        console.log(`soak4: seed=${mapSeed} slot 2 disconnect/rejoin verified through turn ${turn}`);
      }

      // On the first game of each seed, test single-player resignation continuation without ending the 4-player match.
      if (gameIndex === 0 && rejoinedVerified && !resignedContinued && turn >= 60) {
        await resignPeerInGame(session.pages[3]);
        bots[3]!.resigned = true;
        activeSlots.delete(3);

        // Advance 12 more turns among the remaining 3 active peers and verify match remains alive and in sync.
        const postResignTarget = (await readTurn(host)) + 12;
        for (const { page } of activePeers()) {
          await page.waitForFunction((t) => window.__game!.turn() >= t, postResignTarget, { timeout: SOAK4_STALL_MS });
        }
        const postResignFailure = await findDesync4(activePeers(), mapSeed, trace);
        if (postResignFailure) throw new Error(`Post-resign ${postResignFailure}`);

        const hostResultAfterOneResign = await host.evaluate(() => window.__game!.gameResult());
        expect(hostResultAfterOneResign).toBeNull();
        turn = Math.max(turn, await readTurn(host));
        resignedContinued = true;
        console.log(`soak4: seed=${mapSeed} slot 3 resigned; remaining 3 players continued cleanly at turn ${turn}`);
      }

      for (const bot of bots) {
        if (!bot.resigned) await bot.round();
      }
      if (++rounds % 25 === 0) {
        console.log(
          `soak4: seed=${mapSeed} game ${gameIndex + 1}: turn=${turn}, gameTime=${Math.round(timeMs / 1000)}s, ` +
            `wall=${Math.round((Date.now() - wallStart) / 1000)}s`,
        );
      }
    }

    const active = activePeers();
    const last = await readTurn(active[0]!.page);
    for (const { page } of active) {
      await page.waitForFunction((t) => window.__game!.turn() > t + 2, last, { timeout: SOAK4_STALL_MS });
    }
    const finalFailure = await findDesync4(active, mapSeed, trace);
    if (finalFailure) throw new Error(finalFailure);

    const checked = Math.floor(last / 4) * 4;
    const hashes = await readHashesAt(active.map((a) => a.page), checked);
    const firstHash = hashes[0];
    if (hashes.some((h) => h !== firstHash)) {
      const slotHashes = active.map((a, idx) => `slot${a.slot}=${hexHash(hashes[idx])}`).join(', ');
      throw new Error(
        `Desync at final check: seed=${mapSeed}, firstDivergentTurn=${checked}, hashes=[${slotHashes}]\n` +
          `Recent command trace:\n  ${trace.formatRecent()}`,
      );
    }

    const timeMs = await active[0]!.page.evaluate(() => window.__game!.gameTime());
    for (const bot of bots) {
      for (const [cmd, count] of bot.issued) {
        issuedTotal.set(cmd, (issuedTotal.get(cmd) ?? 0) + count);
      }
    }
    return { turn: checked, timeMs, ended, hashes, rejoinedVerified, resignedContinued };
  } finally {
    await session.closeAll();
  }
}

test('A06: four-player seeded soak across 3 fixed seeds runs without desync, handles drop/rejoin, resign continuation, and new-match cycling', async ({ browser }) => {
  test.setTimeout(7_200_000);
  const seeds = resolveSoak4Seeds();
  const targetMsPerSeed = MINUTES_PER_SEED * 60_000;
  const issuedTotal = new Map<string, number>();

  console.log(`soak4: starting with seeds=[${seeds.join(', ')}], minutesPerSeed=${MINUTES_PER_SEED}`);

  for (const [seedIndex, baseSeed] of seeds.entries()) {
    const preset = presetForSeed(baseSeed, seedIndex);
    let accumulatedMs = 0;
    let games = 0;

    while (accumulatedMs < targetMsPerSeed) {
      if (games >= SOAK4_MAX_GAMES_PER_SEED) {
        throw new Error(
          `soak4: seed ${baseSeed} exceeded ${SOAK4_MAX_GAMES_PER_SEED} games with only ${Math.round(accumulatedMs / 1000)}s of ${MINUTES_PER_SEED * 60}s`,
        );
      }
      const report = await playSoak4Game(
        browser,
        baseSeed,
        preset.botSeed,
        seedIndex,
        games,
        targetMsPerSeed - accumulatedMs,
        issuedTotal,
      );
      accumulatedMs += report.timeMs;
      console.log(
        `soak4: seed=${baseSeed} game=${games + 1} ${report.ended ? `ended (${report.ended})` : 'reached limit'}: ` +
          `turn=${report.turn}, gameTime=${Math.round(report.timeMs / 1000)}s, ` +
          `hashes=[${report.hashes.map((h) => hexHash(h)).join(',')}], ` +
          `summed=${Math.round(accumulatedMs / 1000)}s/${MINUTES_PER_SEED * 60}s`,
      );
      games++;
    }
  }

  for (const kind of ['work', 'build', 'queue', 'move', 'attack', 'research']) {
    expect(issuedTotal.get(kind) ?? 0, `${kind} commands issued across 4 peers`).toBeGreaterThan(0);
  }
});

test('A07: 4-player deterministic replay hashes identically across Node, Chromium, Firefox, and WebKit', async () => {
  test.setTimeout(600_000);
  const seeds = resolveSoak4Seeds();
  const replays: { seed: number; log: ReplayLog }[] = seeds.map((seed) => ({
    seed,
    log: buildSampleReplay4(seed, 120),
  }));

  const bundle = await build({ entryPoints: [simEntry], bundle: true, format: 'iife', globalName: 'AoeSim', write: false });
  const script = bundle.outputFiles[0]!.text;

  const nodeResults = replays.map((r) => runReplay(r.log));
  const engineHashes: Record<string, number[][]> = { node: nodeResults };
  const missingEngines: string[] = [];

  const engines: readonly [string, BrowserType][] = [
    ['chromium', chromium],
    ['firefox', firefox],
    ['webkit', webkit],
  ];

  for (const [name, engine] of engines) {
    if (name === 'firefox' && firefoxBrokenOnMac) {
      missingEngines.push('firefox (skipped on macOS per playwright policy)');
      test.info().annotations.push({ type: 'skipped-engine', description: 'firefox: cannot launch on macOS' });
      continue;
    }
    let browser: Browser;
    try {
      browser = await engine.launch();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      missingEngines.push(`${name} (${msg})`);
      test.info().annotations.push({ type: 'missing-engine', description: `${name}: ${msg}` });
      continue;
    }
    try {
      const page = await browser.newPage();
      await page.addScriptTag({ content: script });
      const logs = replays.map((r) => r.log);
      engineHashes[name] = await page.evaluate((inputLogs) => {
        const sim = (globalThis as unknown as { AoeSim: typeof import('@aoe/sim') }).AoeSim;
        return inputLogs.map((log) => sim.runReplay(log));
      }, logs);
    } finally {
      await browser.close();
    }
  }

  if (missingEngines.length > 0) {
    console.warn(`A07: missing/skipped engines reported separately: ${missingEngines.join('; ')}`);
  }
  expect(Object.keys(engineHashes).length, 'at least Node + one browser engine must execute').toBeGreaterThanOrEqual(2);

  for (const [idx, { seed }] of replays.entries()) {
    const baseline = nodeResults[idx]!;
    for (const [engineName, runs] of Object.entries(engineHashes)) {
      const candidate = runs[idx]!;
      const div = firstDivergentTurn(baseline, candidate);
      expect(
        div,
        div
          ? `A07 determinism mismatch: seed=${seed}, engine=${engineName}, firstDivergentTurn=${div.turn}, ` +
            `node=${hexHash(div.expected)}, ${engineName}=${hexHash(div.actual)}`
          : `A07 match seed=${seed} engine=${engineName}`,
      ).toBeNull();
    }
    console.log(`A07: seed=${seed} matched across [${Object.keys(engineHashes).join(', ')}], finalHash=${hexHash(baseline.at(-1))}`);
  }
});
