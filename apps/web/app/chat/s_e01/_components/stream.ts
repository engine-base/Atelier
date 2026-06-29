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

export interface StreamChatArgs {
  readonly threadId: string;
  readonly userMessage: string;
  readonly ragAccountId?: string;
  readonly includeHistory?: number;
  readonly useKnowledgeRag?: boolean;
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
