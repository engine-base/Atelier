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
    },
  }),
);
