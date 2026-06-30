/**
 * クライアントポータル認証 (R-T08) — T-UC-21 / T-UC-22
 *
 * 通常ユーザ (atelier_access) とは別系統の client_portal JWT を扱う。
 * 招待トークンで /client/auth/signin → client_access_token を atelier_client_access
 * cookie に保存し、/client/projects/{id} を Bearer で取得する。
 * R-T08: クライアントは自分の project 以外を参照できない（API が 403 cross_project）。
 */

import { API_BASE } from "./connector";
import { COOKIE_NAMES } from "./cookie";

/** client-portal API エラー。status を保持（401 invalid / 410 expired / 403 cross-project）。 */
export class ClientPortalError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

export interface ClientSigninResult {
  readonly client_access_token: string;
  readonly expires_at: string;
  readonly project: { readonly id: string; readonly name: string };
  readonly scopes: readonly string[];
}

export interface ClientProjectData {
  readonly id: string;
  readonly name: string;
  readonly description: string | null;
  readonly scopes: readonly string[];
  readonly viewed_as_client_display_name: string | null;
}

function setClientAccessCookie(token: string, expiresAt: string): void {
  const expires = new Date(expiresAt).toUTCString();
  document.cookie = `${COOKIE_NAMES.clientAccess}=${token}; path=/; expires=${expires}; SameSite=Lax`;
}

/** document.cookie から atelier_client_access を読む。無ければ null。 */
export function readClientAccessToken(): string | null {
  if (typeof document === "undefined") return null;
  const m = document.cookie.match(
    new RegExp(`(?:^|; )${COOKIE_NAMES.clientAccess}=([^;]+)`),
  );
  return m && m[1] ? decodeURIComponent(m[1]) : null;
}

async function parseJson(
  res: Response,
): Promise<{ data?: unknown; detail?: unknown } | null> {
  return (await res.json().catch(() => null)) as {
    data?: unknown;
    detail?: unknown;
  } | null;
}

function detailMessage(
  json: { detail?: unknown } | null,
  status: number,
): string {
  return typeof json?.detail === "string" ? json.detail : `HTTP ${status}`;
}

/** 招待トークンでサインイン。成功で cookie 設定し project / scopes を返す。 */
export async function clientSignin(
  invitationToken: string,
  displayName?: string,
): Promise<ClientSigninResult> {
  const res = await fetch(`${API_BASE}/client/auth/signin`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      invitation_token: invitationToken,
      display_name: displayName || undefined,
    }),
  });
  const json = await parseJson(res);
  if (!res.ok)
    throw new ClientPortalError(detailMessage(json, res.status), res.status);
  const data = json?.data as ClientSigninResult | undefined;
  if (!data) throw new ClientPortalError("unexpected response", res.status);
  setClientAccessCookie(data.client_access_token, data.expires_at);
  return data;
}

/** client_portal JWT で限定 project ビューを取得。越境は API が 403。 */
export async function getClientProject(
  projectId: string,
  token: string,
): Promise<ClientProjectData> {
  const res = await fetch(
    `${API_BASE}/client/projects/${encodeURIComponent(projectId)}`,
    {
      method: "GET",
      headers: { Authorization: `Bearer ${token}` },
    },
  );
  const json = await parseJson(res);
  if (!res.ok)
    throw new ClientPortalError(detailMessage(json, res.status), res.status);
  const data = json?.data as ClientProjectData | undefined;
  if (!data) throw new ClientPortalError("unexpected response", res.status);
  return data;
}
