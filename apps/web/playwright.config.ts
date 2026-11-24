import { defineConfig } from '@playwright/test';

/**
 * E2E tests against STANDALONE mode (no Docker, no login).
 * Reuses a running `npm run dev:standalone` or starts one from the repo root.
 * Uses the locally installed Google Chrome (no Playwright browser download);
 * set PW_CHANNEL=chromium after `npx playwright install chromium` to use the bundled one.
 */
export default defineConfig({
  testDir: './tests/e2e',
  timeout: 90_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  reporter: [['list']],
  use: {
    baseURL: 'http://localhost:5173',
    channel: process.env.PW_CHANNEL ?? 'chrome',
    headless: true,
    viewport: { width: 1400, height: 900 },
  },
  webServer: {
    command: 'npm run dev:standalone',
    cwd: '../..',
    url: 'http://localhost:5173/api/v1/health',
    reuseExistingServer: true,
    timeout: 180_000,
  },
});
