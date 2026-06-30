/**
 * S-I03 実行ログ SSE クライアント (T-UC-16 / 実 exec-logs)
 *
 * GET /executions/{id}/logs/stream の text/event-stream を逐次読み、各 `data: {ExecLogEvent}`
 * を onEvent に流す。baseURL / token / fetch は注入可能 (テスト容易性)。
 */

import { API_BASE, readAccessToken } from "../../../../lib/auth/connector";

export type ExecLogEventType = "snapshot" | "status_change" | "end" | "error";

export interface ExecLogEvent {
  readonly type: ExecLogEventType;
  readonly execution_id?: string;
  readonly status?: string | null;
  readonly error_summary?: string | null;
  readonly timestamp?: string;
}

export interface StreamExecLogsArgs {
  readonly executionId: string;
  readonly signal?: AbortSignal;
  readonly onEvent: (event: ExecLogEvent) => void;
  readonly baseURL?: string;
  readonly token?: string | null;
  readonly fetchImpl?: typeof fetch;
}

function parseEvent(raw: string): ExecLogEvent | null {
  const dataLines = raw
    .split("\n")
    .filter((l) => l.startsWith("data:"))
    .map((l) => l.slice(5).trim());
  if (dataLines.length === 0) return null;
  const payload = dataLines.join("");
  if (!payload || payload === "[DONE]") return null;
  try {
    const obj = JSON.parse(payload) as ExecLogEvent;
    return obj.type ? obj : null;
  } catch {
    return null;
  }
}

/** 実行ログ SSE を読み、各 ExecLogEvent を onEvent に渡す。終端で解決。 */
export async function streamExecLogs(args: StreamExecLogsArgs): Promise<void> {
  const baseURL = args.baseURL ?? API_BASE;
  const token = args.token !== undefined ? args.token : readAccessToken();
  const doFetch = args.fetchImpl ?? globalThis.fetch;

  const headers: Record<string, string> = { Accept: "text/event-stream" };
  if (token) headers.Authorization = `Bearer ${token}`;

  const res = await doFetch(
    `${baseURL}/executions/${args.executionId}/logs/stream`,
    {
      method: "GET",
      headers,
      credentials: "include",
      signal: args.signal,
    },
  );

  if (!res.ok || !res.body) {
    throw new Error(`exec log stream failed: HTTP ${res.status}`);
  }

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
      const parsed = parseEvent(ev);
      if (parsed) args.onEvent(parsed);
    }
  }
  const tail = parseEvent(buffer);
  if (tail) args.onEvent(tail);
}
