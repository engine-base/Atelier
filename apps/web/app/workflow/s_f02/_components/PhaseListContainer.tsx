/**
 * S-F02 フェーズ管理 コンテナ — T-UC-11 / GAP-022 (実 workflow API 配線)
 *
 * GET /workflow/phases?project_id で工程一覧、PATCH /workflow/phases/{id} {status} で
 * 状態遷移（楽観更新＋失敗時ロールバック）。UI 状態(done/blocked)と API 状態
 * (completed/skipped)を相互変換する。
 * GAP-022: フェーズ提案 (POST /workflow/phase-proposals → 承認/却下)、
 * F-IMP01 影響範囲解析 (POST /workflow/impact-analysis → apply で実移動 +
 * リファクタ自動起票)、phase 別タスク集計 + 統計 (実行回数/整合性) を配線。
 * api client は prop 注入可能 (テスト時に fake を渡す)。
 */

"use client";

import * as React from "react";
import { Loading } from "../../../../components/Loading";
import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { ApiError, type ApiClient } from "@atelier/api-client";

import { createAuthedApiClient } from "../../../../lib/auth/connector";
import {
  PhaseList,
  type AssignableEmployee,
  type ImpactResult,
  type PhaseProposalItem,
  type PhaseRow,
  type PhaseStatus,
  type PhaseTaskStats,
  type WorkflowStats,
} from "./PhaseList";

interface ApiPhase {
  id: string;
  name: string;
  status: string;
  order_index?: number;
  order?: number;
  started_at?: string | null;
  completed_at?: string | null;
  description?: string | null;
  assigned_employee_ids?: string[] | null;
}

const KEY = (projectId: string) => ["workflow-phases", projectId] as const;

type ApiPhaseStatus = "pending" | "in_progress" | "completed" | "skipped";

function toUi(status: string): PhaseStatus {
  if (status === "completed") return "done";
  if (status === "skipped") return "blocked";
  if (status === "in_progress") return "in_progress";
  return "pending";
}
function toApi(status: PhaseStatus): ApiPhaseStatus {
  if (status === "done") return "completed";
  if (status === "blocked") return "skipped";
  return status;
}

export interface PhaseListContainerProps {
  readonly projectId: string;
  readonly client?: ApiClient;
}

function isForbidden(error: unknown): boolean {
  return error instanceof ApiError && error.status === 403;
}

interface ApiProposal {
  id: string;
  name: string;
  description?: string | null;
  reason: string;
  proposed_order: number;
  status: string;
  created_at?: string;
}

interface ApiImpactResult {
  id: string;
  task_title: string;
  target_phase_name: string;
  affected: { id: string; title: string; lifecycle_stage: string }[];
  done_count: number;
  applied: boolean;
}

/** ISO → "YYYY-MM-DD HH:mm" (鉄則: 生 ISO を画面に出さない)。 */
function dateLabel(iso: string | undefined): string {
  return iso ? iso.slice(0, 16).replace("T", " ") : "";
}

function statusOf(error: unknown): number | null {
  return error instanceof ApiError ? error.status : null;
}

