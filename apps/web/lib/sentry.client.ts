/**
 * Atelier — Sentry browser-side initialization helper (T-F-08).
 *
 * selected-stack.json#observability = "Sentry (errors) + Langfuse (LLM) + Better Stack (logs)"
 *
 * 設計方針:
 * - `@sentry/nextjs` は **T-F-42 で実依存になった** (apps/web/package.json)。
 *   動的 import は「未インストール環境を許容するため」ではなく、
 *   **初期表示のバンドルから外して code-split するため**に使う。
 *   SDK 不在時の耐性は catch がそのまま担保する。
 * - DSN は `process.env.NEXT_PUBLIC_SENTRY_DSN` を読む (Vercel + .env.local 配線済)。
 * - sample rate / replay は EU リージョン (engine-base.sentry.io) を前提に
 *   開発期 100%、本番は 10% 推奨 (環境変数で上書き可能)。
 *
 * 呼び出し元 (T-F-42 で配線済):
 *   apps/web/providers/observability-provider.tsx → app/layout.tsx のツリー
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

  // 動的 import は **静的な specifier** で書く (code-split させる)。
  // 旧実装は webpackIgnore magic comment + 変数 specifier で「バンドラに解析させない」
  // 形だった。SDK 未導入だった当時の防御としては妥当だったが、SDK が実依存になった
  // 今は有害: バンドラが解決を諦め、ブラウザに素の `import("@sentry/nextjs")` が残る。
  // bare specifier はブラウザが解決できないため必ず throw し、**SDK を入れても
  // 送信 0 件**になる。しかも vitest は解決できてしまうのでユニットテストは緑になる
  // (fake SDK と同じ『テストだけ通る』形)。判定は本番ビルド成果物で行うこと。
  type SentryNextModule = {
    init?: (options: Record<string, unknown>) => void;
    isInitialized?: () => boolean;
  };
  let mod: SentryNextModule;
  try {
    // SDK 不在・読み込み失敗時の耐性は下の catch がそのまま担保する。
    const imported: unknown = await import('@sentry/nextjs');
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
