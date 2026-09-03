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

/** 招待トークンの署名前プレビュー (GAP-028 — メタ限定)。 */
export interface ClientInvitationPreviewData {
  readonly project_name: string;
  readonly workspace_name: string;
  readonly inviter_name: string | null;
  readonly invited_email: string;
  readonly expires_at: string;
  readonly remaining_days: number;
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

/** クライアントポータルからサインアウトする (cookie 破棄)。 */
export function clearClientAccessToken(): void {
  if (typeof document === "undefined") return;
  document.cookie = `${COOKIE_NAMES.clientAccess}=; path=/; expires=Thu, 01 Jan 1970 00:00:00 GMT; SameSite=Lax`;
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

/** 招待トークンの署名前プレビューを取得 (GAP-028)。状態は変化しない。 */
export async function clientInvitationPreview(
  invitationToken: string,
): Promise<ClientInvitationPreviewData> {
  const res = await fetch(`${API_BASE}/client/auth/preview`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ invitation_token: invitationToken }),
  });
  const json = await parseJson(res);
  if (!res.ok)
    throw new ClientPortalError(detailMessage(json, res.status), res.status);
  const data = json?.data as ClientInvitationPreviewData | undefined;
  if (!data) throw new ClientPortalError("unexpected response", res.status);
  return data;
}

/** サインイン時の同意 2 種 (GAP-028 — サーバー必須、初回同意時刻を永続)。 */
export interface ClientSigninConsents {
  readonly agreeLegal: boolean;
  readonly agreeConfidential: boolean;
}

/** 招待トークンでサインイン。成功で cookie 設定し project / scopes を返す。 */
export async function clientSignin(
  invitationToken: string,
  displayName?: string,
  consents?: ClientSigninConsents,
): Promise<ClientSigninResult> {
  const res = await fetch(`${API_BASE}/client/auth/signin`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      invitation_token: invitationToken,
      display_name: displayName || undefined,
      agree_legal: consents?.agreeLegal ?? false,
      agree_confidential: consents?.agreeConfidential ?? false,
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

// --------------------------------------------------------------------------- //
// GAP-029: S-L03 実コンテンツ (client スコープ read API + コメント投稿)。
// R-T08: 全て client JWT の project_id claim に限定 (越境は API が 403)。
// --------------------------------------------------------------------------- //

export interface ClientPhaseItemData {
  readonly name: string;
  readonly order: number;
  readonly status: string;
}

export interface ClientProjectOverviewData {
  readonly phases: readonly ClientPhaseItemData[];
  readonly progress_percent: number;
  readonly operator_workspace_name: string | null;
  readonly operator_name: string | null;
  readonly link_expires_at: string | null;
  readonly link_remaining_days: number | null;
}

export interface ClientOutputItemData {
  readonly id: string;
  readonly stage: string;
  readonly stage_label: string;
  readonly version: number;
  readonly updated_at: string;
  readonly formats: readonly string[];
  readonly summary: string | null;
}

export interface ClientMockItemData {
  readonly id: string;
  readonly screen_name: string;
  readonly version: number;
  readonly updated_at: string;
}

export interface ClientMocksData {
  readonly items: readonly ClientMockItemData[];
  readonly total_screens: number;
}

export interface ClientCommentItemData {
  readonly id: string;
  readonly target_type: string;
  readonly target_id: string;
  readonly target_label: string | null;
  readonly content: string;
  readonly author_name: string | null;
  readonly is_client_author: boolean;
  readonly created_at: string;
}

export interface ClientCommentCreateInput {
  readonly target_type: "workflow_output" | "mock";
  readonly target_id: string;
  readonly content: string;
}

async function clientGet<T>(path: string, token: string): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, {
    method: "GET",
    headers: { Authorization: `Bearer ${token}` },
  });
  const json = await parseJson(res);
  if (!res.ok)
    throw new ClientPortalError(detailMessage(json, res.status), res.status);
  const data = json?.data as T | undefined;
  if (data === undefined)
    throw new ClientPortalError("unexpected response", res.status);
  return data;
}

/** 工程進捗 + 運営 + リンク有効期限 (GAP-029)。 */
export function getClientOverview(
  projectId: string,
  token: string,
): Promise<ClientProjectOverviewData> {
  return clientGet(
    `/client/projects/${encodeURIComponent(projectId)}/overview`,
    token,
  );
}

/** 成果物一覧 — stage 毎の最新版 (GAP-029)。 */
export function getClientOutputs(
  projectId: string,
  token: string,
): Promise<ClientOutputItemData[]> {
  return clientGet(
    `/client/projects/${encodeURIComponent(projectId)}/outputs`,
    token,
  );
}

/** モック一覧 — 画面毎の最新版 (GAP-029)。 */
export function getClientMocks(
  projectId: string,
  token: string,
): Promise<ClientMocksData> {
  return clientGet(
    `/client/projects/${encodeURIComponent(projectId)}/mocks`,
    token,
  );
}

/** 自分のコメント + 運営返信 (GAP-029)。 */
export function getClientComments(
  projectId: string,
  token: string,
): Promise<ClientCommentItemData[]> {
  return clientGet(
    `/client/projects/${encodeURIComponent(projectId)}/comments`,
    token,
  );
}

export interface ClientContentUrlData {
  readonly url: string;
  readonly kind?: "html" | "pdf" | "image" | "sheet" | "binary";
  readonly file_name?: string | null;
  readonly mime?: string | null;
}

/** 共有済み成果物の署名付き閲覧 URL (GAP-268 / 通し J23-05)。 */
export function getClientOutputContentUrl(
  projectId: string,
  outputId: string,
  format: "html" | "json" | "md",
  token: string,
): Promise<ClientContentUrlData> {
  return clientGet(
    `/client/projects/${encodeURIComponent(projectId)}/outputs/${encodeURIComponent(outputId)}/content-url?format=${format}`,
    token,
  );
}

/** コメント投稿 — comment スコープ必須 (GAP-029)。 */
export async function postClientComment(
  projectId: string,
  token: string,
  input: ClientCommentCreateInput,
): Promise<ClientCommentItemData> {
  const res = await fetch(
    `${API_BASE}/client/projects/${encodeURIComponent(projectId)}/comments`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(input),
    },
  );
  const json = await parseJson(res);
  if (!res.ok)
    throw new ClientPortalError(detailMessage(json, res.status), res.status);
  const data = json?.data as ClientCommentItemData | undefined;
  if (!data) throw new ClientPortalError("unexpected response", res.status);
  return data;
}
