/**
 * S-T01 運営ダッシュボード コンテナ — T-UC-30 / GAP-019 (実 admin API 全配線)
 *
 * GET /admin/dashboard (workspace scope KPI) + /admin/platform-stats (横断) +
 * /admin/mission (目標 + 実ペース) + /admin/trends (週次実累計) +
 * /admin/acquisitions (チャネル記録) + /admin/health (実計測) +
 * /admin/beta-feedback + /admin/costs + /admin/audit-logs (アクティビティ)。
 * 記録系 (goal / acquisition / cost) と FB resolve は mutation + 通知。
 * いずれも運営 admin 専用 (403)。api client は prop 注入可能。
 */

"use client";

import * as React from "react";
import { Loading } from "../../../../components/Loading";
import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { ApiError, type ApiClient } from "@atelier/api-client";

import { createAuthedApiClient } from "../../../../lib/auth/connector";
import {
  AdminDashboard,
  CHANNEL_LABEL,
  type AdminActivity,
  type AdminKpi,
  type GoalFormValues,
} from "./AdminDashboard";

interface ApiDashboard {
  workspace_count?: number;
  project_count?: number;
  ai_employee_count?: number;
  audit_log_count_24h?: number;
}

interface ApiAdminUser {
  id: string;
  email: string;
}

interface ApiAudit {
  id: string;
  action: string;
  actor_id: string;
  created_at: string;
}

interface ApiMission {
  goal: {
    title: string;
    target_count: number;
    deadline: string;
    note?: string | null;
  } | null;
  current_count: number;
  added_30d: number;
  remaining?: number | null;
  months_left?: number | null;
  needed_per_month?: number | null;
}

interface ApiStats {
  task_executions_30d: number;
  avg_score_30d?: number | null;
  beta_feedback_total: number;
  beta_feedback_open: number;
  bridge_connected: number;
  users_total: number;
  users_deleted_30d: number;
  workspaces_added_30d: number;
}

export interface AdminDashboardContainerProps {
  readonly client?: ApiClient;
}

function isForbidden(error: unknown): boolean {
  return error instanceof ApiError && error.status === 403;
}

function dateLabel(iso: string | undefined): string {
  return iso ? iso.slice(0, 16).replace("T", " ") : "";
}

