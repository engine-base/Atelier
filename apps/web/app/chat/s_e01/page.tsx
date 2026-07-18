"use client";

import * as React from "react";
import { Suspense, useState } from "react";
import { useSearchParams } from "next/navigation";

import { QueryProvider } from "../../../providers/query-provider";
import { ChatContainer } from "./_components/ChatContainer";
import { ProcessContextBar } from "./_components/ProcessContextBar";
import { ThreadSidebar } from "./_components/ThreadSidebar";

const PHASES = ["要件定義", "設計", "実装", "リリース"];

function SE01Inner() {
  const params = useSearchParams();
  // 初期スレッドは ?thread= を尊重し、以後はサイドバーの選択/作成で切り替える。
  const [threadId, setThreadId] = useState<string | null>(
    params.get("thread"),
  );
  const [phase, setPhase] = useState(PHASES[1]!);

  return (
    <div className="mx-auto flex h-[calc(100dvh-3.5rem)] w-full max-w-6xl flex-col gap-md px-md py-md">
      <ProcessContextBar
        phases={PHASES}
        currentPhaseId={phase}
        onChange={setPhase}
      />
      <div className="flex min-h-0 flex-1 flex-col gap-md md:flex-row">
        <ThreadSidebar selectedId={threadId} onSelect={setThreadId} />
        <div className="flex min-h-0 flex-1 flex-col rounded-lg border border-border bg-white">
          {threadId ? (
            <ChatContainer threadId={threadId} />
          ) : (
            <div className="flex flex-1 flex-col items-center justify-center gap-sm p-md text-center">
              <p className="text-body-lg font-bold text-on-surface">
                スレッドを選択してください
              </p>
              <p className="max-w-md text-body-md text-on-surface-variant">
                左の一覧からスレッドを選ぶか、「＋ 新規」で AI 社員との会話を開始できます。
              </p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

export default function SE01Page() {
  return (
    <QueryProvider>
      <Suspense
        fallback={
          <div className="p-lg text-body-md text-on-surface-variant">
            読み込み中…
          </div>
        }
      >
        <SE01Inner />
      </Suspense>
    </QueryProvider>
  );
}
