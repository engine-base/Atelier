/**
 * S-E01 チャット SSE クライアント (T-UC-08 / T-A-18・F-CTX01)
 *
 * POST /chat/threads/{threadId}/stream に user_message を送り、
 * text/event-stream の各 `data: {ChatStreamChunk}` を逐次 onChunk へ流す。
 * baseURL / token / fetch は注入可能 (テスト容易性)。
 */

import { API_BASE, readAccessToken } from "../../../../lib/auth/connector";

export type ChatChunkType = "start" | "delta" | "end" | "error" | "context";

export interface ChatStreamChunk {
  readonly type: ChatChunkType;
  readonly content?: string | null;
  readonly metadata?: Record<string, unknown> | null;
}

/** 添付メタ (GAP-001 — upload-url → PUT 済のものを送信 body に含める)。 */
export interface ChatAttachmentMeta {
  readonly file_name: string;
  readonly mime_type: string;
  readonly file_size_bytes: number;
  readonly storage_path: string;
}

export interface StreamChatArgs {
  readonly threadId: string;
  readonly userMessage: string;
  readonly ragAccountId?: string;
  readonly includeHistory?: number;
  readonly useKnowledgeRag?: boolean;
  readonly attachments?: readonly ChatAttachmentMeta[];
  readonly signal?: AbortSignal;
  readonly onChunk: (chunk: ChatStreamChunk) => void;
  /** 注入用 (省略時は connector の API_BASE / cookie token / global fetch)。 */
  readonly baseURL?: string;
  readonly token?: string | null;
  readonly fetchImpl?: typeof fetch;
}

