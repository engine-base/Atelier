/**
 * S-B02 プロジェクトダッシュボード コンテナ — T-UC-04 (実 API 配線)
 *
 * モック S-B02-dashboard.html の全領域を実データで構成する:
 *   - KPI: 全体進捗率 (実 phases) / 未承認 INBOX (実 approval-inbox) /
 *     今日の活動 (実タイムスタンプ集計) / 確定事項 (実 decisions)
 *   - 工程の流れ: 実 phases (無ければ current_phase から canonical 9)
 *   - 最新の活動: decisions + outputs + threads + 工程完了 を実タイムスタンプで合成
 *   - 右レール: 承認リクエスト (POST /approval-inbox/{id}/decide 配線) /
 *     最新成果物 (実 outputs) / AI 社員アクティビティ (実 threads から集計)
 * api client は prop 注入可能 (テスト時に fake を渡す)。
 */

"use client";

import * as React from "react";
import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { ApiError, type ApiClient } from "@atelier/api-client";

import { createAuthedApiClient } from "../../../../lib/auth/connector";
import {
  employeeColor,
  employeeName,
  type EmployeeLike,
} from "../../../../lib/aiEmployees";
import {
  CANONICAL_PHASES,
  phaseStatusByCurrent,
} from "../../../../lib/workflowPhases";
import {
  ProjectDashboard,
  type ActivityItem,
  type ApprovalItem,
  type DashboardKpi,
  type EmployeeActivityItem,
  type OutputItem,
  type StageItem,
} from "./ProjectDashboard";

type TaskCounts = Partial<Record<string, number>>;

interface ApiPhase {
  id: string;
  name: string;
  status: string;
  order?: number;
  completed_at?: string | null;
}
interface ApiDecision {
  id: string;
  status?: string;
  body?: string;
  decided_by?: string | null;
  created_at?: string;
}
interface ApiOutput {
  id: string;
  summary?: string | null;
  stage?: string;
  html_path?: string | null;
  json_path?: string | null;
  md_path?: string | null;
  created_at?: string;
}
interface ApiThread {
  id: string;
  title?: string | null;
  ai_employee_id?: string;
  updated_at?: string;
}
interface ApiApproval {
  id: string;
  title?: string;
  status?: string;
  payload?: Record<string, unknown>;
}

export interface ProjectDashboardContainerProps {
  readonly projectId: string;
  readonly client?: ApiClient;
}

function isForbidden(error: unknown): boolean {
  return error instanceof ApiError && error.status === 403;
}

/** fake client / 異常応答が object を返しても list 処理を落とさない配列ガード。 */
function asArray<T>(v: unknown): T[] {
  return Array.isArray(v) ? (v as T[]) : [];
}

const PROJECT_TYPE_LABEL: Record<string, string> = {
  self_product: "自社プロダクト",
  client_project: "クライアント案件",
  personal: "個人開発",
};

function isToday(iso: string | undefined): boolean {
  if (!iso) return false;
  const d = new Date(iso);
  const now = new Date();
  return (
    d.getFullYear() === now.getFullYear() &&
    d.getMonth() === now.getMonth() &&
    d.getDate() === now.getDate()
  );
}

function outputFormat(o: ApiOutput): string {
  if (o.html_path) return "HTML";
  if (o.md_path) return "MD";
  if (o.json_path) return "JSON";
  return "—";
}

