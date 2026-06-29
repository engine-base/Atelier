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

import { createApiClient, type ApiClient } from "@atelier/api-client";

import { COOKIE_NAMES } from "./cookie";

// API base: 明示の NEXT_PUBLIC_API_URL を最優先。未設定なら本番(Vercel)は Fly の
// API を、それ以外(ローカル)は localhost を既定にする。
export const API_BASE =
  process.env.NEXT_PUBLIC_API_URL ??
  (process.env.NODE_ENV === "production"
    ? "https://atelier-api-eb.fly.dev"
    : "http://localhost:8000");

export type ConsentType =
  | "terms_of_service"
  | "privacy_policy"
  | "data_residency"
  | "ai_training_optin";

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
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "include",
    body: JSON.stringify(body),
  });
  const json = (await res.json().catch(() => null)) as {
    data?: T;
    detail?: unknown;
  } | null;
  if (!res.ok) {
    const detail = json?.detail;
    throw new AuthError(
      typeof detail === "string" ? detail : `HTTP ${res.status}`,
    );
  }
  if (!json?.data) throw new AuthError("unexpected response");
  return json.data;
}

/** document.cookie から atelier_access (JWT) を読む。無ければ null。 */
export function readAccessToken(): string | null {
  if (typeof document === "undefined") return null;
  const m = document.cookie.match(
    new RegExp(`(?:^|; )${COOKIE_NAMES.access}=([^;]+)`),
  );
  return m && m[1] ? decodeURIComponent(m[1]) : null;
}

/** API エラー。status を保持する (401 等のハンドリング用)。 */
export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

/**
 * 認証付き GET。cookie の JWT を Authorization: Bearer に載せて呼ぶ。
 * `data` フィールドを返す (API は {data, meta} を返す)。
 * 401 のときは ApiError(status=401) を投げる (呼び出し側で再ログイン誘導可能)。
 */
export async function getJson<T>(
  path: string,
): Promise<{ data: T; meta?: unknown }> {
  const token = readAccessToken();
  const res = await fetch(`${API_BASE}${path}`, {
    method: "GET",
    headers: token ? { Authorization: `Bearer ${token}` } : {},
    credentials: "include",
  });
  const json = (await res.json().catch(() => null)) as {
    data?: T;
    meta?: unknown;
    detail?: unknown;
  } | null;
  if (!res.ok) {
    const detail = json?.detail;
    throw new ApiError(
      typeof detail === "string" ? detail : `HTTP ${res.status}`,
      res.status,
    );
  }
  return { data: (json?.data ?? []) as T, meta: json?.meta };
}

/**
 * 認証付き mutate (POST/PATCH/DELETE)。cookie の JWT を Bearer に載せる。
 * 204 など body が無い応答は data=undefined を返す。401/403 等は ApiError。
 */
export async function sendJson<T>(
  method: "POST" | "PATCH" | "DELETE",
  path: string,
  body?: unknown,
): Promise<T | undefined> {
  const token = readAccessToken();
  const res = await fetch(`${API_BASE}${path}`, {
    method,
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
    },
    credentials: "include",
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (res.status === 204) return undefined;
  const json = (await res.json().catch(() => null)) as {
    data?: T;
    detail?: unknown;
  } | null;
  if (!res.ok) {
    const detail = json?.detail;
    throw new ApiError(
      typeof detail === "string" ? detail : `HTTP ${res.status}`,
      res.status,
    );
  }
  return json?.data as T;
}

/**
 * 認証付き型安全 API クライアント (@atelier/api-client) を構築する。
 *
 * baseURL は API_BASE、token は cookie の atelier_access JWT を read する。
 * TanStack Query から呼ぶ container コンポーネントで利用する想定。
 * 型安全 (openapi paths 由来) で、4xx/5xx は `ApiError` として throw される。
 */
export function createAuthedApiClient(): ApiClient {
  return createApiClient({
    baseURL: API_BASE,
    getToken: () => readAccessToken(),
  });
}

/** 実 API signin → cookie 設定。成功で SigninData を返す。 */
export async function signin(
  email: string,
  password: string,
): Promise<SigninData> {
  const data = await postJson<SigninData>("/auth/signin", { email, password });
  setAccessCookie(data.access_token, data.expires_at);
  return data;
}

/** 実 API signup → 続けて signin して cookie 設定。 */
export async function signup(
  email: string,
  password: string,
): Promise<SigninData> {
  const today = new Date().toISOString().slice(0, 10);
  const displayName = email.split("@")[0] || email;
  await postJson("/auth/signup", {
    email,
    password,
    display_name: displayName,
    consents: [
      { type: "terms_of_service", version: today, accepted: true },
      { type: "privacy_policy", version: today, accepted: true },
      // AI 学習はデフォルト OFF (絶対ルール #6)
      { type: "ai_training_optin", version: today, accepted: false },
    ],
  });
  // 登録直後に自動ログインして cookie を確立
  return signin(email, password);
}
