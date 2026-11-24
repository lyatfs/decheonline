import { defineConfig } from '@playwright/test';
import { shared } from './playwright.shared';

// One worker: two clients per test already load the machine, and the lockstep steps are paced by wall-clock frame
// times. More workers: `npm run test:e2e -- --workers=3`. The wall-clock latency spec is its own config
// (playwright.latency.config.ts, `npm run test:e2e:latency`) and is not part of this run.
export default defineConfig({
  ...shared,
  workers: 1,
  fullyParallel: true,
  testIgnore: /(?:latency|multiplayer4-soak)\.spec\.ts/,
});
