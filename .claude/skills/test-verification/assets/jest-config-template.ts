// jest.config.ts
import type { Config } from "jest";

const config: Config = {
  preset: "ts-jest",
  testEnvironment: "node", // or "jsdom" for React component tests

  // テストファイルのパターン
  testMatch: [
    "**/__tests__/**/*.test.ts",
    "**/__tests__/**/*.test.tsx",
    "**/*.spec.ts",
    "**/*.spec.tsx",
  ],

  // テストから除外するもの
  testPathIgnorePatterns: ["/node_modules/", "/dist/", "/.next/"],

  // カバレッジ設定
  collectCoverage: true,
  collectCoverageFrom: [
    "src/**/*.{ts,tsx}",
    "!src/**/*.d.ts",
    "!src/**/*.stories.tsx",
    "!src/types/**",
  ],
  coverageThresholds: {
    // ビジネスロジック・認証・データ操作は80%以上
    global: {
      branches: 70,
      functions: 75,
      lines: 75,
      statements: 75,
    },
    // 特定ディレクトリへの個別閾値設定
    // "./src/services/": { lines: 80 },
    // "./src/utils/auth/": { lines: 85 },
  },
  coverageReporters: ["text", "text-summary", "lcov"],

  // パスエイリアス（tsconfig.jsonのpaths設定と合わせる）
  moduleNameMapper: {
    "^@/(.*)$": "<rootDir>/src/$1",
  },

  // グローバルセットアップ
  // globalSetup: "./jest.setup.ts",
  // setupFilesAfterFramework: ["./jest.setup.afterFramework.ts"],

  // タイムアウト設定
  testTimeout: 10000,

  // 並列実行
  maxWorkers: "50%",
};

export default config;
