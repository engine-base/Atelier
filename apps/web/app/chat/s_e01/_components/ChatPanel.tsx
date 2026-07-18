/**
 * S-E01 チャットパネル — T-UC-08 (assistant-ui + SSE + tool-ui)
 *
 * モック 06_mockups/chat/S-E01-thread.html の中央チャットペイン (メッセージスレッド +
 * コンポーザ) に忠実な presentational:
 *   - user: 右寄せ primary バブル + 「あなた + 時刻」メタ
 *   - assistant: AI 社員アバター + 名前 + 時刻 + 本文
 *   - tool: モックの .tool-card (monospace ツール名 + 本文)
 *   - composer: 「<社員名>にメッセージ…」placeholder / Enter 送信 / Shift+Enter 改行
 * データ配線・props・a11y 契約 (log role / aria-live / メッセージを入力 label) は不変。
 */

"use client";

import * as React from "react";
import { useEffect, useRef, useState } from "react";
import {
  AtSign,
  Brain,
  Paperclip,
  SendHorizontal,
  ShieldCheck,
  Terminal,
  Zap,
} from "lucide-react";

import { fmtTime } from "../../../../lib/format";

export type ChatRole = "user" | "assistant" | "system" | "tool";

export interface ChatMessage {
  readonly id: string;
  readonly role: ChatRole;
  readonly content: string;
  readonly created_at?: string;
}

export interface ChatEmployeeInfo {
  readonly name: string;
  readonly color: string;
}

export interface ChatPanelProps {
  readonly messages: readonly ChatMessage[];
  readonly onSend: (text: string) => void;
  readonly disabled?: boolean;
  /** 対話相手の AI 社員 (アバター/名前/placeholder 用)。 */
  readonly employee?: ChatEmployeeInfo;
}

/** tool メッセージの content からツール名を推定する (JSON {tool|name} or 先頭行)。 */
function toolNameOf(content: string): string {
  try {
    const obj = JSON.parse(content) as { tool?: string; name?: string };
    if (typeof obj.tool === "string") return obj.tool;
    if (typeof obj.name === "string") return obj.name;
  } catch {
    /* content はプレーンテキスト */
  }
  const firstLine = content.split("\n")[0] ?? "";
  return firstLine.length > 0 && firstLine.length <= 40 ? firstLine : "tool";
}

function MessageRow({
  message,
  employee,
}: {
  readonly message: ChatMessage;
  readonly employee?: ChatEmployeeInfo;
}) {
  const time = fmtTime(message.created_at);

  if (message.role === "user") {
    return (
      <li className="ml-auto flex w-full max-w-[760px] flex-col items-end">
        <div className="mb-1 flex items-center gap-2 pr-1 text-on-surface-variant">
          <span className="text-[12.5px] font-bold">あなた</span>
          {time ? <span className="text-[11px] tabular-nums">{time}</span> : null}
        </div>
        <div className="max-w-[580px] whitespace-pre-wrap rounded-lg rounded-br-sm bg-primary px-4 py-3 text-[14px] leading-relaxed text-on-primary">
          {message.content}
        </div>
      </li>
    );
  }

  if (message.role === "system") {
    return (
      <li className="mx-auto max-w-[580px] rounded-md bg-secondary-container px-md py-sm text-center text-label-md text-on-secondary-container">
        {message.content}
      </li>
    );
  }

  if (message.role === "tool") {
    return (
      <li className="flex w-full max-w-[760px] gap-3 pl-11">
        <div className="min-w-0 flex-1 overflow-hidden rounded-md border border-border bg-white">
          <div className="flex items-center gap-2 border-b border-border bg-surface-variant px-3 py-2 text-[11.5px] font-semibold">
            <span className="flex h-[22px] w-[22px] items-center justify-center rounded-sm bg-primary-container text-on-primary-container">
              <Terminal size={12} aria-hidden="true" />
            </span>
            <span className="font-mono text-[11.5px] text-primary">
              {toolNameOf(message.content)}
            </span>
            {time ? (
              <span className="ml-auto text-[10.5px] tabular-nums text-on-surface-variant">
                {time}
              </span>
            ) : null}
          </div>
          <div className="max-h-[220px] overflow-auto px-[14px] py-3">
            <pre className="whitespace-pre-wrap font-mono text-[11.5px] leading-[1.65] text-on-surface">
              {message.content}
            </pre>
          </div>
        </div>
      </li>
    );
  }

  const name = employee?.name ?? "AI 社員";
  return (
    <li className="flex w-full max-w-[760px] gap-3">
      <span
        aria-hidden="true"
        className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-[13px] font-bold text-white"
        style={{ backgroundColor: employee?.color ?? "#2563EB" }}
      >
        {name.charAt(0)}
      </span>
      <div className="min-w-0 flex-1">
        <div className="mb-1 flex items-center gap-2">
          <span className="text-[12.5px] font-bold text-on-surface">{name}</span>
          {time ? (
            <span className="text-[11px] tabular-nums text-on-surface-variant">
              {time}
            </span>
          ) : null}
        </div>
        <div className="whitespace-pre-wrap text-[14px] leading-[1.75] text-on-surface">
          {message.content}
        </div>
      </div>
    </li>
  );
}

