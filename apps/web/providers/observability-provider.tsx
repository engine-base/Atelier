/**
 * ObservabilityProvider — T-F-42 (Sentry 実配線)
 *
 * `lib/sentry.client.ts` の `initSentryClient()` は T-F-08 で実装されたものの
 * 呼び出し元が 1 つも無く、ブラウザ側のエラー捕捉が実質ゼロだった (GAP-108)。
 * 本 provider が「実際に呼ぶ」唯一の入口であり、`app/layout.tsx` のツリーに
 * 組み込まれる。
 *
 * 設計方針:
 * - 初期化はマウント後 1 回だけ (React 18 StrictMode の二重実行でも
 *   initSentryClient() 側が idempotent なので二重 init されない)。
 * - DSN 未設定 / SDK 未インストールでも描画は必ず継続する (no-op + warn)。
 * - `captureException()` は ErrorBoundary から使う実送信口。SDK 不在でも
 *   throw せず false を返す。
 */

'use client';

import * as React from 'react';
import { useEffect, type ReactNode } from 'react';

import { initSentryClient, type SentryErrorCategory } from '../lib/sentry.client';

/** `@sentry/nextjs` のうち本モジュールが使う部分だけの構造型。 */
interface SentryCaptureModule {
  captureException?: (error: unknown, hint?: Record<string, unknown>) => string | undefined;
}

/** captureException に添える文脈。Sentry の tag / extra に載る。 */
export interface CaptureContext {
  /** エラー分類。Sentry 上で `category` tag になる。 */
  readonly category?: SentryErrorCategory;
  /** React の componentStack 等の補助情報。 */
  readonly componentStack?: string;
}

/**
 * エラーを Sentry へ送る。
 *
 * SDK 未インストール / 未初期化でも **絶対に throw しない**。観測基盤の不在を
 * UI の障害に昇格させないため、失敗は `false` の戻り値でのみ表現する。
 *
 * @returns Sentry へ送れたら `true`、SDK 不在・送信失敗なら `false`。
 */
export async function captureException(
  error: unknown,
  context: CaptureContext = {},
): Promise<boolean> {
  // 動的 import — SDK 未インストール時に build / render を fail させない。
  // webpack の静的解析を避けるため module 名を変数化する (sentry.client.ts と同方針)。
  const moduleName = '@sentry/nextjs';
  try {
    const imported: unknown = await import(/* webpackIgnore: true */ moduleName);
    const mod = imported as SentryCaptureModule;
    if (typeof mod.captureException !== 'function') return false;
    mod.captureException(error, {
      tags: { category: context.category ?? 'unknown' },
      extra: context.componentStack ? { componentStack: context.componentStack } : {},
    });
    return true;
  } catch {
    return false;
  }
}

interface ObservabilityProviderProps {
  readonly children: ReactNode;
}

/**
 * ブラウザ側の観測基盤を起動する provider。`app/layout.tsx` の body 直下に置く。
 *
 * 子ツリーはそのまま描画するため、初期化の成否はレンダリングに影響しない。
 */
export function ObservabilityProvider({ children }: ObservabilityProviderProps) {
  useEffect(() => {
    // 初期化失敗 (DSN 未設定・SDK 不在) は initSentryClient() 内で warn 済み。
    // ここで throw させないため rejection も握り潰す。
    void initSentryClient().catch(() => false);
  }, []);

  return <>{children}</>;
}
