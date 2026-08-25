/**
 * 「/e2e 直下の 37 spec を実際に走らせる」ためだけの一時 config。
 *
 * 本来の e2e/playwright.config.ts は testDir: './tests' を指しており、
 * 直下の s_*.spec.ts / t-i-*.spec.ts (37 本) は **収集対象に入っていない**。
 * CI で走っていないどころか、ワークスペース自身の `pnpm test` でも走らない。
 * 何本が今も通るのかを測るために testDir だけ差し替えて走らせる。
 */
import { defineConfig, devices } from '@playwright/test';

const BASE_URL = process.env.ATELIER_E2E_BASE_URL ?? 'http://127.0.0.1:3100';

export default defineConfig({
  testDir: '../../e2e',
  testMatch: ['*.spec.ts'],
  fullyParallel: true,
  retries: 0,
  workers: 4,
  timeout: 30_000,
  expect: { timeout: 5_000 },
  reporter: [['list'], ['json', { outputFile: '.qa/e2e-audit-20260825/results.json' }]],
  use: {
    baseURL: BASE_URL,
    locale: 'ja-JP',
    timezoneId: 'Asia/Tokyo',
    colorScheme: 'light',
    screenshot: 'only-on-failure',
    launchOptions: { executablePath: '/opt/pw-browsers/chromium' },
  },
  projects: [{ name: 'chromium-desktop', use: { ...devices['Desktop Chrome'] } }],
});