const TOOL_BUTTONS: readonly {
  readonly icon: React.ReactNode;
  readonly label: string;
}[] = [
  { icon: <Paperclip size={12} aria-hidden="true" />, label: "添付" },
  { icon: <AtSign size={12} aria-hidden="true" />, label: "@メンション" },
  { icon: <Brain size={12} aria-hidden="true" />, label: "ナレッジ参照" },
  { icon: <Zap size={12} aria-hidden="true" />, label: "/コマンド" },
];

export function ChatPanel({ messages, onSend, disabled, employee }: ChatPanelProps) {
  const [input, setInput] = useState("");
  const viewportRef = useRef<HTMLUListElement>(null);

  // 新着で最下部へ自動スクロール
  useEffect(() => {
    const el = viewportRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages.length]);

  const submit = () => {
    const v = input.trim();
    if (!v) return;
    onSend(v);
    setInput("");
  };

  const placeholder = employee
    ? `${employee.name}にメッセージ… · @ で他のAI社員をメンション · / でコマンド呼出`
    : "AI 社員にメッセージ… · @ でメンション · / でコマンド呼出";

  return (
    <section aria-label="チャット" className="flex h-full min-h-0 flex-col">
      <ul
        ref={viewportRef}
        role="log"
        aria-live="polite"
        className="flex min-h-0 flex-1 flex-col gap-[18px] overflow-y-auto px-md py-5 sm:px-[32px]"
      >
        {messages.map((m) => (
          <MessageRow key={m.id} message={m} employee={employee} />
        ))}
      </ul>

      <form
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
        className="shrink-0 border-t border-border bg-surface px-md pb-4 pt-3 sm:px-[24px]"
      >
        <div className="rounded-lg border border-border bg-white px-[14px] py-3 transition-all focus-within:border-primary focus-within:shadow-[0_0_0_3px_#DBEAFE]">
          <label htmlFor="chat-input" className="sr-only">
            メッセージを入力
          </label>
          <textarea
            id="chat-input"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              // モック準拠: Enter で送信 / Shift+Enter で改行 (IME 変換中は送信しない)
              if (
                e.key === "Enter" &&
                !e.shiftKey &&
                !e.nativeEvent.isComposing
              ) {
                e.preventDefault();
                submit();
              }
            }}
            disabled={disabled}
            rows={2}
            placeholder={placeholder}
            className="max-h-[200px] min-h-[44px] w-full resize-none border-0 bg-transparent text-[14px] leading-relaxed text-on-surface outline-none placeholder:text-on-surface-variant"
          />
          <div className="mt-2 flex items-center gap-1 border-t border-border pt-2">
            {/* 添付/@メンション/ナレッジ参照/コマンドは対応API未提供のため非活性(機能を偽らない)。 */}
            {TOOL_BUTTONS.map((t) => (
              <button
                key={t.label}
                type="button"
                disabled
                title="準備中です"
                className="inline-flex cursor-not-allowed items-center gap-1 rounded-sm px-2 py-1 text-[11.5px] text-on-surface-variant opacity-50"
              >
                {t.icon}
                <span className="hidden sm:inline">{t.label}</span>
              </button>
            ))}
            <button
              type="submit"
              disabled={disabled || !input.trim()}
              className="ml-auto inline-flex items-center gap-1.5 rounded-md bg-primary px-4 py-[7px] text-[12.5px] font-semibold text-on-primary transition-opacity hover:opacity-90 disabled:opacity-50"
            >
              送信
              <SendHorizontal size={12} aria-hidden="true" />
            </button>
          </div>
        </div>

        <div className="mt-2 flex items-center gap-3 px-1 text-[11px] text-on-surface-variant">
          <span className="inline-flex items-center gap-1">
            <ShieldCheck size={11} aria-hidden="true" />
            学習に使われません
          </span>
          <span className="ml-auto tabular-nums">
            Enter で送信 · Shift + Enter で改行
          </span>
        </div>
      </form>
    </section>
  );
}
