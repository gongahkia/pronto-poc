import { defineConfig } from '@playwright/test';

// Separate from the ordinary suite: this targets an explicitly prepared,
// disposable Pronto database and disposable Huddle service. Starts no workers.
export default defineConfig({
  testDir: './tests/huddle', workers: 1, fullyParallel: false, retries: 0,
  timeout: 120_000, expect: { timeout: 15_000 },
  outputDir: 'output/huddle-dogfood/browser',
  reporter: [['list'], ['json', { outputFile: 'output/huddle-dogfood/browser-report.json' }]],
  use: { baseURL: process.env.PLAYWRIGHT_BASE_URL ?? 'http://127.0.0.1:3000', trace: 'retain-on-failure', screenshot: 'only-on-failure' },
  projects: [
    { name: 'chromium', use: { browserName: 'chromium' } },
    { name: 'firefox', use: { browserName: 'firefox' } },
  ],
});
