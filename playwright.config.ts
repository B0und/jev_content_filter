import { defineConfig } from '@playwright/test';

export default defineConfig({
  projects: [
    { name: 'e2e', testDir: './tests/e2e' },
    { name: 'integration', testDir: './tests/browser-integration' },
  ],
  fullyParallel: false,
  workers: 1,
  timeout: 45_000,
  expect: { timeout: 10_000 },
  reporter: [['list'], ['html', { open: 'never' }]],
  use: {
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
});
