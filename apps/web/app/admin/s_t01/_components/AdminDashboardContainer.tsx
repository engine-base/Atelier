/**
 * S-T01 運営ダッシュボード コンテナ — T-UC-30 (実 admin API 配線)
 *
 * GET /admin/dashboard の集計を KPI タイルへ、GET /admin/audit-logs の直近を
 * 「最近のアクティビティ」へマップする。いずれも運営 admin 専用 (403)。
 * api client は prop 注入可能 (テスト時に fake を渡す)。
 */

"use client";

import * as React from "react";
import { Loading } from "../../../../components/Loading";
import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";

import { ApiError, type ApiClient } from "@atelier/api-client";

import { createAuthedApiClient } from "../../../../lib/auth/connector";
import {
  AdminDashboard,
  type AdminActivity,
  type AdminKpi,
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

export interface AdminDashboardContainerProps {
  readonly client?: ApiClient;
}

function isForbidden(error: unknown): boolean {
  return error instanceof ApiError && error.status === 403;
}

export function AdminDashboardContainer({
  client: injected,
}: AdminDashboardContainerProps) {
  const client = useMemo(() => injected ?? createAuthedApiClient(), [injected]);

  const dashboard = useQuery({
    queryKey: ["admin", "dashboard"],
    queryFn: async () => {
      const res = await client.get("/admin/dashboard");
      return (res as { data?: ApiDashboard }).data ?? {};
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
  const kpis: AdminKpi[] = [
    {
      id: "workspaces",
      label: "ワークスペース数",
      value: d.workspace_count ?? 0,
    },
    { id: "projects", label: "プロジェクト数", value: d.project_count ?? 0 },
    { id: "employees", label: "AI 社員数", value: d.ai_employee_count ?? 0 },
    {
      id: "audit24",
      label: "監査イベント (24h)",
      value: d.audit_log_count_24h ?? 0,
    },
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

  return <AdminDashboard kpis={kpis} recent={recent} />;
}
