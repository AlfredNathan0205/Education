import { defineConfig, devices } from '@playwright/test';

/**
 * Browser tests of the student journey against a stub API (e2e/stub-api.mjs). Run after `next build`:
 *   pnpm --filter @exam-app/web test:e2e
 * PW_CHROMIUM_PATH points at a Chromium binary when Playwright's own download is not available.
 */
const WEB_PORT = 3100;
const API_PORT = 4010;
const executablePath = process.env.PW_CHROMIUM_PATH || undefined;

export default defineConfig({
  testDir: './e2e',
  timeout: 30_000,
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : 'list',
  use: {
    baseURL: `http://localhost:${WEB_PORT}`,
    trace: 'retain-on-failure',
    launchOptions: executablePath ? { executablePath } : undefined,
  },
  projects: [
    { name: 'phone', use: { ...devices['Pixel 7'], launchOptions: executablePath ? { executablePath } : undefined } },
    { name: 'desktop', use: { ...devices['Desktop Chrome'], launchOptions: executablePath ? { executablePath } : undefined } },
  ],
  webServer: [
    { command: `node e2e/stub-api.mjs`, url: `http://127.0.0.1:${API_PORT}/health`, env: { STUB_API_PORT: String(API_PORT) }, reuseExistingServer: false },
    {
      command: `npx next start -p ${WEB_PORT}`,
      url: `http://localhost:${WEB_PORT}/api/health`,
      env: { API_URL: `http://127.0.0.1:${API_PORT}` },
      reuseExistingServer: false,
      timeout: 60_000,
    },
  ],
});
