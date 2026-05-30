/**
 * フロント↔API 認証コネクタ (dev connector / T-A-01・02 配線)。
 *
 * signup / signin を実 API (`apps/api` FastAPI) に対して呼び、成功時に
 * `atelier_access` cookie を設定する。middleware.ts がこの cookie を見て
 * 保護ルートへのアクセスを許可する。
 *
 * API base は NEXT_PUBLIC_API_URL (既定 http://localhost:8000)。
 * 本番では HttpOnly cookie を server 側で設定するが、ローカル dev では
 * client から document.cookie で設定する (middleware は read のみ)。
 */

import { COOKIE_NAMES } from './cookie';

const API_BASE = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:8000';

export type ConsentType =
  | 'terms_of_service'
  | 'privacy_policy'
  | 'data_residency'
  | 'ai_training_optin';

interface SigninData {
  access_token: string;
  expires_at: string;
  user_id: string;
  email: string;
  display_name: string;
}

class AuthError extends Error {}

function setAccessCookie(token: string, expiresAt: string): void {
  const expires = new Date(expiresAt).toUTCString();
  // dev: SameSite=Lax / path=/。本番は server 側 HttpOnly。
  document.cookie = `${COOKIE_NAMES.access}=${token}; path=/; expires=${expires}; SameSite=Lax`;
}

async function postJson<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
    body: JSON.stringify(body),
  });
  const json = (await res.json().catch(() => null)) as { data?: T; detail?: unknown } | null;
  if (!res.ok) {
    const detail = json?.detail;
    throw new AuthError(typeof detail === 'string' ? detail : `HTTP ${res.status}`);
  }
  if (!json?.data) throw new AuthError('unexpected response');
  return json.data;
}

/** 実 API signin → cookie 設定。成功で SigninData を返す。 */
export async function signin(email: string, password: string): Promise<SigninData> {
  const data = await postJson<SigninData>('/auth/signin', { email, password });
  setAccessCookie(data.access_token, data.expires_at);
  return data;
}

/** 実 API signup → 続けて signin して cookie 設定。 */
export async function signup(email: string, password: string): Promise<SigninData> {
  const today = new Date().toISOString().slice(0, 10);
  const displayName = email.split('@')[0] || email;
  await postJson('/auth/signup', {
    email,
    password,
    display_name: displayName,
    consents: [
      { type: 'terms_of_service', version: today, accepted: true },
      { type: 'privacy_policy', version: today, accepted: true },
      // AI 学習はデフォルト OFF (絶対ルール #6)
      { type: 'ai_training_optin', version: today, accepted: false },
    ],
  });
  // 登録直後に自動ログインして cookie を確立
  return signin(email, password);
}
