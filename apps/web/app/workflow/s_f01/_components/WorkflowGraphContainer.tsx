/**
 * S-F01 工程ワークフロー（司令塔）コンテナ — T-UC-10 (実 workflow API 配線)
 *
 * モック 06_mockups/workflow/S-F01-flow.html 準拠の司令塔画面:
 *   - 上部: 9 工程フローバー (クリックで工程選択)
 *   - 工程ヘッダー: Stage n/9 kicker + 工程名 + 状態 + 全体進捗 + 開始/経過
 *   - 左: 成果物 / 議論中 / 関連タスク タブ (実 outputs / chat / tasks API)
 *   - 右: クイックアクション / 関連リンク / 前工程サマリー / 次工程予告
 *
 * 遷移: 現在の in_progress を completed に、次の pending を in_progress にする
 * (PATCH /workflow/phases/{phase_id} ×2)。工程レコードが無ければ seed CTA。
 * api client は prop 注入可能 (テスト時に fake を渡す)。
 */

"use client";

import * as React from "react";
import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { ApiError, type ApiClient } from "@atelier/api-client";

import { Loading } from "../../../../components/Loading";
import { createAuthedApiClient } from "../../../../lib/auth/connector";
import {
  CANONICAL_PHASES,
  phaseStatusByCurrent,
} from "../../../../lib/workflowPhases";
import { StageBar, type StageNode } from "./StageBar";
import {
  PhaseTabs,
  SideRail,
  StageHeader,
  type PhaseInfo,
  type PhaseOutput,
  type PhaseTask,
  type PhaseThread,
} from "./PhaseDetail";

interface ApiPhase {
  id: string;
  name: string;
  status: string;
  order_index?: number;
  order?: number;
  started_at?: string | null;
  completed_at?: string | null;
}

interface ApiThread {
  id: string;
  title?: string | null;
  ai_employee_id?: string;
  updated_at?: string;
}

interface ApiEmployee {
  id: string;
  name?: string;
  display_name?: string;
}

/** モック atelier.css .avatar-* の社員カラー。 */
const EMPLOYEE_COLORS: Record<string, string> = {
  tony: "#DC2626",
  natasha: "#7C3AED",
  steve: "#1E40AF",
  peter: "#DC2626",
  strange: "#C7A04A",
  wanda: "#BE185D",
  thor: "#0891B2",
  vision: "#16A34A",
  tchalla: "#1F2937",
  jarvis: "#2563EB",
};

function toUi(status: string): StageNode["status"] {
  if (status === "completed") return "done";
  if (status === "skipped") return "blocked";
  if (status === "in_progress") return "in_progress";
  return "pending";
}

function isForbidden(error: unknown): boolean {
  return error instanceof ApiError && error.status === 403;
}

export interface WorkflowGraphContainerProps {
  readonly projectId: string;
  readonly client?: ApiClient;
}

/** 依存エッジの sr-only リスト (a11y: フローバーの順序を非視覚でも伝える)。 */
function DependencyList({ nodes }: { readonly nodes: readonly StageNode[] }) {
  return (
    <ul aria-label="依存関係" className="sr-only">
      {nodes.slice(1).map((node, i) => (
        <li key={node.id}>{`${nodes[i]!.label} → ${node.label}`}</li>
      ))}
    </ul>
  );
}

