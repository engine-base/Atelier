/**
 * フロント↔API 認証コネクタ (dev connector / T-A-01・02 配線)。
 *
 * signup / signin を実 API (`apps/api` FastAPI) に対して呼び、成功時に
 * `atelier_access` cookie を設定する。middleware.ts がこの cookie を見て
 * 保護ルートへのアクセスを許可する。
 *
 * API base は NEXT_PUBLIC_API_URL (既定 http://localhost:8000)。
 *
 * GAP-261 (通し J10-03): JWT は **`document.cookie` に書かない**。web オリジンの
 * route handler (`app/api/session`) に預け、HttpOnly cookie として保存する。
 * ブラウザ側はメモリにだけ持ち、Authorization ヘッダーに使う分は
 * `GET /api/session/token` (同一オリジン) から取り直す。
 * cookie 名・形式は据え置きなので middleware.ts の画面ガードはそのまま効く。
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

/**
 * GAP-261: ブラウザが持つトークンは **メモリだけ**。
 *
 * `document.cookie` に置くと XSS が 1 つでもあればそのまま盗まれる
 * (正本 J10-03 の期待は「HTTP-only cookie で JWT 発行」)。保存は
 * 同一オリジンの route handler に任せ、ここは Authorization 用の控えを持つ。
 */
let memoryToken: string | null = null;
let hydrating: Promise<string | null> | null = null;

/** サインイン直後: HttpOnly cookie に預け、メモリにも控える。 */
export async function storeSessionToken(
  token: string,
  expiresAt: string,
): Promise<void> {
  memoryToken = token;
  await fetch("/api/session", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "same-origin",
    body: JSON.stringify({ access_token: token, expires_at: expiresAt }),
  });
}

/**
 * HttpOnly cookie からトークンを取り直してメモリに載せる。
 *
 * 同時に何本も走らせない (画面が一斉に描画される瞬間に何十本も飛ぶ)。
 */
export async function ensureAccessToken(): Promise<string | null> {
  if (memoryToken !== null) return memoryToken;
  if (typeof window === "undefined") return null;
  hydrating ??= (async () => {
    try {
      const res = await fetch("/api/session/token", { credentials: "same-origin" });
      if (!res.ok) return null;
      const json = (await res.json()) as { data?: { access_token?: string | null } };
      memoryToken = json.data?.access_token ?? null;
      return memoryToken;
    } catch {
      return null;
    } finally {
      hydrating = null;
    }
  })();
  return await hydrating;
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

/**
 * いま手元にあるトークン (同期)。
 *
 * GAP-261 以降、新しいセッションの cookie は HttpOnly なので `document.cookie`
 * からは読めない。メモリの控え → (この変更より前に作られた) 素の cookie の順で見る。
 * 素の cookie を残すのは、**すでにサインイン中の人を締め出さないため**だけで、
 * 次のサインインで HttpOnly に置き換わる。
 */
export function readAccessToken(): string | null {
  if (memoryToken !== null) return memoryToken;
  if (typeof document === "undefined") return null;
  const m = document.cookie.match(
    new RegExp(`(?:^|; )${COOKIE_NAMES.access}=([^;]+)`),
  );
  const legacy = m && m[1] ? decodeURIComponent(m[1]) : null;
  if (legacy !== null) memoryToken = legacy;
  return legacy;
}

/** GAP-206: 503 の「理由」を載せるヘッダ (API の src/errors.py と対)。 */
export const REASON_HEADER = "X-Atelier-Reason";

/**
 * API エラー。status と、GAP-206 で足した **原因コード**を持ったまま投げる。
 *
 * 503 は「本人の PC (Bridge) 未接続」「保存先が未設定」「LLM 経路が未設定」と
 * 別物なのに、以前は **status しか無かった**。そのため画面は原因を推測し、
 * 保存先の設定漏れでも「パソコンを繋いでください」と案内していた
 * （あるいは両論併記で逃げていた）。**推測させないために原因を運ぶ。**
 */
export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    /** サーバーが返した原因コード (`bridge_offline` / `storage_unconfigured` 等)。 */
    readonly reason: string | null = null,
  ) {
    super(message);
  }

  /** 本人の PC が未接続であることが **サーバーの申告で** 確定しているか。 */
  get isBridgeOffline(): boolean {
    return this.reason === "bridge_offline";
  }
}

/**
 * GAP-209: サインアウト。**出る口**がアプリ本体に無かった。
 *
 * 出る手段はクライアントポータルにしか無く、共有 PC では前の人のセッションの
 * まま使えてしまう状態だった。ここでは 3 つ全部やる:
 *
 *   1. サーバー側で refresh token を失効させる (cookie を捨てるだけでは、
 *      盗まれた refresh token が生き続ける)
 *   2. cookie を捨てる
 *   3. **localStorage も捨てる** — 前の人が見ていたワークスペース/プロジェクトが
 *      次の人の画面に出るのを防ぐ
 *
 * サーバーに繋がらなくても手元は必ず片付ける (出られない、を作らない)。
 * 戻り値は「サーバー側の失効まで完了したか」。
 */
