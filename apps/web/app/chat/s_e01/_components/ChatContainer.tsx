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
import { useCallback, useEffect, useState } from "react";

import { Brain } from "lucide-react";

import { Toast } from "../../../../components/ui/toast";
import { ChatPanel, type ChatMessage } from "./ChatPanel";
import {
  fetchThreadMessages,
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

  // バグ #23 対応: 既存スレッドの履歴をマウント時にロードする
  // (これが無いとリロードで会話が消え、cron ダイジェスト等の既存メッセージが不可視)。
  useEffect(() => {
    let cancelled = false;
    fetchThreadMessages(threadId)
      .then((history) => {
        if (cancelled || history.length === 0) return;
        // 履歴は先頭に置く。stream 中 (送信中) の楽観行は維持する。
        setMessages((prev) => {
          const existing = new Set(prev.map((m) => m.id));
          const fresh = history.filter((m) => !existing.has(m.id));
          return [...fresh, ...prev];
        });
      })
      .catch(() => {
        if (!cancelled) {
          setError("過去のメッセージの取得に失敗しました。");
        }
      });
    return () => {
      cancelled = true;
    };
  }, [threadId]);

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
          className="inline-flex w-fit items-center gap-2 rounded-full bg-tertiary-container px-3 py-1 text-[11.5px] font-semibold text-on-tertiary-container"
          aria-label="F-CTX01 文脈サマリ"
        >
          <Brain size={12} aria-hidden="true" />
          <span>F-CTX01 コンテキスト構築</span>
          <span aria-hidden="true" className="opacity-60">
            ·
          </span>
          <span>
            参照履歴{" "}
            <strong className="tabular-nums">{context.historyCount}</strong> 件
          </span>
          <span aria-hidden="true" className="opacity-60">
            ·
          </span>
          <span>
            ナレッジ参照{" "}
            <strong className="tabular-nums">{context.ragHitCount}</strong> 件
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