export function PhaseListContainer({
  projectId,
  client: injected,
}: PhaseListContainerProps) {
  const client = useMemo(() => injected ?? createAuthedApiClient(), [injected]);
  const queryClient = useQueryClient();
  const [action, setAction] = useState<{
    kind: "notice" | "error";
    text: string;
  } | null>(null);
  const [impactResult, setImpactResult] = useState<ImpactResult | null>(null);

  const list = useQuery({
    queryKey: KEY(projectId),
    queryFn: async () => {
      const res = await client.get("/workflow/phases", {
        params: { query: { project_id: projectId } },
      });
      return (res as { data?: ApiPhase[] }).data ?? [];
    },
    retry: false,
  });

  // GAP-004: 担当割当 (対象プロジェクトの WS 社員のみ + PATCH assigned_employee_ids)。
  // 無フィルタの /ai-employees は他 WS の同名社員を混ぜてしまう (実操作監査で
  // 別 WS のワンダを選び 422 → 検出) ため、project → workspace で絞る。
  const projectQuery = useQuery({
    queryKey: ["phase-assign-project", projectId],
    queryFn: async () => {
      const res = await client.get("/projects/{project_id}", {
        params: { path: { project_id: projectId } },
      });
      return (res as { data?: { workspace_id?: string } }).data ?? null;
    },
    retry: false,
  });
  const workspaceId = projectQuery.data?.workspace_id;
  const employeesQuery = useQuery({
    queryKey: ["phase-assign-employees", workspaceId ?? "none"],
    enabled: !!workspaceId,
    queryFn: async () => {
      const res = await client.get("/ai-employees", {
        params: { query: { workspace_id: workspaceId } },
      });
      return (
        (res as {
          data?: { id: string; name: string; display_name?: string | null; icon?: string | null }[];
        }).data ?? []
      );
    },
    retry: false,
  });
  const assignMut = useMutation({
    mutationFn: (vars: { id: string; employeeIds: readonly string[] }) =>
      client.patch("/workflow/phases/{phase_id}", {
        params: { path: { phase_id: vars.id } },
        body: { assigned_employee_ids: [...vars.employeeIds] },
      }),
    onMutate: async (vars) => {
      const key = KEY(projectId);
      await queryClient.cancelQueries({ queryKey: key });
      const prev = queryClient.getQueryData<ApiPhase[]>(key);
      queryClient.setQueryData<ApiPhase[]>(key, (old) =>
        (old ?? []).map((p) =>
          p.id === vars.id
            ? { ...p, assigned_employee_ids: [...vars.employeeIds] }
            : p,
        ),
      );
      return { prev };
    },
    onError: (_e, _vars, ctx) => {
      if (ctx?.prev) queryClient.setQueryData(KEY(projectId), ctx.prev);
    },
    onSettled: () =>
      void queryClient.invalidateQueries({ queryKey: KEY(projectId) }),
  });

  const transitionMut = useMutation({
    mutationFn: (vars: { id: string; status: PhaseStatus }) =>
      client.patch("/workflow/phases/{phase_id}", {
        params: { path: { phase_id: vars.id } },
        body: { status: toApi(vars.status) },
      }),
    // 楽観更新: 状態を即座に反映、失敗時に元へ戻す。
    onMutate: async (vars) => {
      const key = KEY(projectId);
      await queryClient.cancelQueries({ queryKey: key });
      const prev = queryClient.getQueryData<ApiPhase[]>(key);
      queryClient.setQueryData<ApiPhase[]>(key, (old) =>
        (old ?? []).map((p) =>
          p.id === vars.id ? { ...p, status: toApi(vars.status) } : p,
        ),
      );
      return { prev };
    },
    onError: (_e, _vars, ctx) => {
      if (ctx?.prev) queryClient.setQueryData(KEY(projectId), ctx.prev);
    },
    onSettled: () =>
      void queryClient.invalidateQueries({ queryKey: KEY(projectId) }),
  });

  // ── GAP-022: 提案 / 集計 / 統計 / 影響解析 ────────────────────────────
  const proposals = useQuery({
    queryKey: ["phase-proposals", projectId],
    queryFn: async () => {
      const res = await client.get("/workflow/phase-proposals", {
        params: { query: { project_id: projectId } },
      });
      const d = (res as { data?: unknown }).data;
      return Array.isArray(d) ? (d as ApiProposal[]) : [];
    },
    retry: false,
  });

  const taskStatsQuery = useQuery({
    queryKey: ["phase-task-stats", projectId],
    queryFn: async () => {
      const res = await client.get("/workflow/phase-task-stats", {
        params: { query: { project_id: projectId } },
      });
      const d = (res as { data?: unknown }).data;
      return Array.isArray(d)
        ? (d as {
            phase_id: string;
            total: number;
            done: number;
            awaiting: number;
            avg_score?: number | null;
          }[])
        : [];
    },
    retry: false,
  });

  const impactStats = useQuery({
    queryKey: ["impact-stats", projectId],
    queryFn: async () => {
      const res = await client.get("/workflow/impact-stats", {
        params: { query: { project_id: projectId } },
      });
      return (
        (res as {
          data?: {
            today_count: number;
            consistency_ok: boolean;
            dangling_count: number;
          };
        }).data ?? null
      );
    },
    retry: false,
  });

  const tasksQuery = useQuery({
    queryKey: ["impact-tasks", projectId],
    queryFn: async () => {
      const res = await client.get("/tasks", {
        params: { query: { project_id: projectId, limit: 200 } },
      });
      const d = (res as { data?: unknown }).data;
      return Array.isArray(d) ? (d as { id: string; title: string }[]) : [];
    },
    retry: false,
  });

  const invalidateGap022 = () => {
    void queryClient.invalidateQueries({ queryKey: ["phase-proposals", projectId] });
    void queryClient.invalidateQueries({ queryKey: ["phase-task-stats", projectId] });
    void queryClient.invalidateQueries({ queryKey: ["impact-stats", projectId] });
    void queryClient.invalidateQueries({ queryKey: KEY(projectId) });
    void queryClient.invalidateQueries({ queryKey: ["impact-tasks", projectId] });
  };

  const proposeMut = useMutation({
    mutationFn: () =>
      client.post("/workflow/phase-proposals", {
        body: { project_id: projectId },
      }),
    onSuccess: () => {
      invalidateGap022();
      setAction({ kind: "notice", text: "ジャービスが次フェーズを提案しました。" });
    },
    onError: (e) =>
      setAction({
        kind: "error",
        text:
          statusOf(e) === 503
            ? "COO AI（ジャービス）が未設定のため提案を生成できません。"
            : statusOf(e) === 409
              ? "承認待ちの提案が既にあります。"
              : "提案の生成に失敗しました。",
      }),
  });

  const approveProposalMut = useMutation({
    mutationFn: (id: string) =>
      client.post("/workflow/phase-proposals/{proposal_id}/approve", {
        params: { path: { proposal_id: id } },
      }),
    onSuccess: (res) => {
      invalidateGap022();
      const phase = (
        res as { data?: { phase?: { name?: string; order?: number } } }
      ).data?.phase;
      setAction({
        kind: "notice",
        text: phase
          ? `提案を承認し、第 ${phase.order} 段階「${phase.name}」を確定しました。`
          : "提案を承認しました。",
      });
    },
    onError: (e) =>
      setAction({
        kind: "error",
        text:
          statusOf(e) === 409
            ? "この提案は既に処理済みです。"
            : "提案の承認に失敗しました。",
      }),
  });

  const rejectProposalMut = useMutation({
    mutationFn: (id: string) =>
      client.post("/workflow/phase-proposals/{proposal_id}/reject", {
        params: { path: { proposal_id: id } },
      }),
    onSuccess: () => {
      invalidateGap022();
      setAction({
        kind: "notice",
        text: "提案を却下しました（フェーズは作成されません）。",
      });
    },
    onError: (e) =>
      setAction({
        kind: "error",
        text:
          statusOf(e) === 409
            ? "この提案は既に処理済みです。"
            : "提案の却下に失敗しました。",
      }),
  });

  const analyzeMut = useMutation({
    mutationFn: async (vars: { taskId: string; targetPhaseId: string }) => {
      const res = await client.post("/workflow/impact-analysis", {
        body: { task_id: vars.taskId, target_phase_id: vars.targetPhaseId },
      });
      return (res as { data?: ApiImpactResult }).data ?? null;
    },
    onSuccess: (data) => {
      void queryClient.invalidateQueries({ queryKey: ["impact-stats", projectId] });
      if (data) {
        setImpactResult({
          id: data.id,
          taskTitle: data.task_title,
          targetPhaseName: data.target_phase_name,
          affected: data.affected.map((a) => ({
            id: a.id,
            title: a.title,
            lifecycleStage: a.lifecycle_stage,
          })),
          doneCount: data.done_count,
          applied: data.applied,
        });
      }
    },
    onError: (e) =>
      setAction({
        kind: "error",
        text:
          statusOf(e) === 422
            ? "移動先フェーズが別プロジェクトのため解析できません。"
            : "影響範囲の解析に失敗しました。",
      }),
  });

  const applyMut = useMutation({
    mutationFn: async (analysisId: string) => {
      const res = await client.post(
        "/workflow/impact-analysis/{analysis_id}/apply",
        { params: { path: { analysis_id: analysisId } } },
      );
      return (
        (res as { data?: { refactor_task_ids?: string[] } }).data ?? null
      );
    },
    onSuccess: (data) => {
      invalidateGap022();
      setImpactResult((prev) => (prev ? { ...prev, applied: true } : prev));
      const n = data?.refactor_task_ids?.length ?? 0;
      setAction({
        kind: "notice",
        text:
          n > 0
            ? `タスクを移動し、リファクタタスク ${n} 件を自動起票しました（F-CUC02）。`
            : "タスクを移動しました。",
      });
    },
    onError: (e) =>
      setAction({
        kind: "error",
        text:
          statusOf(e) === 409
            ? "この解析結果は既に適用済みです。"
            : "適用に失敗しました。",
      }),
  });

  if (isForbidden(list.error)) {
    return (
      <p role="alert" className="text-body-md text-error">
        このプロジェクトの工程にアクセスする権限がありません。
      </p>
    );
  }
  if (list.error) {
    return (
      <p role="alert" className="text-body-md text-error">
        工程の取得に失敗しました。
      </p>
    );
  }
  if (list.isLoading) {
    return <Loading className="py-md" />;
  }

  const rows: PhaseRow[] = (list.data ?? []).map((p, i) => ({
    id: p.id,
    name: p.name,
    status: toUi(p.status),
    order: p.order_index ?? p.order ?? i + 1,
    startedAt: p.started_at ?? null,
    completedAt: p.completed_at ?? null,
    description: p.description ?? null,
    assignedEmployeeIds: p.assigned_employee_ids ?? [],
  }));

  const employees: AssignableEmployee[] = (employeesQuery.data ?? []).map((e) => ({
    id: e.id,
    name: e.display_name || e.name,
  }));

  const pendingProposal = (proposals.data ?? []).find(
    (p) => p.status === "pending",
  );
  const proposalItem: PhaseProposalItem | null = pendingProposal
    ? {
        id: pendingProposal.id,
        name: pendingProposal.name,
        description: pendingProposal.description ?? null,
        reason: pendingProposal.reason,
        proposedOrder: pendingProposal.proposed_order,
        createdAt: dateLabel(pendingProposal.created_at),
      }
    : null;

  const taskStats: Record<string, PhaseTaskStats> = {};
  for (const s of taskStatsQuery.data ?? []) {
    taskStats[s.phase_id] = {
      total: s.total,
      done: s.done,
      awaiting: s.awaiting,
      avgScore: s.avg_score ?? null,
    };
  }

  const stats: WorkflowStats | undefined = impactStats.data
    ? {
        pendingProposals: pendingProposal ? 1 : 0,
        impactTodayCount: impactStats.data.today_count,
        consistencyOk: impactStats.data.consistency_ok,
        danglingCount: impactStats.data.dangling_count,
      }
    : undefined;

  return (
    <PhaseList
      rows={rows}
      onTransition={(id, status) => transitionMut.mutate({ id, status })}
      {...(employees.length > 0
        ? {
            employees,
            onAssign: (id: string, employeeIds: readonly string[]) =>
              assignMut.mutate({ id, employeeIds }),
          }
        : {})}
      taskStats={taskStats}
      proposal={proposals.error ? null : proposalItem}
      onPropose={() => proposeMut.mutate()}
      proposing={proposeMut.isPending}
      onApproveProposal={(id) => approveProposalMut.mutate(id)}
      onRejectProposal={(id) => rejectProposalMut.mutate(id)}
      proposalResolving={
        approveProposalMut.isPending || rejectProposalMut.isPending
      }
      impactTasks={(tasksQuery.data ?? []).map((t) => ({
        id: t.id,
        title: t.title,
      }))}
      onAnalyzeImpact={(taskId, targetPhaseId) =>
        analyzeMut.mutate({ taskId, targetPhaseId })
      }
      analyzing={analyzeMut.isPending}
      impactResult={impactResult}
      onApplyImpact={(id) => applyMut.mutate(id)}
      applyingImpact={applyMut.isPending}
      stats={stats}
      actionNotice={action?.kind === "notice" ? action.text : undefined}
      actionError={action?.kind === "error" ? action.text : undefined}
    />
  );
}
