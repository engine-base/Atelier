import { defineConfig } from 'vitest/config';

/**
 * Vitest root config — workspace project を集約。
 * 各 workspace は独自の vitest.config.ts を持てるが、coverage は集約 80% gate。
 */
export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: [
      'apps/**/*.{test,spec}.{ts,tsx}',
      'packages/**/*.{test,spec}.{ts,tsx}',
    ],
    exclude: [
      '**/node_modules/**',
      '**/dist/**',
      '**/.next/**',
      'apps/web/tests/e2e/**',
      'e2e/**',
      'apps/bridge/dist/**',
    ],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov', 'html', 'json-summary'],
      include: [
        'apps/**/src/**/*.{ts,tsx}',
        'apps/web/app/**/*.{ts,tsx}',
        'packages/**/src/**/*.{ts,tsx}',
      ],
      exclude: [
        '**/*.d.ts',
        '**/*.config.{ts,js,mjs}',
        '**/dist/**',
        '**/.next/**',
        '**/node_modules/**',
        '**/index.ts',
      ],
      // Phase 0 placeholder 期は閾値 0。実装が乗ったら 80% (web/testing.md) に戻す
      thresholds: {
        lines: 0,
        functions: 0,
        branches: 0,
        statements: 0,
      },
    },
    reporters: ['default'],
  },
});
