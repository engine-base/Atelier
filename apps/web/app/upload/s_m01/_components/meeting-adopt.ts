/**
 * GAP-186: 議事録の抽出項目を「確認して採用」する API クライアント。
 *
 * 経営者指示「1,2 だね」の ①。**自動反映はしない** — AI の抽出をそのまま正に
 * すると、聞き間違い・言い過ぎがプロジェクトの要件として固定されてしまう。
 * 人がチェックしたものだけを要件・タスク・決定へ落とす。
 *
 * baseURL / token / fetch は注入可能 (テスト容易性)。
 */

import { API_BASE, readAccessToken } from "../../../../lib/auth/connector";

/** 採用できる項目の種別と、その反映先。 */
export type AdoptKind = "requirement" | "action" | "decision" | "open_question";

export interface AdoptableItem {
  readonly kind: AdoptKind;
  readonly key: string;
  readonly title: string;
  readonly detail: string;
  readonly quote: string;
  readonly meta: Readonly<Record<string, string>>;
  /** すでに採用済みか (押しても増えない)。 */
  readonly adopted: boolean;
  readonly target_type?: "task" | "decision" | null;
  readonly target_id?: string | null;
}

export interface AdoptResult {
  readonly created: readonly { key: string; target_type: string; target_id: string }[];
  readonly already: readonly string[];
  readonly missing: readonly string[];
  readonly message: string;
}

interface Opts {
  readonly baseURL?: string;
  readonly token?: string | null;
  readonly fetchImpl?: typeof fetch;
}

function ctx(opts: Opts) {
  const baseURL = opts.baseURL ?? API_BASE;
  const token = opts.token !== undefined ? opts.token : readAccessToken();
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (token) headers.Authorization = `Bearer ${token}`;
  return { baseURL, headers, doFetch: opts.fetchImpl ?? globalThis.fetch };
}

const KINDS: ReadonlySet<string> = new Set([
  "requirement",
  "action",
  "decision",
  "open_question",
]);

function toItem(raw: unknown): AdoptableItem | null {
  if (typeof raw !== "object" || raw === null) return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.key !== "string" || typeof r.title !== "string") return null;
  if (typeof r.kind !== "string" || !KINDS.has(r.kind)) return null;
  const meta =
    typeof r.meta === "object" && r.meta !== null
      ? (r.meta as Record<string, string>)
      : {};
  return {
    kind: r.kind as AdoptKind,
    key: r.key,
    title: r.title,
    detail: typeof r.detail === "string" ? r.detail : "",
    quote: typeof r.quote === "string" ? r.quote : "",
    meta,
    adopted: r.adopted === true,
    target_type:
      r.target_type === "task" || r.target_type === "decision" ? r.target_type : null,
    target_id: typeof r.target_id === "string" ? r.target_id : null,
  };
}

/** この議事録から採用できる項目 (採用済みの印つき)。 */
export async function fetchAdoptable(
  meetingId: string,
  opts: Opts = {},
): Promise<readonly AdoptableItem[]> {
  const { baseURL, headers, doFetch } = ctx(opts);
  const res = await doFetch(`${baseURL}/meetings/${meetingId}/adoptable`, {
    headers,
    credentials: "include",
  });
  if (!res.ok) throw new Error(`adoptable failed: ${res.status}`);
  const body = (await res.json()) as { data?: readonly unknown[] };
  return (body.data ?? []).map(toItem).filter((x): x is AdoptableItem => x !== null);
}

/** 選んだ項目だけを要件・タスク・決定へ反映する。 */
export async function adoptItems(
  meetingId: string,
  keys: readonly string[],
  opts: Opts = {},
): Promise<AdoptResult> {
  const { baseURL, headers, doFetch } = ctx(opts);
  const res = await doFetch(`${baseURL}/meetings/${meetingId}/adopt`, {
    method: "POST",
    headers,
    credentials: "include",
    body: JSON.stringify({ keys: [...keys] }),
  });
  if (!res.ok) throw new Error(`adopt failed: ${res.status}`);
  const body = (await res.json()) as { data?: Partial<AdoptResult> };
  return {
    created: body.data?.created ?? [],
    already: body.data?.already ?? [],
    missing: body.data?.missing ?? [],
    message: body.data?.message ?? "反映しました。",
  };
}