export function AdminDashboardContainer({
  client: injected,
}: AdminDashboardContainerProps) {
  const client = useMemo(() => injected ?? createAuthedApiClient(), [injected]);
  const queryClient = useQueryClient();
  const [channelRange, setChannelRange] = useState<"30d" | "all">("30d");
  const [feedbackFilter, setFeedbackFilter] = useState<"open" | "all">("open");
  const [action, setAction] = useState<{
    kind: "notice" | "error";
    text: string;
  } | null>(null);

  const dashboard = useQuery({
    queryKey: ["admin", "dashboard"],
    queryFn: async () => {
      const res = await client.get("/admin/dashboard");
      return (res as { data?: ApiDashboard }).data ?? {};
    },
    retry: false,
  });

  const mission = useQuery({
    queryKey: ["admin", "mission"],
    queryFn: async () => {
      const res = await client.get("/admin/mission");
      const d = (res as { data?: ApiMission }).data;
      return d && typeof d.current_count === "number" ? d : null;
    },
    retry: false,
  });

  const stats = useQuery({
    queryKey: ["admin", "platform-stats"],
    queryFn: async () => {
      const res = await client.get("/admin/platform-stats");
      const d = (res as { data?: ApiStats }).data;
      return d && typeof d.task_executions_30d === "number" ? d : null;
    },
    retry: false,
  });

  const trends = useQuery({
    queryKey: ["admin", "trends"],
    queryFn: async () => {
      const res = await client.get("/admin/trends", {
        params: { query: { days: 90 } },
      });
      const d = (
        res as {
          data?: {
            points?: { week_start: string; workspaces: number; projects: number }[];
            billing_enabled?: boolean;
          };
        }
      ).data;
      return d && Array.isArray(d.points)
        ? { points: d.points, billing_enabled: d.billing_enabled === true }
        : null;
    },
    retry: false,
  });

  const acquisitions = useQuery({
    queryKey: ["admin", "acquisitions", channelRange],
    queryFn: async () => {
      const res = await client.get("/admin/acquisitions", {
        params: {
          query: channelRange === "30d" ? { days: 30 } : {},
        },
      });
      const d = (
        res as {
          data?: {
            channels?: { channel: string; count: number }[];
            recent?: { id: string; channel: string; note: string; occurred_on: string }[];
          };
        }
      ).data;
      return d && Array.isArray(d.channels)
        ? { channels: d.channels, recent: d.recent ?? [] }
        : null;
    },
    retry: false,
  });

  const health = useQuery({
    queryKey: ["admin", "health"],
    queryFn: async () => {
      const res = await client.get("/admin/health");
      const d = (res as { data?: unknown }).data;
      return Array.isArray(d) && d.every((x) => x && typeof x === "object" && "status" in x)
        ? (d as { name: string; status: "ok" | "warn" | "err"; detail: string; meta: string }[])
        : [];
    },
    retry: false,
  });

  const feedback = useQuery({
    queryKey: ["admin", "beta-feedback", feedbackFilter],
    queryFn: async () => {
      const res = await client.get("/admin/beta-feedback", {
        params: {
          query: feedbackFilter === "open" ? { status: "open" } : {},
        },
      });
      const d = (res as { data?: unknown }).data;
      return Array.isArray(d)
        ? (d as {
            id: string;
            email: string;
            category: string;
            content: string;
            status: string;
            created_at: string;
          }[])
        : [];
    },
    retry: false,
  });

  const costs = useQuery({
    queryKey: ["admin", "costs"],
    queryFn: async () => {
      const res = await client.get("/admin/costs");
      const d = (
        res as {
          data?: {
            month?: string;
            total_yen?: number;
            items?: { id: string; name: string; description: string; amount_yen: number }[];
          };
        }
      ).data;
      return d && Array.isArray(d.items) && typeof d.month === "string"
        ? { month: d.month, total_yen: d.total_yen ?? 0, items: d.items }
        : null;
    },
    retry: false,
  });

  const activity = useQuery({
    queryKey: ["admin", "dashboard", "recent"],
    queryFn: async () => {
      const res = await client.get("/admin/audit-logs");
      return (res as { data?: ApiAudit[] }).data ?? [];
    },
    retry: false,
  });

  // actor_id (UUID) をメールに解決する (生 UUID の羅列は読めない — 鉄則5)
  const users = useQuery({
    queryKey: ["admin", "users", "for-actor"],
    queryFn: async () => {
      const res = await client.get("/admin/users");
      return (res as { data?: ApiAdminUser[] }).data ?? [];
    },
    retry: false,
  });

  const goalMut = useMutation({
    mutationFn: (v: GoalFormValues) =>
      client.put("/admin/goal", {
        body: {
          title: v.title,
          target_count: v.targetCount,
          deadline: v.deadline,
          ...(v.note ? { note: v.note } : {}),
        },
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["admin", "mission"] });
      setAction({ kind: "notice", text: "獲得目標を記録しました。" });
    },
    onError: () =>
      setAction({ kind: "error", text: "目標の記録に失敗しました。" }),
  });

  const recordAcqMut = useMutation({
    mutationFn: (channel: string) =>
      client.post("/admin/acquisitions", {
        body: {
          channel: channel as "referral" | "sns" | "personal" | "other",
        },
      }),
    onSuccess: (_r, channel) => {
      void queryClient.invalidateQueries({ queryKey: ["admin", "acquisitions"] });
      void queryClient.invalidateQueries({ queryKey: ["admin", "mission"] });
      setAction({
        kind: "notice",
        text: `獲得を記録しました（${CHANNEL_LABEL[channel] ?? channel}）。`,
      });
    },
    onError: () =>
      setAction({ kind: "error", text: "獲得の記録に失敗しました。" }),
  });

  const deleteAcqMut = useMutation({
    mutationFn: (id: string) =>
      client.delete("/admin/acquisitions/{record_id}", {
        params: { path: { record_id: id } },
      }),
    onSuccess: () =>
      void queryClient.invalidateQueries({ queryKey: ["admin", "acquisitions"] }),
  });

  const resolveFbMut = useMutation({
    mutationFn: (id: string) =>
      client.post("/admin/beta-feedback/{feedback_id}/resolve", {
        params: { path: { feedback_id: id } },
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["admin", "beta-feedback"] });
      void queryClient.invalidateQueries({ queryKey: ["admin", "platform-stats"] });
      setAction({ kind: "notice", text: "FB を対応済みにしました。" });
    },
    onError: () =>
      setAction({ kind: "error", text: "FB の更新に失敗しました。" }),
  });

  const recordCostMut = useMutation({
    mutationFn: (v: { name: string; amountYen: number; description?: string }) =>
      client.post("/admin/costs", {
        body: {
          month: new Date().toISOString().slice(0, 10),
          name: v.name,
          amount_yen: v.amountYen,
          ...(v.description ? { description: v.description } : {}),
        },
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["admin", "costs"] });
      setAction({ kind: "notice", text: "コストを記録しました。" });
    },
    onError: () =>
      setAction({ kind: "error", text: "コストの記録に失敗しました。" }),
  });

  const deleteCostMut = useMutation({
    mutationFn: (id: string) =>
      client.delete("/admin/costs/{cost_id}", {
        params: { path: { cost_id: id } },
      }),
    onSuccess: () =>
      void queryClient.invalidateQueries({ queryKey: ["admin", "costs"] }),
  });

  if (isForbidden(dashboard.error) || isForbidden(activity.error)) {
    return (
      <p role="alert" className="text-body-md text-error">
        運営ダッシュボードにアクセスする権限がありません（運営 admin 専用）。
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
  if (dashboard.isLoading) {
    return <Loading className="py-md" />;
  }

  const d = dashboard.data ?? {};
  const s = stats.data;
  const kpis: AdminKpi[] = [
    {
      id: "workspaces",
      label: "ワークスペース数",
      value: d.workspace_count ?? 0,
      ...(s ? { sub: `+${s.workspaces_added_30d}（30 日）` } : {}),
    },
    { id: "projects", label: "プロジェクト数", value: d.project_count ?? 0 },
    { id: "employees", label: "AI 社員数", value: d.ai_employee_count ?? 0 },
    {
      id: "audit24",
      label: "監査イベント (24h)",
      value: d.audit_log_count_24h ?? 0,
    },
    ...(s
      ? [
          {
            id: "exec30",
            label: "タスク実行 / 30日",
            value: s.task_executions_30d,
            ...(s.avg_score_30d != null
              ? { sub: `平均スコア ${s.avg_score_30d.toFixed(2)}` }
              : {}),
          },
          {
            id: "fb",
            label: "ベータ FB 件数",
            value: s.beta_feedback_total,
            sub: `未対応 ${s.beta_feedback_open}`,
          },
          {
            id: "bridge",
            label: "稼働 Bridge 数",
            value: s.bridge_connected,
            sub: `/ ${s.users_total} ユーザー中`,
          },
          {
            id: "churn",
            label: "退会・削除（30日）",
            value: s.users_deleted_30d,
          },
        ]
      : []),
  ];

  const emailOf = new Map(
    (users.data ?? []).map((u) => [u.id, u.email] as const),
  );

  const recent: AdminActivity[] = (activity.data ?? [])
    .slice(0, 10)
    .map((a) => ({
      id: a.id,
      ts: a.created_at.slice(0, 16).replace("T", " "),
      action: a.action,
      actor: emailOf.get(a.actor_id) ?? a.actor_id.slice(0, 8),
    }));

  const m = mission.data;

  return (
    <AdminDashboard
      kpis={kpis}
      recent={recent}
      {...(m
        ? {
            mission: {
              goal: m.goal
                ? {
                    title: m.goal.title,
                    targetCount: m.goal.target_count,
                    deadline: m.goal.deadline,
                    note: m.goal.note ?? null,
                  }
                : null,
              currentCount: m.current_count,
              added30d: m.added_30d,
              remaining: m.remaining ?? null,
              monthsLeft: m.months_left ?? null,
              neededPerMonth: m.needed_per_month ?? null,
            },
            onSaveGoal: (v: GoalFormValues) => goalMut.mutate(v),
            savingGoal: goalMut.isPending,
          }
        : {})}
      {...(trends.data
        ? {
            trends: trends.data.points.map((p) => ({
              weekStart: p.week_start,
              workspaces: p.workspaces,
              projects: p.projects,
            })),
            billingEnabled: trends.data.billing_enabled,
          }
        : {})}
      {...(acquisitions.data
        ? {
            channels: acquisitions.data.channels,
            channelRecent: acquisitions.data.recent.map((r) => ({
              id: r.id,
              channel: r.channel,
              note: r.note,
              occurredOn: r.occurred_on,
            })),
            channelRange,
            onChannelRange: setChannelRange,
            onRecordAcquisition: (ch: string) => recordAcqMut.mutate(ch),
            onDeleteAcquisition: (id: string) => deleteAcqMut.mutate(id),
          }
        : {})}
      {...(health.data && health.data.length > 0 ? { health: health.data } : {})}
      {...(feedback.data
        ? {
            feedback: feedback.data.map((f) => ({
              id: f.id,
              email: f.email,
              category: f.category,
              content: f.content,
              status: f.status,
              createdAt: dateLabel(f.created_at),
            })),
            feedbackOpenCount: s?.beta_feedback_open ?? 0,
            feedbackFilter,
            onFeedbackFilter: setFeedbackFilter,
            onResolveFeedback: (id: string) => resolveFbMut.mutate(id),
          }
        : {})}
      {...(costs.data
        ? {
            costs: costs.data.items.map((c) => ({
              id: c.id,
              name: c.name,
              description: c.description,
              amountYen: c.amount_yen,
            })),
            costTotalYen: costs.data.total_yen,
            costMonthLabel: costs.data.month.slice(0, 7).replace("-", " 年 ") + " 月",
            onRecordCost: (v: { name: string; amountYen: number; description?: string }) =>
              recordCostMut.mutate(v),
            onDeleteCost: (id: string) => deleteCostMut.mutate(id),
          }
        : {})}
      actionNotice={action?.kind === "notice" ? action.text : undefined}
      actionError={action?.kind === "error" ? action.text : undefined}
    />
  );
}
