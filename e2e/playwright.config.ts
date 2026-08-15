import { defineConfig, devices } from '@playwright/test';

/**
 * Atelier E2E — Playwright config.
 *
 * - apps/web (Next.js) を webServer で起動して叩く。
 * - 320 / 768 / 1024 / 1440 (web/testing.md) のレスポンシブ検証は project で切替。
 * - artifacts (screenshot/video/trace) は retry 時のみ保存し容量を抑える。
 */
const PORT = Number(process.env.ATELIER_E2E_PORT ?? '3000');
const BASE_URL = process.env.ATELIER_E2E_BASE_URL ?? `http://127.0.0.1:${PORT}`;
const IS_CI = !!process.env.CI;

export default defineConfig({
  testDir: './tests',
  fullyParallel: true,
  forbidOnly: IS_CI,
  retries: IS_CI ? 2 : 0,
  workers: IS_CI ? 2 : undefined,
  timeout: 30_000,
  expect: { timeout: 5_000 },
  reporter: IS_CI
    ? [['github'], ['html', { open: 'never' }]]
    : [['list'], ['html', { open: 'on-failure' }]],
  use: {
    baseURL: BASE_URL,
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
    locale: 'ja-JP',
    timezoneId: 'Asia/Tokyo',
    colorScheme: 'light',
    // PW_CHROMIUM_PATH: playwright 管理外のシステム chromium で走らせる逃げ道
    // (バージョン違いのブラウザバイナリしか無い環境用。CI では未設定 = 通常動作)
    ...(process.env.PW_CHROMIUM_PATH
      ? { launchOptions: { executablePath: process.env.PW_CHROMIUM_PATH } }
      : {}),
  },
  projects: [
    { name: 'chromium-desktop', use: { ...devices['Desktop Chrome'] } },
    { name: 'firefox-desktop', use: { ...devices['Desktop Firefox'] } },
    { name: 'webkit-desktop', use: { ...devices['Desktop Safari'] } },
    {
      name: 'chromium-tablet',
      use: { ...devices['Desktop Chrome'], viewport: { width: 768, height: 1024 } },
    },
    {
      name: 'chromium-mobile',
      use: { ...devices['iPhone 14'] },
    },
  ],
  webServer: {
    command: 'pnpm --filter @atelier/web dev',
    url: BASE_URL,
    // CI (a11y.yml) は API/DB 込みの本番ビルドを workflow 側で起動して待機済み。
    // ここで dev サーバーを二重起動すると「port already used」で即死するため、
    // 既存サーバーがあれば常に再利用する (無ければ従来どおり dev を起動)。
    reuseExistingServer: true,
    timeout: 120_000,
    stdout: 'pipe',
    stderr: 'pipe',
  },
});
