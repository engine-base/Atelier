/**
 * S-E01 チャットコンテナ — T-UC-08 (SSE + F-CTX01 配線)
 *
 * ChatPanel(presentational) を実 SSE に配線する。送信時にユーザ発話を楽観追加し、
 * POST /chat/threads/{threadId}/stream の delta を assistant メッセージに逐次反映する。
 * 'context' chunk で F-CTX01 文脈サマリ (履歴件数 / RAG hit 数) を表示し、'error' chunk や
 * 例外では inline error + toast を出す。
 *
 * threadId は親 (スレッド選択) から prop で受ける。streamFn は注入可能 (テスト用)。
 */

"use client";

import * as React from "react";
import { useCallback, useState } from "react";

import { Toast } from "../../../../components/ui/toast";
import { ChatPanel, type ChatMessage } from "./ChatPanel";
import {
  streamChatThread,
  type ChatStreamChunk,
  type StreamChatArgs,
} from "./stream";

type StreamFn = (args: StreamChatArgs) => Promise<void>;

export interface ChatContextSummary {
  readonly historyCount: number;
  readonly ragHitCount: number;
}

export interface ChatContainerProps {
  readonly threadId: string;
  readonly ragAccountId?: string;
  /** 注入用 (省略時は実 SSE)。 */
  readonly streamFn?: StreamFn;
  readonly initialMessages?: readonly ChatMessage[];
}

let _seq = 0;
function nextId(prefix: string): string {
  _seq += 1;
  return `${prefix}-${_seq}`;
}

function readContextSummary(
  meta: Record<string, unknown> | null | undefined,
): ChatContextSummary {
  const historyCount =
    typeof meta?.history_count === "number" ? meta.history_count : 0;
  const hits = meta?.rag_hit_ids;
  const ragHitCount = Array.isArray(hits) ? hits.length : 0;
  return { historyCount, ragHitCount };
}

export function ChatContainer({
  threadId,
  ragAccountId,
  streamFn = streamChatThread,
  initialMessages = [],
}: ChatContainerProps) {
  const [messages, setMessages] =
    useState<readonly ChatMessage[]>(initialMessages);
  const [sending, setSending] = useState(false);
  const [context, setContext] = useState<ChatContextSummary | null>(null);
  const [error, setError] = useState<string | null>(null);

  const handleSend = useCallback(
    async (text: string) => {
      const userMsg: ChatMessage = {
        id: nextId("u"),
        role: "user",
        content: text,
      };
      const assistantId = nextId("a");
      setMessages((prev) => [
        ...prev,
        userMsg,
        { id: assistantId, role: "assistant", content: "" },
      ]);
      setSending(true);
      setError(null);

      const onChunk = (chunk: ChatStreamChunk): void => {
        if (chunk.type === "context") {
          setContext(readContextSummary(chunk.metadata));
        } else if (chunk.type === "delta" && chunk.content) {
          const piece = chunk.content;
          setMessages((prev) =>
            prev.map((m) =>
              m.id === assistantId ? { ...m, content: m.content + piece } : m,
            ),
          );
        } else if (chunk.type === "error") {
          setError(chunk.content ?? "ストリーミング中にエラーが発生しました");
        }
      };

      try {
        await streamFn({ threadId, userMessage: text, ragAccountId, onChunk });
      } catch {
        setError(
          "AI 応答の取得に失敗しました。時間をおいて再試行してください。",
        );
        // 失敗した空の assistant placeholder は取り除く。
        setMessages((prev) =>
          prev.filter((m) => !(m.id === assistantId && m.content === "")),
        );
      } finally {
        setSending(false);
      }
    },
    [threadId, ragAccountId, streamFn],
  );

  return (
    <div className="flex h-full flex-col gap-sm">
      {context ? (
        <div
          className="flex items-center gap-md rounded-md border border-surface-variant bg-surface px-md py-xs text-label-sm text-on-surface-variant"
          aria-label="F-CTX01 文脈サマリ"
        >
          <span>
            参照履歴{" "}
            <strong className="text-on-surface tabular-nums">
              {context.historyCount}
            </strong>{" "}
            件
          </span>
          <span>
            ナレッジ参照{" "}
            <strong className="text-on-surface tabular-nums">
              {context.ragHitCount}
            </strong>{" "}
            件
          </span>
        </div>
      ) : null}

      <div className="min-h-0 flex-1">
        <ChatPanel
          messages={messages}
          onSend={(t) => void handleSend(t)}
          disabled={sending}
        />
      </div>

      {error ? (
        <p role="alert" className="text-body-sm text-error">
          {error}
        </p>
      ) : null}

      {error ? (
        <Toast
          id="chat-error"
          tone="error"
          message={error}
          onClose={() => setError(null)}
        />
      ) : null}
    </div>
  );
}
