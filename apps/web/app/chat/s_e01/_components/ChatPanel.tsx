/**
 * S-E01 チャットパネル — T-UC-08 (assistant-ui + SSE + tool-ui)
 *
 * モック 06_mockups/chat/S-E01-thread.html の中央チャットペイン (メッセージスレッド +
 * コンポーザ) に忠実な presentational。メッセージバブル(user=右/primary、assistant=左+avatar)、
 * ツールバー付きコンポーザ、学習除外バッジを再現する。データ配線・props・a11y 契約は不変。
 */

"use client";

import * as React from "react";
import { useState } from "react";
import {
  AtSign,
  Brain,
  Paperclip,
  SendHorizontal,
  ShieldCheck,
  Sparkles,
  Zap,
} from "lucide-react";


export type ChatRole = "user" | "assistant" | "system";

export interface ChatMessage {
  readonly id: string;
  readonly role: ChatRole;
  readonly content: string;
}

export interface ChatPanelProps {
  readonly messages: readonly ChatMessage[];
  readonly onSend: (text: string) => void;
  readonly disabled?: boolean;
}

const ROLE_LABEL: Record<ChatRole, string> = {
  user: "あなた",
  assistant: "AI 社員",
  system: "システム",
};

function MessageRow({ message }: { readonly message: ChatMessage }) {
  const name = ROLE_LABEL[message.role];

  if (message.role === "user") {
    return (
      <li className="ml-auto flex max-w-[760px] flex-col items-end">
        <div className="mb-1 flex items-center gap-2 pr-1 text-on-surface-variant">
          <span className="text-[12.5px] font-bold">{name}</span>
        </div>
        <div className="max-w-[580px] whitespace-pre-wrap rounded-lg rounded-br-sm bg-primary px-4 py-3 text-body-md text-on-primary">
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

  return (
    <li className="flex max-w-[760px] gap-3">
      <div
        aria-hidden="true"
        className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-primary-container text-on-primary-container"
      >
        <Sparkles size={15} />
      </div>
      <div className="min-w-0 flex-1">
        <div className="mb-1 flex items-center gap-2">
          <span className="text-[12.5px] font-bold text-on-surface">{name}</span>
        </div>
        <div className="whitespace-pre-wrap text-body-md leading-relaxed text-on-surface">
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

export function ChatPanel({ messages, onSend, disabled }: ChatPanelProps) {
  const [input, setInput] = useState("");

  const submit = () => {
    const v = input.trim();
    if (!v) return;
    onSend(v);
    setInput("");
  };

  return (
    <section aria-label="チャット" className="flex h-full flex-col gap-md">
      <ul
        role="log"
        aria-live="polite"
        className="flex flex-1 flex-col gap-lg overflow-y-auto py-sm"
      >
        {messages.map((m) => (
          <MessageRow key={m.id} message={m} />
        ))}
      </ul>

      <form
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
        className="shrink-0"
      >
        <div className="rounded-lg border border-border bg-surface p-3 transition-colors focus-within:border-primary focus-within:ring-4 focus-within:ring-primary-container">
          <label htmlFor="chat-input" className="sr-only">
            メッセージを入力
          </label>
          <textarea
            id="chat-input"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                e.preventDefault();
                submit();
              }
            }}
            disabled={disabled}
            rows={2}
            placeholder="AI 社員にメッセージ… · @ でメンション · / でコマンド呼出"
            className="max-h-[200px] min-h-[44px] w-full resize-none border-0 bg-transparent text-body-md leading-relaxed text-on-surface outline-none placeholder:text-on-surface-variant"
          />
          <div className="mt-2 flex items-center gap-1 border-t border-border pt-2">
            {TOOL_BUTTONS.map((t) => (
              <button
                key={t.label}
                type="button"
                className="inline-flex items-center gap-1 rounded-sm px-2 py-1 text-[11.5px] text-on-surface-variant transition-colors hover:bg-surface-variant hover:text-on-surface"
              >
                {t.icon}
                {t.label}
              </button>
            ))}
            <button
              type="submit"
              disabled={disabled || !input.trim()}
              className="ml-auto inline-flex items-center gap-1.5 rounded-md bg-primary px-4 py-1.5 text-[12.5px] font-semibold text-on-primary transition-opacity hover:opacity-90 disabled:opacity-50"
            >
              送信
              <SendHorizontal size={12} aria-hidden="true" />
            </button>
          </div>
        </div>

        <div className="mt-2 flex items-center gap-3 px-1 text-label-sm text-on-surface-variant">
          <span className="inline-flex items-center gap-1">
            <ShieldCheck size={11} aria-hidden="true" />
            学習に使われません
          </span>
          <span className="ml-auto tabular-nums">
            Ctrl / Cmd + Enter で送信 · Shift + Enter で改行
          </span>
        </div>
      </form>
    </section>
  );
}
