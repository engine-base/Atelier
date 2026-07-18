/**
 * S-E01 チャット画面 — T-UC-08 / T-UC-09
 *
 * モック 06_mockups/chat/S-E01-thread.html 準拠の 3 ペイン構成 (フルブリード):
 *   左 260px スレッド一覧 (工程グルーピング) / 中央 チャット / 右 340px コンテキスト。
 * ペインはヘッダーのトグルで開閉。モバイルは一覧 ⇄ チャットを切替、右ペインは重ね表示。
 */

"use client";

import * as React from "react";
import { Suspense, useCallback, useMemo, useState } from "react";
import { useSearchParams } from "next/navigation";
import { useQuery } from "@tanstack/react-query";

import { QueryProvider } from "../../../providers/query-provider";
import * as api from "../../../lib/auth/connector";
import { cn } from "../../../lib/cn";
import { useProjectId } from "../../../lib/useProjectId";
import type { EmployeeLike } from "../../../lib/aiEmployees";
import { employeeColor, employeeName } from "../../../lib/aiEmployees";
import { ChatContainer, type ChatContextSummary } from "./_components/ChatContainer";
import { ChatHeader } from "./_components/ChatHeader";
import { ContextPane } from "./_components/ContextPane";
import { ThreadSidebar } from "./_components/ThreadSidebar";

interface ThreadDetail {
  readonly id: string;
  readonly project_id: string;
  readonly ai_employee_id: string;
  readonly title: string | null;
  readonly phase_id?: string | null;
}

interface PhaseLite {
  readonly id: string;
  readonly name: string;
  readonly status: string;
  readonly order?: number;
}

