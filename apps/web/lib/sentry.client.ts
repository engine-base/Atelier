/**
 * Atelier — Sentry browser-side initialization helper (T-F-08).
 *
 * selected-stack.json#observability = "Sentry (errors) + Langfuse (LLM) + Better Stack (logs)"
 *
 * 設計方針:
 * - `@sentry/nextjs` は optional dep (本 PR の scope では未追加)。動的 import で
 *   未インストール環境を許容し、no-op フォールバックを返す。SDK は follow-up
 *   PR で apps/web/package.json に追加される。
 * - DSN は `process.env.NEXT_PUBLIC_SENTRY_DSN` を読む (Vercel + .env.local 配線済)。
 * - sample rate / replay は EU リージョン (engine-base.sentry.io) を前提に
 *   開発期 100%、本番は 10% 推奨 (環境変数で上書き可能)。
 *
 * 使い方 (follow-up で wire される想定):
 *   // apps/web/app/layout.tsx
 *   import { initSentryClient } from '@/lib/sentry.client';
 *   initSentryClient();
 */

export interface SentryClientConfig {
  /** DSN URL。未指定なら NEXT_PUBLIC_SENTRY_DSN を読む。 */
  dsn?: string;
  /** "production" | "preview" | "development"。Vercel が自動注入。 */
  environment?: string;
  /** error 送信のサンプリング率 (0.0〜1.0)。デフォルト 1.0。 */
  tracesSampleRate?: number;
  /** session replay の通常サンプリング率。デフォルト 0.0 (有料機能節約)。 */
  replaysSessionSampleRate?: number;
  /** error 発生時の session replay サンプリング率。デフォルト 1.0。 */
  replaysOnErrorSampleRate?: number;
  /** release タグ (source map と対応付け)。Vercel の git sha を推奨。 */
  release?: string;
}

/**
 * Sentry browser SDK が利用可能か。SDK が未インストールなら false。
 *
 * client bundle で `@sentry/nextjs` を解決できるかをチェックする。
 * Next.js webpack はビルド時に解決を試みるため、SDK が無いと build 自体は
 * 通るが runtime で undefined になる。本関数で安全に分岐する。
 */
export function isSentryAvailable(): boolean {
  // SDK が未インストールでもビルドが通るように、グローバル参照を経由。
  // 実 SDK 配線時に @sentry/nextjs が `window.__SENTRY__` を設定する。
  if (typeof window === 'undefined') return false;
  const w = window as unknown as { __SENTRY__?: unknown };
  return w.__SENTRY__ !== undefined;
}

const DEFAULT_TRACES_SAMPLE_RATE = 1.0;
const DEFAULT_REPLAYS_SESSION_SAMPLE_RATE = 0.0;
const DEFAULT_REPLAYS_ON_ERROR_SAMPLE_RATE = 1.0;

/**
 * Sentry browser SDK を初期化する。
 *
 * SDK が未インストールの場合は warn ログを 1 回出して no-op。
 * 既に初期化済の場合は idempotent (重複 init を抑止)。
 *
 * @returns 初期化成功で `true`、SDK 不在 / DSN 不在で `false`。
 */
export async function initSentryClient(
  config: SentryClientConfig = {}
): Promise<boolean> {
  const dsn = config.dsn ?? process.env.NEXT_PUBLIC_SENTRY_DSN;
  if (!dsn) {
    if (typeof console !== 'undefined') {
      console.warn(
        '[sentry] NEXT_PUBLIC_SENTRY_DSN is not set; skipping Sentry init'
      );
    }
    return false;
  }

  // 動的 import — SDK 未インストール時に build を fail させない。
  // import() expression は webpack に静的解析されないように文字列変数化。
  const moduleName = '@sentry/nextjs';
  type SentryNextModule = {
    init?: (options: Record<string, unknown>) => void;
    isInitialized?: () => boolean;
  };
  let mod: SentryNextModule;
  try {
    // 動的 import を `as unknown as ...` で narrow。SDK 未インストール時は catch で fallback。
    const imported: unknown = await import(/* webpackIgnore: true */ moduleName);
    mod = imported as SentryNextModule;
  } catch {
    if (typeof console !== 'undefined') {
      console.warn(
        '[sentry] @sentry/nextjs is not installed; skipping init. ' +
          'Add it via `pnpm add @sentry/nextjs` in apps/web.'
      );
    }
    return false;
  }

  if (mod.isInitialized?.()) {
    return true;
  }

  mod.init?.({
    dsn,
    environment: config.environment ?? process.env.NEXT_PUBLIC_VERCEL_ENV ?? 'development',
    release: config.release ?? process.env.NEXT_PUBLIC_VERCEL_GIT_COMMIT_SHA,
    tracesSampleRate: config.tracesSampleRate ?? DEFAULT_TRACES_SAMPLE_RATE,
    replaysSessionSampleRate:
      config.replaysSessionSampleRate ?? DEFAULT_REPLAYS_SESSION_SAMPLE_RATE,
    replaysOnErrorSampleRate:
      config.replaysOnErrorSampleRate ?? DEFAULT_REPLAYS_ON_ERROR_SAMPLE_RATE,
    // 既知の noise を除外
    ignoreErrors: [
      'ResizeObserver loop limit exceeded',
      'Network request failed',
      /^Non-Error promise rejection captured/,
    ],
  });
  return true;
}

/**
 * Sentry が捕捉する error category。`scope.setTag('category', ...)` に使う。
 */
export type SentryErrorCategory =
  | 'auth'
  | 'ui'
  | 'api'
  | 'llm'
  | 'rag'
  | 'realtime'
  | 'unknown';
