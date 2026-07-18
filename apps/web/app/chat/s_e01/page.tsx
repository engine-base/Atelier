"use client";

import * as React from "react";
import { Suspense, useState } from "react";
import { useSearchParams } from "next/navigation";
import { useQuery } from "@tanstack/react-query";

import { QueryProvider } from "../../../providers/query-provider";
import * as api from "../../../lib/auth/connector";
import { CANONICAL_PHASES } from "../../../lib/workflowPhases";
import { ChatContainer } from "./_components/ChatContainer";
import { ProcessContextBar } from "./_components/ProcessContextBar";
import { ThreadSidebar } from "./_components/ThreadSidebar";

/** 工程バーは他画面(ダッシュ/工程)と同じ canonical 9 工程を使う(以前は独自の4工程固定だった)。 */
const PHASE_LABELS = CANONICAL_PHASES.map((p) => p.label);

function SE01Inner() {
  const params = useSearchParams();
  // 初期スレッドは ?thread= を尊重し、以後はサイドバーの選択/作成で切り替える。
  const [threadId, setThreadId] = useState<string | null>(
    params.get("thread"),
  );

  // 選択スレッドのプロジェクトの current_phase を取得し、工程バーの現在地に反映する
  // (以前は "設計 Stage 2/4" 固定でプロジェクトの実工程と食い違っていた)。
  const phaseQuery = useQuery({
    queryKey: ["chat-thread-phase", threadId],
    enabled: !!threadId,
    queryFn: async () => {
      const th = (
        await api.getJson<{ project_id?: string }>(
          `/chat/threads/${threadId}`,
        )
      ).data;
      if (!th?.project_id) return undefined;
      const pj = (
        await api.getJson<{ current_phase?: string }>(
          `/projects/${th.project_id}`,
        )
      ).data;
      return pj?.current_phase;
    },
    retry: false,
  });
  const currentLabel =
    CANONICAL_PHASES.find((p) => p.key === phaseQuery.data)?.label ??
    PHASE_LABELS[0]!;

  return (
    <div className="mx-auto flex h-[calc(100dvh-3.5rem)] w-full max-w-6xl flex-col gap-md px-md py-md">
      {threadId ? (
        <ProcessContextBar
          phases={PHASE_LABELS}
          currentPhaseId={currentLabel}
        />
      ) : null}
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
