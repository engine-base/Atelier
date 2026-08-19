/**
 * GAP-182 — 画面で起きたエラーを自前のサーバーに残す。
 *
 * これまでの実態: ErrorBoundary には `onError` という「Sentry 配線スロット」が
 * 空のまま置かれ、しかも ErrorBoundary 自体がどの画面からも使われていなかった。
 * つまり画面が白くなっても運営には一切届かなかった。
 *
 * 経営者判断 (2026-08-19「B で進めて」): 外部 SaaS には送らない。
 * POST /client-errors で自分たちの DB に記録する。失敗しても画面は壊さない。
 */

import { createAuthedApiClient } from "./auth/connector";

export interface ClientErrorReport {
  readonly kind: string;
  readonly message: string;
  readonly path?: string;
  readonly stack?: string;
}

const MESSAGE_MAX = 1000;
const STACK_MAX = 8000;

/** エラーを 1 件報告する。ネットワーク失敗などは握りつぶす (画面を止めない)。 */
export async function reportClientError(
  report: ClientErrorReport,
): Promise<void> {
  try {
    const client = createAuthedApiClient();
    await client.post("/client-errors", {
      body: {
        kind: report.kind.slice(0, 200),
        message: report.message.slice(0, MESSAGE_MAX) || report.kind,
        ...(report.path ? { path: report.path.slice(0, 500) } : {}),
        ...(report.stack ? { stack: report.stack.slice(0, STACK_MAX) } : {}),
      },
    });
  } catch {
    // 記録できなくても利用者の操作は妨げない (ここで throw すると二次障害になる)
  }
}

/** Error オブジェクトから報告する (ErrorBoundary の既定 onError)。 */
export function reportClientException(error: Error): void {
  void reportClientError({
    kind: error.name || "Error",
    message: error.message || String(error),
    ...(typeof window !== "undefined"
      ? { path: window.location.pathname }
      : {}),
    ...(error.stack ? { stack: error.stack } : {}),
  });
}
