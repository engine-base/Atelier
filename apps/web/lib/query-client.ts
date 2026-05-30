/**
 * TanStack Query — QueryClient 既定値 (T-US-05)
 *
 * 既定の cache 戦略:
 *   - staleTime: 30s — 同一データの過剰 refetch を防ぎつつ、Realtime/SSE で吹き替え
 *   - gcTime:    5min — 画面遷移後も短時間は cache に保持
 *   - retry:     2回 — 4xx 系は即時 fail (再試行しても無駄)
 *   - refetchOnWindowFocus: false — モーダル等の焦点復帰での flicker 防止 (Realtime で補完)
 *   - refetchOnReconnect:   true  — オフライン復帰時は再取得
 *
 * Atelier 固有:
 *   - ApiError.status が 4xx (401/403/404/409/410/422) の場合は retry しない
 *   - 401 は middleware による refresh の領分 (T-US-03)
 */

import { QueryClient } from '@tanstack/react-query';

import { ApiError } from '@atelier/api-client';

/** ApiClient で扱う構造的エラー扱いを retry policy に反映 */
function shouldRetry(failureCount: number, error: unknown): boolean {
  if (failureCount >= 2) return false;
  if (error instanceof ApiError) {
    if (error.status >= 400 && error.status < 500) return false;
  }
  return true;
}

/** Atelier 既定の QueryClient を生成。テストや SSR で個別 instance を作る場合も同じ defaults */
export function createQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        staleTime: 30 * 1000,
        gcTime: 5 * 60 * 1000,
        retry: shouldRetry,
        refetchOnWindowFocus: false,
        refetchOnReconnect: true,
      },
      mutations: {
        retry: shouldRetry,
      },
    },
  });
}

/** 公開: テストでの差分検証用 */
export const _internal = { shouldRetry };
