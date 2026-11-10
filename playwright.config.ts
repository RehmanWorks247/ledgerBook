import { defineConfig, devices } from '@playwright/test';

const safari = process.env.E2E_BROWSER === 'webkit';
export default defineConfig({
  testDir: './e2e', testMatch: '**/*.spec.ts', fullyParallel: false, workers: 1,
  timeout: 60_000, expect: { timeout: 10_000 },
  outputDir: '.local/e2e/results',
  reporter: [['list'], ['html', { outputFolder: '.local/e2e/report', open: 'never' }]],
  use: { baseURL: 'http://127.0.0.1:4312', actionTimeout: 10_000, trace: 'retain-on-failure', screenshot: 'only-on-failure' },
  projects: [{ name: safari ? 'webkit' : 'chromium', use: { ...devices[safari ? 'Desktop Safari' : 'Desktop Chrome'] } }],
  webServer: {
    command: 'node --require ./tests/test-environment.cjs --import tsx e2e/server.ts',
    url: 'http://127.0.0.1:4312/api/health', reuseExistingServer: false, timeout: 60_000,
  },
});
