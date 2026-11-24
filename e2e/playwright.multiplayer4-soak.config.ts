import { defineConfig } from '@playwright/test';
import { shared } from './playwright.shared';

// 4-player seeded soak and cross-engine determinism suite (`tests/multiplayer4-soak.spec.ts`, A06/A07).
// Manual entry only; never part of `npm run test:e2e`, and separate from the legacy 2-player `playwright.soak.config.ts`.
export default defineConfig({
  ...shared,
  workers: 1,
  fullyParallel: false,
  testMatch: /multiplayer4-soak\.spec\.ts/,
});