export function ProjectDashboardContainer({
  projectId,
  client: injected,
}: ProjectDashboardContainerProps) {
  const client = useMemo(() => injected ?? createAuthedApiClient(), [injected]);
  const queryClient = useQueryClient();
  const [decidingId, setDecidingId] = useState<string | null>(null);

  const dashboard = useQuery({
    queryKey: ["project", "dashboard", projectId],
    queryFn: async () => {
      const res = await client.get("/projects/{project_id}/dashboard", {
        params: { path: { project_id: projectId } },
      });
      return (res as { data?: { task_counts?: TaskCounts } }).data ?? {};
    },
    retry: false,
  });

  const project = useQuery({
    queryKey: ["project", "detail", projectId],
    queryFn: async () => {
      const res = await client.get("/projects/{project_id}", {
        params: { path: { project_id: projectId } },
      });
      return (
        (res as { data?: { name?: string; type?: string; current_phase?: string } })
          .data ?? {}
      );
    },
    retry: false,
  });

  const phasesQuery = useQuery({
    queryKey: ["dash-phases", projectId],
    queryFn: async () => {
      const res = await client.get("/workflow/phases", {
        params: { query: { project_id: projectId } },
      });
      return asArray<ApiPhase>((res as { data?: unknown }).data);
    },
    retry: false,
  });
  const decisionsQuery = useQuery({
    queryKey: ["dash-decisions", projectId],
    queryFn: async () => {
      const res = await client.get("/decisions", {
        params: { query: { project_id: projectId } },
      });
      return asArray<ApiDecision>((res as { data?: unknown }).data);
    },
    retry: false,
  });
  const outputsQuery = useQuery({
    queryKey: ["dash-outputs", projectId],
    queryFn: async () => {
      const res = await client.get("/outputs", {
        params: { query: { project_id: projectId } },
      });
      return asArray<ApiOutput>((res as { data?: unknown }).data);
    },
    retry: false,
  });
  const threadsQuery = useQuery({
    queryKey: ["dash-threads", projectId],
    queryFn: async () => {
      const res = await client.get("/chat/threads", {
        params: { query: { project_id: projectId } },
      });
      return asArray<ApiThread>((res as { data?: unknown }).data);
    },
    retry: false,
  });
  const approvalsQuery = useQuery({
    queryKey: ["dash-approvals"],
    queryFn: async () => {
      const res = await client.get("/approval-inbox", {
        params: { query: { status: "pending" } },
      });
      return asArray<ApiApproval>((res as { data?: unknown }).data);
    },
    retry: false,
  });
  const employeesQuery = useQuery({
    queryKey: ["dash-employees"],
    queryFn: async () => {
      const res = await client.get("/ai-employees", {});
      return asArray<EmployeeLike>((res as { data?: unknown }).data);
    },
    retry: false,
  });

  const decideMut = useMutation({
    mutationFn: async (v: { id: string; decision: "approve" | "reject" }) => {
      setDecidingId(v.id);
      return client.post("/approval-inbox/{approval_id}/decide", {
        params: { path: { approval_id: v.id } },
        body: { decision: v.decision },
      });
    },
    onSettled: () => {
      setDecidingId(null);
      void queryClient.invalidateQueries({ queryKey: ["dash-approvals"] });
    },
  });

  if (isForbidden(dashboard.error) || isForbidden(project.error)) {
    return (
      <p role="alert" className="text-body-md text-error">
        このプロジェクトを表示する権限がありません。
      </p>
    );
  }
  if (dashboard.error) {
    return (
      <p role="alert" className="text-body-md text-error">
        ダッシュボードの取得に失敗しました。
      </p>
    );
  }

  const projectName = project.data?.name ?? "プロジェクト";
  const taskCounts = dashboard.data?.task_counts ?? {};

  // 工程: 実 phases (無ければ canonical 9 を current_phase から)
  const rawPhases = [...(phasesQuery.data ?? [])].sort(
    (a, b) => (a.order ?? 0) - (b.order ?? 0),
  );
  const stages: StageItem[] =
    rawPhases.length > 0
      ? rawPhases.map((p) => ({
          id: p.id,
          label: p.name,
          status:
            p.status === "completed"
              ? "done"
              : p.status === "in_progress"
                ? "in_progress"
                : p.status === "skipped"
                  ? "blocked"
                  : "pending",
        }))
      : CANONICAL_PHASES.map((p, i) => ({
          id: p.key,
          label: p.label,
          status: phaseStatusByCurrent(i, project.data?.current_phase) as StageItem["status"],
        }));

  const doneCount = stages.filter((s) => s.status === "done").length;
  const progressPct = stages.length
    ? Math.round((doneCount / stages.length) * 100)
    : 0;
  const currentStage = stages.find((s) => s.status === "in_progress");
  const currentIdx = currentStage
    ? stages.findIndex((s) => s.id === currentStage.id)
    : doneCount - 1;

  const employees = employeesQuery.data ?? [];
  const employeeById = new Map(employees.map((e) => [e.id, e]));

  const decisions = decisionsQuery.data ?? [];
  const outputs = outputsQuery.data ?? [];
  const threads = threadsQuery.data ?? [];

  // このプロジェクト宛の承認 (payload.project_id が一致 or 特定不能なら本人宛全件の先頭)
  const approvals: ApprovalItem[] = (approvalsQuery.data ?? [])
    .filter((a) => {
      const pid = a.payload?.project_id;
      return pid === undefined || pid === projectId;
    })
    .map((a) => ({
      id: a.id,
      title: a.title ?? "承認リクエスト",
      note: typeof a.payload?.note === "string" ? a.payload.note : undefined,
    }));

  // 最新の活動: 実タイムスタンプの合成フィード
  const q = `?project=${projectId}`;
  const feed: ActivityItem[] = [
    ...decisions.map((d): ActivityItem => {
      const emp = d.decided_by ? employeeById.get(d.decided_by) : undefined;
      return {
        id: d.id,
        kind: "decision",
        text:
          d.status === "unresolved"
            ? `未確認事項「${d.body ?? ""}」を登録`
            : `「${d.body ?? ""}」を確定`,
        actorName: employeeName(emp),
        actorColor: emp ? employeeColor(emp) : undefined,
        at: d.created_at,
        href: `/workflow${q}`,
      };
    }),
    ...outputs.map(
      (o): ActivityItem => ({
        id: o.id,
        kind: "output",
        text: `成果物「${(o.summary ?? o.stage ?? "成果物").split("—")[0]?.trim()}」を生成`,
        at: o.created_at,
        href: `/outputs${q}`,
      }),
    ),
    ...threads.map((th): ActivityItem => {
      const emp = th.ai_employee_id ? employeeById.get(th.ai_employee_id) : undefined;
      return {
        id: th.id,
        kind: "thread",
        text: `スレッド「${th.title ?? "無題"}」を更新`,
        actorName: employeeName(emp),
        actorColor: emp ? employeeColor(emp) : undefined,
        at: th.updated_at,
        href: `/chat${q}&thread=${th.id}`,
      };
    }),
    ...rawPhases
      .filter((p) => p.status === "completed" && p.completed_at)
      .map(
        (p): ActivityItem => ({
          id: p.id,
          kind: "phase",
          text: `${p.name} 工程が完了`,
          at: p.completed_at ?? undefined,
          href: `/workflow${q}`,
        }),
      ),
  ]
    .filter((a) => a.at)
    .sort((a, b) => new Date(b.at!).getTime() - new Date(a.at!).getTime())
    .slice(0, 8);

  const todayCount = feed.filter((a) => isToday(a.at)).length;
  const unresolvedCount = decisions.filter((d) => d.status === "unresolved").length;
  const decidedCount = decisions.length - unresolvedCount;

  const kpis: DashboardKpi[] = [
    {
      id: "progress",
      label: "全体進捗率",
      value: `${progressPct}%`,
      sub: `工程 ${doneCount}/${stages.length} 完了`,
      tone: "info",
    },
    {
      id: "inbox",
      label: "未承認 INBOX 件数",
      value: approvals.length,
      sub: approvals.length > 0 ? "承認待ちがあります" : "すべて処理済み",
      tone: approvals.length > 0 ? "error" : "success",
    },
    {
      id: "today",
      label: "今日の活動",
      value: todayCount,
      sub: `タスク ${taskCounts.total ?? 0} · チャット ${threads.length}`,
      tone: "info",
    },
    {
      id: "decisions",
      label: "確定事項",
      value: decidedCount,
      sub: `未確認 ${unresolvedCount} 件`,
      tone: "info",
    },
  ];

  const typeLabel = project.data?.type
    ? (PROJECT_TYPE_LABEL[project.data.type] ?? project.data.type)
    : undefined;
  const projectMeta = [
    typeLabel,
    currentIdx >= 0
      ? `第 ${currentIdx + 1} 段階 ${stages[currentIdx]?.label ?? ""}中`
      : undefined,
  ]
    .filter(Boolean)
    .join(" · ");

  const outputItems: OutputItem[] = outputs.map((o) => ({
    id: o.id,
    title: (o.summary ?? o.stage ?? "成果物").split("—")[0]?.trim() ?? "成果物",
    format: outputFormat(o),
    href: `/outputs${q}&output=${o.id}`,
  }));

  // AI 社員アクティビティ: スレッドの最終更新から実集計
  const lastActive = new Map<string, string>();
  for (const th of threads) {
    if (!th.ai_employee_id || !th.updated_at) continue;
    const prev = lastActive.get(th.ai_employee_id);
    if (!prev || new Date(th.updated_at) > new Date(prev)) {
      lastActive.set(th.ai_employee_id, th.updated_at);
    }
  }
  const employeeItems: EmployeeActivityItem[] = [...lastActive.entries()]
    .sort((a, b) => new Date(b[1]).getTime() - new Date(a[1]).getTime())
    .map(([id, at]) => {
      const emp = employeeById.get(id);
      return {
        id,
        name: employeeName(emp) ?? "AI 社員",
        color: emp ? employeeColor(emp) : "#2563EB",
        lastActiveAt: at,
      };
    });

  return (
    <ProjectDashboard
      projectName={projectName}
      projectMeta={projectMeta || undefined}
      kpis={kpis}
      stages={stages}
      activities={feed}
      approvals={approvals}
      outputs={outputItems}
      employees={employeeItems}
      projectId={projectId}
      loading={dashboard.isLoading}
      onDecideApproval={(id, decision) => decideMut.mutate({ id, decision })}
      decidingApprovalId={decidingId}
    />
  );
}
