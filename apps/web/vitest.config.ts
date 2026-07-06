import { defineConfig, mergeConfig } from 'vitest/config';

import rootConfig from '../../vitest.config';

/**
 * apps/web の Vitest 設定。Next.js 環境のため jsdom + React 用 plugin が要る場合は
 * ここで上書き。現状は root config をそのまま継承。
 */
export default mergeConfig(
  rootConfig,
  defineConfig({
    test: {
      environment: 'jsdom',
      include: ['**/*.{test,spec}.{ts,tsx}'],
      // Node 22+/25 の実験的 WebStorage が jsdom の localStorage を shadow して
      // clear() 欠落の TypeError になるのを防ぐ（Node バージョン非依存にする）。
      setupFiles: ['./tests/setup/localstorage.ts'],
    },
  }),
);
