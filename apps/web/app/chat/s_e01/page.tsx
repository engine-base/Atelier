'use client';

import * as React from 'react';
import { useState } from 'react';

import { ChatPanel, type ChatMessage } from './_components/ChatPanel';
import { ProcessContextBar } from './_components/ProcessContextBar';

const PHASES = ['要件定義', '設計', '実装', 'リリース'];

export default function SE01Page() {
  const [messages, setMessages] = useState<ChatMessage[]>([
    { id: 'm1', role: 'system', content: 'チャットを開始しました' },
  ]);
  const [phase, setPhase] = useState(PHASES[1]!);

  return (
    <div className="mx-auto flex h-[calc(100dvh-3.5rem)] w-full max-w-5xl flex-col gap-md px-md py-md">
      <ProcessContextBar phases={PHASES} currentPhaseId={phase} onChange={setPhase} />
      <ChatPanel
        messages={messages}
        onSend={(text) =>
          setMessages((m) => [
            ...m,
            { id: `u-${Date.now()}`, role: 'user', content: text },
            {
              id: `a-${Date.now() + 1}`,
              role: 'assistant',
              content: `(${phase}) を踏まえて返答します`,
            },
          ])
        }
      />
    </div>
  );
}
