/**
 * S-E01 チャットパネル — T-UC-08 (assistant-ui + SSE + tool-ui)
 *
 * 簡易チャット UI。message list + 入力欄。
 * 実 SSE は createRealtimeClient (Bundle D T-US-07) で別 PR 配線、
 * 実 assistant-ui 統合は selected-stack 通り @assistant-ui/react を別 PR で配線。
 * 本コンポーネントは message render + 入力の最小構造で a11y 完備。
 */

'use client';

import * as React from 'react';
import { useState } from 'react';

import { cn } from '../../../../lib/cn';

export type ChatRole = 'user' | 'assistant' | 'system';

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
  user: 'あなた',
  assistant: 'AI 社員',
  system: 'システム',
};

const ROLE_ALIGN: Record<ChatRole, string> = {
  user: 'self-end bg-primary-container text-primary-container-fg',
  assistant: 'self-start bg-surface-variant text-on-surface',
  system: 'self-center bg-secondary-container text-secondary-container-fg text-label-md',
};

export function ChatPanel({ messages, onSend, disabled }: ChatPanelProps) {
  const [input, setInput] = useState('');

  const submit = () => {
    const v = input.trim();
    if (!v) return;
    onSend(v);
    setInput('');
  };

  return (
    <section aria-label="チャット" className="flex h-full flex-col gap-md">
      <ul role="log" aria-live="polite" className="flex flex-1 flex-col gap-sm overflow-y-auto">
        {messages.map((m) => (
          <li
            key={m.id}
            className={cn(
              'max-w-[80%] rounded-md px-md py-sm text-body-md',
              ROLE_ALIGN[m.role],
            )}
          >
            <span className="block text-label-sm font-semibold opacity-70">
              {ROLE_LABEL[m.role]}
            </span>
            <span className="whitespace-pre-wrap">{m.content}</span>
          </li>
        ))}
      </ul>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
        className="flex items-end gap-sm"
      >
        <label htmlFor="chat-input" className="sr-only">
          メッセージを入力
        </label>
        <textarea
          id="chat-input"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
              e.preventDefault();
              submit();
            }
          }}
          disabled={disabled}
          rows={2}
          placeholder="メッセージを入力（Ctrl/Cmd+Enter で送信）"
          className="flex-1 rounded-md border border-surface-variant bg-surface px-sm py-xs text-body-md text-on-surface"
        />
        <button
          type="submit"
          disabled={disabled || !input.trim()}
          className="inline-flex h-10 items-center rounded-md bg-primary px-md text-label-lg text-primary-fg disabled:opacity-50"
        >
          送信
        </button>
      </form>
    </section>
  );
}