function SE01Inner() {
  const params = useSearchParams();
  const projectIdFromNav = useProjectId();
  const [threadId, setThreadId] = useState<string | null>(params.get("thread"));
  const [leftOpen, setLeftOpen] = useState(true);
  const [rightOpen, setRightOpen] = useState(true);
  // xl 未満での右ペインは重ね表示 (既定は閉。トグルで開く)
  const [rightOverlay, setRightOverlay] = useState(false);
  const [busy, setBusy] = useState(false);
  const [ctx, setCtx] = useState<ChatContextSummary | null>(null);
  const [messageCount, setMessageCount] = useState(0);

  const threadQuery = useQuery({
    queryKey: ["chat-thread", threadId],
    enabled: !!threadId,
    queryFn: async () =>
      (await api.getJson<ThreadDetail>(`/chat/threads/${threadId}`)).data,
    retry: false,
  });
  const thread = threadQuery.data;
  const projectId = thread?.project_id ?? projectIdFromNav;

  const employeesQuery = useQuery({
    queryKey: ["chat-employees"],
    queryFn: async () =>
      (await api.getJson<EmployeeLike[]>("/ai-employees")).data,
    retry: false,
  });
  const employee = useMemo(
    () =>
      (employeesQuery.data ?? []).find(
        (e) => e.id === thread?.ai_employee_id,
      ),
    [employeesQuery.data, thread?.ai_employee_id],
  );

  const phasesQuery = useQuery({
    queryKey: ["chat-phases", projectId ?? "none"],
    enabled: !!projectId,
    queryFn: async () =>
      (
        await api.getJson<PhaseLite[]>(`/workflow/phases?project_id=${projectId}`)
      ).data,
    retry: false,
  });
  const phases = useMemo(
    () =>
      [...(phasesQuery.data ?? [])].sort(
        (a, b) => (a.order ?? 0) - (b.order ?? 0),
      ),
    [phasesQuery.data],
  );
  const currentPhase =
    phases.find((p) => p.status === "in_progress") ?? phases[0];
  const currentPhaseIdx = currentPhase
    ? phases.findIndex((p) => p.id === currentPhase.id)
    : undefined;

  const handleContext = useCallback((c: ChatContextSummary) => setCtx(c), []);

  const gridCols =
    leftOpen && rightOpen
      ? "lg:grid-cols-[260px_minmax(0,1fr)] xl:grid-cols-[260px_minmax(0,1fr)_340px]"
      : leftOpen
        ? "lg:grid-cols-[260px_minmax(0,1fr)] xl:grid-cols-[260px_minmax(0,1fr)]"
        : rightOpen
          ? "lg:grid-cols-[minmax(0,1fr)] xl:grid-cols-[minmax(0,1fr)_340px]"
          : "lg:grid-cols-[minmax(0,1fr)]";

  return (
    <div className={cn("grid h-[calc(100dvh-3.5rem)] grid-cols-1", gridCols)}>
      <h1 className="sr-only">チャット</h1>

      {/* 左: スレッド一覧 — モバイルはスレッド未選択時のみ */}
      <div
        className={cn(
          "min-h-0",
          threadId ? "hidden" : "block",
          leftOpen ? "lg:block" : "lg:hidden",
        )}
      >
        <ThreadSidebar
          selectedId={threadId}
          onSelect={setThreadId}
          projectId={projectId}
        />
      </div>

      {/* 中央: チャット */}
      <div
        className={cn(
          "min-h-0 flex-col",
          threadId ? "flex" : "hidden lg:flex",
        )}
      >
        {threadId ? (
          <>
            <ChatHeader
              projectId={projectId}
              phaseLabel={currentPhase?.name}
              phaseIndex={currentPhaseIdx}
              phaseTotal={phases.length || undefined}
              employee={employee}
              busy={busy}
              leftOpen={leftOpen}
              rightOpen={rightOpen}
              onToggleLeft={() => setLeftOpen((v) => !v)}
              onToggleRight={() => {
                if (typeof window !== "undefined" && window.innerWidth < 1280) {
                  setRightOverlay((v) => !v);
                } else {
                  setRightOpen((v) => !v);
                }
              }}
              onBack={() => setThreadId(null)}
            />
            <div className="min-h-0 flex-1">
              <ChatContainer
                threadId={threadId}
                employee={
                  employee
                    ? {
                        name: employeeName(employee) ?? "AI 社員",
                        color: employeeColor(employee),
                      }
                    : undefined
                }
                onBusyChange={setBusy}
                onContext={handleContext}
                onMessageCount={setMessageCount}
              />
            </div>
          </>
        ) : (
          <div className="flex flex-1 flex-col items-center justify-center gap-sm p-md text-center">
            <p className="text-body-lg font-bold text-on-surface">
              スレッドを選択してください
            </p>
            <p className="max-w-md text-body-md text-on-surface-variant">
              左の一覧からスレッドを選ぶか、「新規スレッド」で AI
              社員との会話を開始できます。
            </p>
          </div>
        )}
      </div>

      {/* 右: コンテキストペイン (xl 未満はトグルで重ね表示) */}
      {rightOpen && threadId ? (
        <div className="hidden min-h-0 border-l border-border xl:block">
          <ContextPane
            projectId={projectId}
            phaseId={thread?.phase_id}
            phaseLabel={currentPhase?.name}
            phaseIndex={currentPhaseIdx}
            phaseTotal={phases.length || undefined}
            threadTitle={thread?.title}
            messageCount={messageCount}
            ctxHistoryCount={ctx?.historyCount ?? null}
            ctxRagHitCount={ctx?.ragHitCount ?? null}
          />
        </div>
      ) : null}
      {rightOverlay && threadId ? (
        <div className="fixed bottom-0 right-0 top-14 z-[90] w-[340px] max-w-[90vw] border-l border-border shadow-xl xl:hidden">
          <ContextPane
            projectId={projectId}
            phaseId={thread?.phase_id}
            phaseLabel={currentPhase?.name}
            phaseIndex={currentPhaseIdx}
            phaseTotal={phases.length || undefined}
            threadTitle={thread?.title}
            messageCount={messageCount}
            ctxHistoryCount={ctx?.historyCount ?? null}
            ctxRagHitCount={ctx?.ragHitCount ?? null}
          />
        </div>
      ) : null}
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
