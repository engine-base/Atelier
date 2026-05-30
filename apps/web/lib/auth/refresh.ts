/**
 * Refresh フロー — T-US-03 (認証フロー配管)
 *
 * Atelier API (T-A-04) の `/auth/refresh` を叩いて新しい access token を取得する。
 *
 * - 並行リクエスト集約: 同時刻に複数 401 が走った場合、最初の1本だけ refresh して
 *   後続は同 Promise を await する (refresh storm 防止)
 * - 失敗時は cookie 破棄 + /signin redirect は呼び出し側の責任
 */

import { z } from 'zod';

const RefreshResponseSchema = z.object({
  data: z.object({
    access_token: z.string(),
    refresh_token: z.string().optional(),
    expires_at: z.string(),
  }),
});
export type RefreshResponse = z.infer<typeof RefreshResponseSchema>['data'];

export interface RefreshOptions {
  /** API base URL (例: https://api.atelier.example) */
  readonly apiBaseUrl: string;
  /** fetch 差し替え (テスト用) */
  readonly fetch?: typeof fetch;
}

let inflight: Promise<RefreshResponse> | null = null;

/** /auth/refresh を叩いて access token を更新する。並行呼び出しは同 Promise を共有 */
export async function refreshAccessToken(opts: RefreshOptions): Promise<RefreshResponse> {
  if (inflight) return inflight;
  const fetchImpl = opts.fetch ?? globalThis.fetch;
  inflight = (async () => {
    const res = await fetchImpl(`${opts.apiBaseUrl.replace(/\/$/, '')}/auth/refresh`, {
      method: 'POST',
      credentials: 'include',
      headers: { Accept: 'application/json' },
    });
    if (!res.ok) {
      throw new Error(`refresh failed: ${res.status} ${res.statusText}`);
    }
    const body: unknown = await res.json();
    const parsed = RefreshResponseSchema.parse(body);
    return parsed.data;
  })();
  try {
    return await inflight;
  } finally {
    inflight = null;
  }
}

/** テスト用にキャッシュをリセット */
export function _resetInflightForTest(): void {
  inflight = null;
}
