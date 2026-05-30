import { defineConfig } from 'vitest/config';

/**
 * Bridge 用 vitest 設定 — root vitest.config.ts は apps/** glob を使っているため
 * apps/bridge cwd から `vitest run` した時に解決できない。本ファイルで __tests__/
 * を明示する。
 */
export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['__tests__/**/*.{test,spec}.ts'],
    exclude: ['node_modules/**', 'dist/**', 'out/**'],
  },
});