export function WorkflowGraphContainer({
  projectId,
  client: injected,
}: WorkflowGraphContainerProps) {
  const client = useMemo(() => injected ?? createAuthedApiClient(), [injected]);
  const queryClient = useQueryClient();
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const invalidatePhases = (): void => {
    void queryClient.invalidateQueries({
      queryKey: ["workflow-phases", projectId],
    });
    void queryClient.invalidateQueries({
      queryKey: ["project", "current-phase", projectId],
    });
  };

  // 工程レコードが無い project に canonical 9 工程を投入する (POST /workflow/phases/seed)。
  const seedMut = useMutation({
    mutationFn: () =>
      client.post("/workflow/phases/seed", {
        body: { project_id: projectId },
      }),
    onSuccess: invalidatePhases,
  });

  // 工程遷移: 現在の in_progress を completed に、次の pending を in_progress にする。
  const transitionMut = useMutation({
    mutationFn: (v: {
      phaseId: string;
      status: "completed" | "in_progress";
    }) =>
      client.patch("/workflow/phases/{phase_id}", {
        params: { path: { phase_id: v.phaseId } },
        body: { status: v.status },
      }),
  });

  const advance = async (currentId: string, nextId?: string): Promise<void> => {
    await transitionMut.mutateAsync({ phaseId: currentId, status: "completed" });
    if (nextId !== undefined) {
      await transitionMut.mutateAsync({
        phaseId: nextId,
        status: "in_progress",
      });
    }
    invalidatePhases();
  };

  const list = useQuery({
    queryKey: ["workflow-phases", projectId],
    queryFn: async () => {
      const res = await client.get("/workflow/phases", {
        params: { query: { project_id: projectId } },
      });
      return (res as { data?: ApiPhase[] }).data ?? [];
    },
    retry: false,
  });

  // DB に明示的な工程レコードが無い場合に備え、プロジェクトの current_phase を取得して
  // ダッシュボード(S-B02)と同じ canonical 9 工程を描くためのフォールバックに使う。
  const projectQuery = useQuery({
    queryKey: ["project", "current-phase", projectId],
    queryFn: async () => {
      const res = await client.get("/projects/{project_id}", {
        params: { path: { project_id: projectId } },
      });
      return (res as { data?: { current_phase?: string } }).data ?? {};
    },
    retry: false,
  });

  // タブ/右レール用の実データ (取得失敗は空扱いで画面自体は生かす)。
  const outputsQuery = useQuery({
    queryKey: ["workflow-outputs", projectId],
    queryFn: async () => {
      const res = await client.get("/outputs", {
        params: { query: { project_id: projectId } },
      });
      return (res as { data?: PhaseOutput[] }).data ?? [];
    },
    retry: false,
  });
  const threadsQuery = useQuery({
    queryKey: ["workflow-threads", projectId],
    queryFn: async () => {
      const res = await client.get("/chat/threads", {
        params: { query: { project_id: projectId } },
      });
      return (res as { data?: ApiThread[] }).data ?? [];
    },
    retry: false,
  });
  const tasksQuery = useQuery({
    queryKey: ["workflow-tasks", projectId],
    queryFn: async () => {
      const res = await client.get("/tasks", {
        params: { query: { project_id: projectId } },
      });
      return (res as { data?: PhaseTask[] }).data ?? [];
    },
    retry: false,
  });
  const employeesQuery = useQuery({
    queryKey: ["workflow-employees"],
    queryFn: async () => {
      const res = await client.get("/ai-employees", {});
      return (res as { data?: ApiEmployee[] }).data ?? [];
    },
    retry: false,
  });

  if (isForbidden(list.error)) {
    return (
      <p role="alert" className="px-md py-lg text-body-md text-error sm:px-[32px]">
        このプロジェクトの工程にアクセスする権限がありません。
      </p>
    );
  }
  if (list.error) {
    return (
      <p role="alert" className="px-md py-lg text-body-md text-error sm:px-[32px]">
        工程の取得に失敗しました。
      </p>
    );
  }
  if (list.isLoading) {
    return <Loading className="py-md" />;
  }

  const phases = [...(list.data ?? [])].sort(
    (a, b) => (a.order_index ?? a.order ?? 0) - (b.order_index ?? b.order ?? 0),
  );

  // 明示的な工程レコードが無ければ、current_phase から canonical 9 工程を描く
  // (ダッシュボードの「工程の流れ（9 工程）」と表示を一致させる)。
  if (phases.length === 0) {
    const current = projectQuery.data?.current_phase;
    const nodes: StageNode[] = CANONICAL_PHASES.map((p, i) => ({
      id: p.key,
      label: p.label,
      status: phaseStatusByCurrent(i, current) as StageNode["status"],
    }));
    return (
      <div>
        <StageBar nodes={nodes} />
        <DependencyList nodes={nodes} />
        <div className="flex flex-col items-start gap-3 px-md py-lg sm:px-[32px]">
          <p className="text-[13px] text-on-surface-variant">
            このプロジェクトの工程はまだ開始されていません。開始すると 9
            工程の進行を追跡できます。
          </p>
          <button
            type="button"
            onClick={() => seedMut.mutate()}
            disabled={seedMut.isPending}
            className="inline-flex h-10 items-center rounded-md bg-primary px-4 text-sm font-semibold text-on-primary transition-colors hover:bg-[#1E54D8] disabled:opacity-50"
          >
            {seedMut.isPending ? "開始中…" : "工程を開始する"}
          </button>
        </div>
      </div>
    );
  }

  const nodes: StageNode[] = phases.map((p) => ({
    id: p.id,
    label: p.name,
    status: toUi(p.status),
  }));

  const currentIdx = phases.findIndex((p) => p.status === "in_progress");
  const current = currentIdx >= 0 ? phases[currentIdx] : undefined;
  const next = current
    ? phases.slice(currentIdx + 1).find((p) => p.status === "pending")
    : undefined;
  const allSettled = phases.every(
    (p) => p.status === "completed" || p.status === "skipped",
  );
  const completedCount = phases.filter((p) => p.status === "completed").length;
  const progressPct = Math.round((completedCount / phases.length) * 100);

  // 選択工程: 明示選択 > 進行中 > 先頭。
  const selected =
    (selectedId ? phases.find((p) => p.id === selectedId) : undefined) ??
    current ??
    phases[0]!;
  const selectedIdx = phases.findIndex((p) => p.id === selected.id);
  const phaseInfo: PhaseInfo = {
    id: selected.id,
    label: selected.name,
    status: toUi(selected.status),
    index: selectedIdx,
    total: phases.length,
    started_at: selected.started_at,
    completed_at: selected.completed_at,
  };

  // タブデータ: 成果物は選択工程のものを優先表示 (phase_id 無し成果物は常に表示)。
  const allOutputs = outputsQuery.data ?? [];
  const outputs = allOutputs.filter(
    (o) => !o.phase_id || o.phase_id === selected.id,
  );

  const employees = employeesQuery.data ?? [];
  const employeeById = new Map(employees.map((e) => [e.id, e]));
  const threads: PhaseThread[] = (threadsQuery.data ?? []).map((th) => {
    const emp = th.ai_employee_id
      ? employeeById.get(th.ai_employee_id)
      : undefined;
    return {
      id: th.id,
      title: th.title ?? null,
      employeeName: emp?.display_name ?? emp?.name,
      employeeColor: emp?.name ? EMPLOYEE_COLORS[emp.name] : undefined,
      updated_at: th.updated_at,
    };
  });
  const tasks = tasksQuery.data ?? [];

  // 前工程のサマリー (直前工程の最新成果物 summary)。
  const prevPhase = selectedIdx > 0 ? phases[selectedIdx - 1] : undefined;
  const prevSummary = prevPhase
    ? allOutputs.find((o) => o.phase_id === prevPhase.id)?.summary ?? undefined
    : undefined;

  return (
    <div>
      <StageBar
        nodes={nodes}
        selectedId={selected.id}
        onSelect={setSelectedId}
      />
      <DependencyList nodes={nodes} />

      <StageHeader phase={phaseInfo} progressPct={progressPct} />

      {allSettled ? (
        <p className="px-md pb-2 text-[13px] font-semibold text-tertiary sm:px-[32px]">
          全工程が完了しました 🎉
        </p>
      ) : null}

      <div className="grid gap-5 px-md pb-[60px] pt-2 sm:px-[32px] lg:grid-cols-[minmax(0,1fr)_320px]">
        <PhaseTabs
          projectId={projectId}
          outputs={outputs}
          threads={threads}
          tasks={tasks}
        />
        <SideRail
          projectId={projectId}
          currentPhase={
            current
              ? {
                  id: current.id,
                  label: current.name,
                  status: "in_progress",
                  index: currentIdx,
                  total: phases.length,
                  started_at: current.started_at,
                  completed_at: current.completed_at,
                }
              : undefined
          }
          hasNext={next !== undefined}
          nextPhaseLabel={phases[selectedIdx + 1]?.name}
          prevPhaseLabel={prevPhase?.name}
          prevSummary={prevSummary}
          threadCount={threads.length}
          taskCount={tasks.length}
          onComplete={
            current ? () => void advance(current.id, next?.id) : undefined
          }
          completing={transitionMut.isPending}
        />
      </div>
    </div>
  );
}