function parseChunk(raw: string): ChatStreamChunk | null {
  // SSE 1 イベント (複数行) から `data:` 行のみ連結して JSON parse する。
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

/** SSE ストリームを読み、各 ChatStreamChunk を onChunk に渡す。end / 終端で解決。 */
export async function streamChatThread(args: StreamChatArgs): Promise<void> {
  const baseURL = args.baseURL ?? API_BASE;
  const token = args.token !== undefined ? args.token : readAccessToken();
  const doFetch = args.fetchImpl ?? globalThis.fetch;

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Accept: "text/event-stream",
  };
  if (token) headers.Authorization = `Bearer ${token}`;

  const res = await doFetch(`${baseURL}/chat/threads/${args.threadId}/stream`, {
    method: "POST",
    headers,
    credentials: "include",
    signal: args.signal,
    body: JSON.stringify({
      user_message: args.userMessage,
      use_knowledge_rag: args.useKnowledgeRag ?? true,
      include_history: args.includeHistory ?? 10,
      ...(args.ragAccountId ? { rag_account_id: args.ragAccountId } : {}),
      ...(args.attachments?.length ? { attachments: args.attachments } : {}),
    }),
  });

  if (!res.ok || !res.body) {
    throw new Error(`chat stream failed: HTTP ${res.status}`);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    // イベント境界は空行 (\n\n)。残りは次チャンクへ持ち越す。
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

export type ThreadMessageRole = "user" | "assistant" | "system" | "tool";

export interface ThreadMessage {
  readonly id: string;
  readonly role: ThreadMessageRole;
  readonly content: string;
  readonly created_at?: string;
  readonly attachments?: readonly ChatAttachmentMeta[];
}

const KNOWN_ROLES: ReadonlySet<string> = new Set([
  "user",
  "assistant",
  "system",
  "tool",
]);

/**
 * 既存スレッドの過去メッセージを取得する (バグ #23 対応)。
 * tool / system メッセージも返す (モックのツールカード描画用)。
 * 失敗時は throw — 呼び出し側でエラー表示する。
 */
export async function fetchThreadMessages(
  threadId: string,
  opts: { baseURL?: string; token?: string | null; fetchImpl?: typeof fetch } = {},
): Promise<readonly ThreadMessage[]> {
  const baseURL = opts.baseURL ?? API_BASE;
  const token = opts.token !== undefined ? opts.token : readAccessToken();
  const doFetch = opts.fetchImpl ?? globalThis.fetch;
  const headers: Record<string, string> = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await doFetch(`${baseURL}/chat/threads/${threadId}/messages`, {
    headers,
    credentials: "include",
  });
  if (!res.ok) {
    throw new Error(`messages fetch failed: ${res.status}`);
  }
  const json = (await res.json()) as {
    data: readonly {
      id: string;
      role: string;
      content: string;
      created_at?: string;
      attachments?: readonly ChatAttachmentMeta[];
    }[];
  };
  return json.data
    .filter((m) => KNOWN_ROLES.has(m.role))
    .map((m) => ({
      id: m.id,
      role: m.role as ThreadMessageRole,
      content: m.content,
      created_at: m.created_at,
      ...(m.attachments?.length ? { attachments: m.attachments } : {}),
    }));
}

/**
 * GAP-001: チャット添付の署名付きアップロード URL 発行 → 実 PUT の 2 段階。
 * 戻り値は送信 body の attachments に含めるメタ。
 */
export async function uploadChatAttachment(
  threadId: string,
  file: File,
  opts: { baseURL?: string; token?: string | null; fetchImpl?: typeof fetch } = {},
): Promise<ChatAttachmentMeta> {
  const baseURL = opts.baseURL ?? API_BASE;
  const token = opts.token !== undefined ? opts.token : readAccessToken();
  const doFetch = opts.fetchImpl ?? globalThis.fetch;
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await doFetch(`${baseURL}/chat/attachments/upload-url`, {
    method: "POST",
    headers,
    credentials: "include",
    body: JSON.stringify({
      thread_id: threadId,
      file_name: file.name,
      mime_type: file.type,
      file_size_bytes: file.size,
    }),
  });
  if (!res.ok) {
    throw new Error(`attachment upload-url failed: ${res.status}`);
  }
  const json = (await res.json()) as {
    data?: { upload_url?: string; storage_path?: string };
  };
  const uploadUrl = json.data?.upload_url;
  const storagePath = json.data?.storage_path;
  if (!uploadUrl || !storagePath) throw new Error("unexpected upload-url response");
  const put = await doFetch(uploadUrl, {
    method: "PUT",
    headers: { "Content-Type": file.type },
    body: file,
  });
  if (!put.ok) {
    throw new Error(`attachment PUT failed: ${put.status}`);
  }
  return {
    file_name: file.name,
    mime_type: file.type,
    file_size_bytes: file.size,
    storage_path: storagePath,
  };
}

/** GAP-001: 添付の署名付きダウンロード URL を解決する。 */
export async function fetchChatAttachmentUrl(
  messageId: string,
  index: number,
  opts: { baseURL?: string; token?: string | null; fetchImpl?: typeof fetch } = {},
): Promise<string> {
  const baseURL = opts.baseURL ?? API_BASE;
  const token = opts.token !== undefined ? opts.token : readAccessToken();
  const doFetch = opts.fetchImpl ?? globalThis.fetch;
  const headers: Record<string, string> = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await doFetch(
    `${baseURL}/chat/messages/${messageId}/attachments/${index}/url`,
    { headers, credentials: "include" },
  );
  if (!res.ok) {
    throw new Error(`attachment url failed: ${res.status}`);
  }
  const json = (await res.json()) as { data?: { url?: string } };
  const url = json.data?.url;
  if (!url) throw new Error("unexpected attachment url response");
  return url;
}

/**
 * メッセージへのフィードバック (T-A-19: POST /chat/messages/{id}/feedback)。
 * audit_logs に記録される。失敗時は throw — 呼び出し側で通知する。
 */
export async function postMessageFeedback(
  messageId: string,
  value: "up" | "down",
  opts: { baseURL?: string; token?: string | null; fetchImpl?: typeof fetch } = {},
): Promise<void> {
  const baseURL = opts.baseURL ?? API_BASE;
  const token = opts.token !== undefined ? opts.token : readAccessToken();
  const doFetch = opts.fetchImpl ?? globalThis.fetch;
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await doFetch(`${baseURL}/chat/messages/${messageId}/feedback`, {
    method: "POST",
    headers,
    credentials: "include",
    body: JSON.stringify({ value }),
  });
  if (!res.ok) {
    throw new Error(`feedback failed: ${res.status}`);
  }
}

/**
 * GAP-031①: メッセージ時点で新スレッドへ分岐 (POST /chat/messages/{id}/branch)。
 * 分岐先スレッド ID を返す。
 */
export async function branchThreadAtMessage(
  messageId: string,
  opts: { baseURL?: string; token?: string | null; fetchImpl?: typeof fetch } = {},
): Promise<string> {
  const baseURL = opts.baseURL ?? API_BASE;
  const token = opts.token !== undefined ? opts.token : readAccessToken();
  const doFetch = opts.fetchImpl ?? globalThis.fetch;
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await doFetch(`${baseURL}/chat/messages/${messageId}/branch`, {
    method: "POST",
    headers,
    credentials: "include",
  });
  if (!res.ok) {
    throw new Error(`branch failed: ${res.status}`);
  }
  const body = (await res.json()) as { data?: { id?: string } };
  const id = body.data?.id;
  if (!id) throw new Error("branch response missing thread id");
  return id;
}

/** ツール実行の承認待ち 1 件 (GAP-031①)。 */
export interface ToolApproval {
  readonly id: string;
  readonly status: string;
  readonly title: string;
  readonly tool: string;
  readonly tool_input: Record<string, unknown>;
  readonly created_at: string;
  readonly resolution_note?: string | null;
}

/** スレッドの pending ツール承認一覧 (GET /chat/tool-approvals)。 */
export async function fetchToolApprovals(
  threadId: string,
  opts: { baseURL?: string; token?: string | null; fetchImpl?: typeof fetch } = {},
): Promise<ToolApproval[]> {
  const baseURL = opts.baseURL ?? API_BASE;
  const token = opts.token !== undefined ? opts.token : readAccessToken();
  const doFetch = opts.fetchImpl ?? globalThis.fetch;
  const headers: Record<string, string> = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await doFetch(
    `${baseURL}/chat/tool-approvals?thread_id=${encodeURIComponent(threadId)}&status=pending`,
    { headers, credentials: "include" },
  );
  if (!res.ok) throw new Error(`tool approvals failed: ${res.status}`);
  const body = (await res.json()) as { data?: ToolApproval[] };
  return body.data ?? [];
}

/** 承認して実行 (POST /chat/tool-approvals/{id}/execute)。実行結果文字列を返す。 */
export async function executeToolApproval(
  approvalId: string,
  opts: { baseURL?: string; token?: string | null; fetchImpl?: typeof fetch } = {},
): Promise<string> {
  const baseURL = opts.baseURL ?? API_BASE;
  const token = opts.token !== undefined ? opts.token : readAccessToken();
  const doFetch = opts.fetchImpl ?? globalThis.fetch;
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await doFetch(`${baseURL}/chat/tool-approvals/${approvalId}/execute`, {
    method: "POST",
    headers,
    credentials: "include",
  });
  if (!res.ok) throw new Error(`tool execute failed: ${res.status}`);
  const body = (await res.json()) as { data?: { result?: string } };
  return body.data?.result ?? "";
}

/** 差戻 (POST /chat/tool-approvals/{id}/reject)。 */
export async function rejectToolApproval(
  approvalId: string,
  opts: { baseURL?: string; token?: string | null; fetchImpl?: typeof fetch } = {},
): Promise<void> {
  const baseURL = opts.baseURL ?? API_BASE;
  const token = opts.token !== undefined ? opts.token : readAccessToken();
  const doFetch = opts.fetchImpl ?? globalThis.fetch;
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await doFetch(`${baseURL}/chat/tool-approvals/${approvalId}/reject`, {
    method: "POST",
    headers,
    credentials: "include",
  });
  if (!res.ok) throw new Error(`tool reject failed: ${res.status}`);
}
