import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir: './tests/ui',
  fullyParallel: false,
  workers: 1,
  timeout: 30000,
  use: { baseURL: 'http://127.0.0.1:4318', browserName: 'chromium', trace: 'retain-on-failure' },
  webServer: {
    command: 'node src/server.ts',
    url: 'http://127.0.0.1:4318',
    env: { PORT: '4318' },
    reuseExistingServer: false,
  },
});
