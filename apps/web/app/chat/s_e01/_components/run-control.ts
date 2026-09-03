/**
 * GAP-189: 実行の制御クライアント — 中断 / 実行中の追い足し / 繋ぎ直し。
 *
 * 経営者指摘:
 *   「中断とか入ってないけど、これ Claude だとできるけど」
 *   「止まっても裏のターミナルは変わらないんでしょ？ だったら続けてとかで
 *     自動で後ろは繋がるよね？」
 *
 * 3 つとも「取りこぼさない」ことが要点:
 *   - 停止は PC 上の claude まで実際に止まる (クラウドの状態だけ落とさない)
 *   - 実行中に送った指示は受領時点で保存され、次の実行で必ず消費される
 *   - 画面を閉じても走っている実行に繋ぎ直せる (答えはサーバーが保存済み)
 *
 * baseURL / token / fetch は注入可能 (テスト容易性 — 既存 stream.ts と同方針)。
 */

import { API_BASE, ensureAccessToken } from "../../../../lib/auth/connector";

import type { ChatStreamChunk, ChatToolsMode } from "./stream";

export interface RunControlOpts {
  readonly baseURL?: string;
  readonly token?: string | null;
  readonly fetchImpl?: typeof fetch;
}

async function ctx(opts: RunControlOpts): Promise<{
  baseURL: string;
  headers: Record<string, string>;
  doFetch: typeof fetch;
}> {
  const baseURL = opts.baseURL ?? API_BASE;
  const token = opts.token !== undefined ? opts.token : await ensureAccessToken();
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (token) headers.Authorization = `Bearer ${token}`;
  return { baseURL, headers, doFetch: opts.fetchImpl ?? globalThis.fetch };
}

/** 今このスレッドで走っている実行 (無ければ null)。 */
export interface ActiveRun {
  readonly job_id: string;
  readonly status: string;
  readonly tools_mode?: string | null;
  readonly started_at?: string | null;
}

export async function fetchActiveRun(
  threadId: string,
  opts: RunControlOpts = {},
): Promise<ActiveRun | null> {
  const { baseURL, headers, doFetch } = await ctx(opts);
  const res = await doFetch(`${baseURL}/chat/threads/${threadId}/run`, {
    headers,
    credentials: "include",
  });
  if (!res.ok) throw new Error(`active run failed: ${res.status}`);
  const body = (await res.json()) as { data?: Partial<ActiveRun> | null };
  const job = body.data?.job_id;
  if (!job) return null;
  return {
    job_id: job,
    status: body.data?.status ?? "running",
    tools_mode: body.data?.tools_mode ?? null,
    started_at: body.data?.started_at ?? null,
  };
}

/** 中断の結果。message はそのまま画面に出せる日本語。 */
export interface CancelRunResult {
  readonly status: "cancelled" | "already_finished";
  readonly message: string;
  readonly saved_chars: number;
}

/**
 * 走っている実行を止める。**PC 上の claude も実際に止まる**。
 * そこまでに出ていた本文はスレッドに残る (捨てない)。
 */
export async function cancelRun(
  jobId: string,
  opts: RunControlOpts = {},
): Promise<CancelRunResult> {
  const { baseURL, headers, doFetch } = await ctx(opts);
  const res = await doFetch(`${baseURL}/chat/runs/${jobId}/cancel`, {
    method: "POST",
    headers,
    credentials: "include",
  });
  if (!res.ok) throw new Error(`cancel failed: ${res.status}`);
  const body = (await res.json()) as { data?: Partial<CancelRunResult> };
  return {
    status: body.data?.status === "already_finished" ? "already_finished" : "cancelled",
    message: body.data?.message ?? "実行を止めました。",
    saved_chars: body.data?.saved_chars ?? 0,
  };
}

/** 待ちの追い足し指示 1 件。 */
export interface QueuedMessage {
  readonly id: string;
  readonly content: string;
  readonly tools_mode: ChatToolsMode;
}

function toQueued(raw: unknown): QueuedMessage | null {
  if (typeof raw !== "object" || raw === null) return null;
  const r = raw as { id?: unknown; content?: unknown; tools_mode?: unknown };
  if (typeof r.id !== "string" || typeof r.content !== "string") return null;
  const mode = r.tools_mode;
  return {
    id: r.id,
    content: r.content,
    tools_mode:
      mode === "approve" || mode === "auto" ? (mode as ChatToolsMode) : "off",
  };
}

