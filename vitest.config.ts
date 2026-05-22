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
        'packages/**/src/**/*.{ts,tsx}',
      ],
      // apps/web は Playwright E2E (T-F-23) で検証する。Vitest coverage 対象外。
      // packages/email/src/templates/* は React Email build 入力で unit test 対象外。
      exclude: [
        '**/*.d.ts',
        '**/*.config.{ts,js,mjs}',
        '**/dist/**',
        '**/.next/**',
        '**/node_modules/**',
        '**/index.ts',
        'apps/web/**',
        'packages/email/src/templates/**',
      ],
      // web/testing.md 規定: lines/functions/statements 80%, branches 75%
      thresholds: {
        lines: 80,
        functions: 80,
        branches: 75,
        statements: 80,
      },
    },
    reporters: ['default'],
  },
});
