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
    // GAP-168: 503 = AI 実行経路ゼロ (Bridge 未接続) が実態。「サーバーで
    // エラー」は嘘になるので、画面の接続フローと同じ事実を言う。
    if (error.status === 503)
      return "お使いのパソコン (Bridge) が未接続です。画面の案内から接続してください。";
    if (error.status >= 500) return "サーバーでエラーが発生しました。";
    return `エラーが発生しました（HTTP ${error.status}）。`;
  }
  return "通信エラーが発生しました。時間をおいて再試行してください。";
}

/**
 * 4xx/5xx 時にグローバル toast を出す（AC「inline error + toast」の toast 部分を横断で担保）。
 * 401 は middleware の再ログイン誘導の領分なので toast しない。
 *
 * GAP-174: 画面がその状態を**正しく描き分けている**問い合わせ (例: Excel/PDF 成果物に
 * 対する /anchors は「テキストではないので位置指定できません」= 409 が正常応答) まで
 * 赤 toast を出すと、画面は正しく出ているのにエラーが出ているように見える。
 * `meta: { expectedErrors: true }` を付けたクエリはグローバル toast の対象外にする
 * (画面側で必ずその状態を表示していることが条件)。
 */
export function reportQueryError(error: unknown, source?: unknown): void {
  if (error instanceof ApiError && error.status === 401) return;
  const meta = (source as { meta?: { expectedErrors?: boolean } } | undefined)?.meta;
  if (meta?.expectedErrors === true) return;
  pushToast(toastMessage(error), "error");
}

/** Atelier 既定の QueryClient を生成。テストや SSR で個別 instance を作る場合も同じ defaults */
export function createQueryClient(): QueryClient {
  return new QueryClient({
    // GAP-174: onError の第 2 引数 (query / mutation) から meta を読むため素通しにする
    queryCache: new QueryCache({
      onError: (error, query) => reportQueryError(error, query),
    }),
    mutationCache: new MutationCache({
      onError: (error, _vars, _ctx, mutation) => reportQueryError(error, mutation),
    }),
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