export async function signOut(): Promise<boolean> {
  let revoked = false;
  try {
    const token = await ensureAccessToken();
    if (token) {
      const res = await fetch(`${API_BASE}/auth/signout`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
        credentials: "include",
      });
      revoked = res.ok;
    }
  } catch {
    /* 繋がらなくても手元は片付ける */
  }
  clearLocalSession();
  return revoked;
}

/** cookie と localStorage を捨てる (サーバーに繋がらなくても必ず実行する)。 */
export function clearLocalSession(): void {
  if (typeof document === "undefined") return;
  const expire = "expires=Thu, 01 Jan 1970 00:00:00 GMT";
  for (const name of [
    COOKIE_NAMES.access,
    COOKIE_NAMES.refresh,
    COOKIE_NAMES.csrf,
  ]) {
    document.cookie = `${name}=; path=/; ${expire}; SameSite=Lax`;
  }
  // GAP-261: HttpOnly cookie は JS から消せない。route handler に消してもらう
  memoryToken = null;
  void fetch("/api/session", { method: "DELETE", credentials: "same-origin" }).catch(
    () => undefined,
  );
  try {
    // 前の人の文脈を次の人に見せない
    for (const key of [
      "atelier_current_workspace",
      "atelier_current_project",
      "atelier.reconsent.dismissed",
    ]) {
      window.localStorage.removeItem(key);
    }
  } catch {
    /* storage が使えなくても cookie は捨てられている */
  }
}

/** 応答から原因コードを取り出す (無ければ null)。 */
export function reasonOf(res: Response): string | null {
  const v = res.headers.get(REASON_HEADER);
  return v && v.trim() ? v.trim() : null;
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
      reasonOf(res),
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
      reasonOf(res),
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
    // GAP-261: HttpOnly cookie から取り直す (メモリに載っていればそれを使う)
    getToken: () => ensureAccessToken(),
  });
}

/** 実 API signin → cookie 設定。成功で SigninData を返す。 */
export async function signin(
  email: string,
  password: string,
): Promise<SigninData> {
  const data = await postJson<SigninData>("/auth/signin", { email, password });
  await storeSessionToken(data.access_token, data.expires_at);
  return data;
}

/**
 * GAP-210: **いま表示している法務文書の版**を取る。
 *
 * これまで登録時の同意記録には `new Date()` の日付をそのまま入れていた。
 * つまり「その人がどの文面に同意したのか」が記録から特定できず、
 * 「画面が見せた版を記録する」という GAP-206 の原則が signup 経路だけ
 * 抜けていた。副作用として、版 (2026-08-22) と日付 (登録日) がずれるため
 * **登録した直後の人に「規約を更新しました。同意をお願いします」の帯が出る**。
 *
 * 取得に失敗したら **登録を止める**。日付で代用すると同じ壊れ方に戻るため、
 * 「何に同意したのか分からない記録」を作らない方を選ぶ。
 */
async function currentLegalVersions(): Promise<Record<string, string>> {
  const res = await fetch(`${API_BASE}/public/legal-documents?locale=ja`, {
    method: "GET",
    headers: { Accept: "application/json" },
  });
  if (!res.ok) throw new ApiError("法務文書の版を取得できませんでした", res.status);
  const json = (await res.json()) as {
    data?: readonly { doc_type?: string; version?: string }[];
  };
  const out: Record<string, string> = {};
  for (const d of json.data ?? []) {
    if (d.doc_type && d.version) out[d.doc_type] = d.version;
  }
  return out;
}

/** 実 API signup → 続けて signin して cookie 設定。 */
export async function signup(
  email: string,
  password: string,
): Promise<SigninData> {
  const versions = await currentLegalVersions();
  const terms = versions["terms_of_service"];
  const privacy = versions["privacy_policy"];
  if (!terms || !privacy) {
    throw new ApiError("法務文書の版を取得できませんでした", 500);
  }
  const displayName = email.split("@")[0] || email;
  await postJson("/auth/signup", {
    email,
    password,
    display_name: displayName,
    consents: [
      { type: "terms_of_service", version: terms, accepted: true },
      { type: "privacy_policy", version: privacy, accepted: true },
      // AI 学習はデフォルト OFF (絶対ルール #6)。表示している規約の版に紐づける。
      { type: "ai_training_optin", version: terms, accepted: false },
    ],
  });
  // 登録直後に自動ログインして cookie を確立
  return signin(email, password);
}