/**
 * 実行中に送られた指示を積む。**受け取った瞬間にサーバーが保存する**ので、
 * この後ブラウザが落ちても指示は消えない。
 */
export async function queueMessage(
  threadId: string,
  content: string,
  toolsMode: ChatToolsMode = "off",
  opts: RunControlOpts = {},
): Promise<QueuedMessage> {
  const { baseURL, headers, doFetch } = await ctx(opts);
  const res = await doFetch(`${baseURL}/chat/threads/${threadId}/queued`, {
    method: "POST",
    headers,
    credentials: "include",
    body: JSON.stringify({ content, tools_mode: toolsMode }),
  });
  if (!res.ok) throw new Error(`queue failed: ${res.status}`);
  const body = (await res.json()) as { data?: unknown };
  const item = toQueued(body.data);
  if (item === null) throw new Error("unexpected queue response");
  return item;
}

/** まだ流していない指示 (古い順)。画面を開き直しても残っている。 */
export async function listQueued(
  threadId: string,
  opts: RunControlOpts = {},
): Promise<readonly QueuedMessage[]> {
  const { baseURL, headers, doFetch } = await ctx(opts);
  const res = await doFetch(`${baseURL}/chat/threads/${threadId}/queued`, {
    headers,
    credentials: "include",
  });
  if (!res.ok) throw new Error(`queued list failed: ${res.status}`);
  const body = (await res.json()) as { data?: readonly unknown[] };
  return (body.data ?? []).map(toQueued).filter((x): x is QueuedMessage => x !== null);
}

/** 待ちの先頭を 1 件取り出す (無ければ null)。二重消費はサーバー側で防ぐ。 */
export async function consumeQueued(
  threadId: string,
  opts: RunControlOpts = {},
): Promise<QueuedMessage | null> {
  const { baseURL, headers, doFetch } = await ctx(opts);
  const res = await doFetch(`${baseURL}/chat/threads/${threadId}/queued/consume`, {
    method: "POST",
    headers,
    credentials: "include",
  });
  if (!res.ok) throw new Error(`queued consume failed: ${res.status}`);
  const body = (await res.json()) as { data?: unknown };
  return toQueued(body.data);
}

/** 待ちの指示を取り消す (流す前に気が変わったとき)。 */
export async function dropQueued(
  threadId: string,
  queuedId: string,
  opts: RunControlOpts = {},
): Promise<void> {
  const { baseURL, headers, doFetch } = await ctx(opts);
  const res = await doFetch(
    `${baseURL}/chat/threads/${threadId}/queued/${queuedId}`,
    { method: "DELETE", headers, credentials: "include" },
  );
  if (!res.ok && res.status !== 404) {
    throw new Error(`queued delete failed: ${res.status}`);
  }
}

function parseChunk(raw: string): ChatStreamChunk | null {
  const dataLines = raw
    .split("\n")
    .filter((l) => l.startsWith("data:"))
    .map((l) => l.slice(5).trim());
  if (dataLines.length === 0) return null;
  const payload = dataLines.join("");
  if (!payload || payload === "[DONE]") return null;
  try {
    const obj = JSON.parse(payload) as ChatStreamChunk;
    return obj.type ? obj : null;
  } catch {
    return null;
  }
}

export interface AttachRunArgs extends RunControlOpts {
  readonly jobId: string;
  readonly signal?: AbortSignal;
  readonly onChunk: (chunk: ChatStreamChunk) => void;
}

/**
 * 走っている実行に繋ぎ直す。DB に溜まった分を先頭から流し直すので、
 * 画面を閉じている間に出ていた内容も見える。イベント形は通常の
 * チャットストリームと同じ (同じ描画ロジックで読める)。
 */
export async function attachRun(args: AttachRunArgs): Promise<void> {
  const { baseURL, headers, doFetch } = await ctx(args);
  const res = await doFetch(`${baseURL}/chat/runs/${args.jobId}/attach`, {
    headers: { ...headers, Accept: "text/event-stream" },
    credentials: "include",
    signal: args.signal,
  });
  if (!res.ok || !res.body) throw new Error(`attach failed: HTTP ${res.status}`);

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const events = buffer.split("\n\n");
    buffer = events.pop() ?? "";
    for (const ev of events) {
      const chunk = parseChunk(ev);
      if (chunk) args.onChunk(chunk);
    }
  }
  const tail = parseChunk(buffer);
  if (tail) args.onChunk(tail);
}
