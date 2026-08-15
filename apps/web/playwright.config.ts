import { defineConfig } from "@playwright/test";

/**
 * Atelier E2E (Playwright) — human-grade-qa の planned TC を機械消化するハーネス。
 *
 * 前提: web (localhost:3000) と api (127.0.0.1:8000) と実 PG が起動済みであること。
 *   DB provision: PGURL=... bash scripts/ci/apply-migrations.sh (+ scripts/ci/pg-bootstrap.sql)
 * vitest と衝突しないよう testMatch は *.e2e.ts のみ (vitest は .test/.spec を拾う)。
 */
export default defineConfig({
  testDir: "./tests/e2e",
  testMatch: "**/*.e2e.ts",
  timeout: 30_000,
  retries: 0,
  reporter: [["line"]],
  use: {
    baseURL: process.env.E2E_BASE_URL ?? "http://localhost:3000",
    screenshot: "only-on-failure",
    // PW_CHROMIUM_PATH: playwright 管理外のシステム chromium で走らせる逃げ道
    // (バージョン違いのブラウザバイナリしか無い環境用。CI では未設定 = 通常動作)
    ...(process.env.PW_CHROMIUM_PATH
      ? { launchOptions: { executablePath: process.env.PW_CHROMIUM_PATH } }
      : {}),
  },
});
