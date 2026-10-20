// Playwright config. Runs against the production-like local server (scripts/serve.mjs).
// Env: PORT (default 8787); E2E_NO_BUILD=1 serves the existing dist/ without rebuilding.
import { defineConfig, devices } from '@playwright/test';

const PORT = Number(process.env.PORT || 8787);
const BASE_URL = `http://127.0.0.1:${PORT}`;
const CI = !!process.env.CI;
const serve = `node scripts/serve.mjs --quiet --port ${PORT}`;

export default defineConfig({
  testDir: 'tests/e2e',
  fullyParallel: true,
  forbidOnly: CI,
  retries: CI ? 1 : 0,
  workers: CI ? 2 : undefined,
  timeout: 60_000,
  expect: { timeout: 10_000 },
  reporter: CI
    ? [['github'], ['list'], ['html', { open: 'never' }]]
    : [['list'], ['html', { open: 'never' }]],
  use: {
    baseURL: BASE_URL,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  webServer: {
    command: process.env.E2E_NO_BUILD ? serve : `npm run build && ${serve}`,
    url: `${BASE_URL}/robots.txt`,
    reuseExistingServer: !CI,
    timeout: 300_000,
    stdout: 'pipe',
    stderr: 'pipe',
  },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
    { name: 'firefox', use: { ...devices['Desktop Firefox'] } },
    { name: 'webkit', use: { ...devices['Desktop Safari'] } },
    { name: 'mobile-chrome', use: { ...devices['Pixel 7'] } },
    { name: 'mobile-safari', use: { ...devices['iPhone 14'] } },
  ],
});
