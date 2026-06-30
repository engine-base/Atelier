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

import { MutationCache, QueryCache, QueryClient } from "@tanstack/react-query";

import { ApiError } from "@atelier/api-client";

import { pushToast } from "./toast/store";

/** ApiClient で扱う構造的エラー扱いを retry policy に反映 */
function shouldRetry(failureCount: number, error: unknown): boolean {
  if (failureCount >= 2) return false;
  if (error instanceof ApiError) {
    if (error.status >= 400 && error.status < 500) return false;
  }
  return true;
}

/** ApiError の status から利用者向けの簡潔なメッセージを作る。 */
function toastMessage(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.status === 403) return "権限がありません。";
    if (error.status === 404) return "対象が見つかりませんでした。";
    if (error.status === 422) return "入力内容を確認してください。";
    if (error.status >= 500) return "サーバーでエラーが発生しました。";
    return `エラーが発生しました（HTTP ${error.status}）。`;
  }
  return "通信エラーが発生しました。時間をおいて再試行してください。";
}

/**
 * 4xx/5xx 時にグローバル toast を出す（AC「inline error + toast」の toast 部分を横断で担保）。
 * 401 は middleware の再ログイン誘導の領分なので toast しない。
 */
export function reportQueryError(error: unknown): void {
  if (error instanceof ApiError && error.status === 401) return;
  pushToast(toastMessage(error), "error");
}

/** Atelier 既定の QueryClient を生成。テストや SSR で個別 instance を作る場合も同じ defaults */
export function createQueryClient(): QueryClient {
  return new QueryClient({
    queryCache: new QueryCache({ onError: reportQueryError }),
    mutationCache: new MutationCache({ onError: reportQueryError }),
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
export const _internal = { shouldRetry, toastMessage };
