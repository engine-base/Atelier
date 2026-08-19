/**
 * S-H01 モック修正依頼の SSE クライアント (GAP-147)
 *
 * POST /mocks/{mockId}/revise/stream を読み、進行状況 (stage / progress) と
 * 結果 (result / error) を逐次 onEvent へ流す。「ワンダが今なにをしているか」を
 * 実測で見せるための配線 — chat の stream.ts と同じ作法。
 * baseURL / token / fetch は注入可能 (テスト容易性)。
 */

import { API_BASE, readAccessToken } from "../../../../lib/auth/connector";

export interface ReviseResultMock {
  readonly id: string;
  readonly version: number;
  readonly summary?: string;
}

export interface ReviseStreamEvent {
  readonly stage?: "loading" | "generating" | "saving";
  readonly provider?: string;
  readonly progress?: { readonly chars: number };
  readonly result?: ReviseResultMock & Record<string, unknown>;
  readonly error?: { readonly code: string; readonly message: string };
}

export interface StreamReviseArgs {
  readonly mockId: string;
  readonly instruction: string;
  /** GAP-161: ワンダに参考にさせる資料 (先に /reference-uploads で上げたもの)。 */
  readonly referenceFiles?: readonly {
    readonly storage_path: string;
    readonly file_name: string;
    readonly mime_type: string;
  }[];
  readonly onEvent: (ev: ReviseStreamEvent) => void;
  readonly signal?: AbortSignal;
  readonly baseURL?: string;
  readonly token?: string | null;
  readonly fetchImpl?: typeof fetch;
}

function parseEvent(raw: string): ReviseStreamEvent | null {
  const dataLines = raw
    .split("\n")
    .filter((l) => l.startsWith("data:"))
    .map((l) => l.slice(5).trim());
  if (dataLines.length === 0) return null;
  const payload = dataLines.join("");
  if (!payload) return null;
  try {
    return JSON.parse(payload) as ReviseStreamEvent;
  } catch {
    return null;
  }
}

/** SSE を読み切る。HTTP エラーは throw (呼び出し側で honest 表示)。 */
export async function streamReviseMock(args: StreamReviseArgs): Promise<void> {
  const baseURL = args.baseURL ?? API_BASE;
  const token = args.token !== undefined ? args.token : readAccessToken();
  const doFetch = args.fetchImpl ?? globalThis.fetch;

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Accept: "text/event-stream",
  };
  if (token) headers.Authorization = `Bearer ${token}`;

  const res = await doFetch(`${baseURL}/mocks/${args.mockId}/revise/stream`, {
    method: "POST",
    headers,
    credentials: "include",
    signal: args.signal,
    body: JSON.stringify({
      instruction: args.instruction,
      // GAP-161: ワンダに参考にさせる資料 (画像/PDF/Excel 等)
      reference_files: args.referenceFiles ?? [],
    }),
  });
  if (!res.ok || !res.body) {
    throw new Error(`revise stream failed: HTTP ${res.status}`);
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
