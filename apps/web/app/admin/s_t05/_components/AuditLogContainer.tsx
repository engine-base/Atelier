/**
 * S-T05 監査ログ コンテナ — T-UC-34 (実 admin API 配線)
 *
 * GET /admin/audit-logs（運営 admin 専用・read-only）を取得し AuditLogTable に渡す。
 * loading/empty/error/403 対応。api client は prop 注入可能 (テスト時に fake を渡す)。
 */

"use client";

import * as React from "react";
import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";

import { ApiError, type ApiClient } from "@atelier/api-client";

import { createAuthedApiClient } from "../../../../lib/auth/connector";
import { AuditLogTable, type AuditEntry } from "./AuditLogTable";

type ActorType = AuditEntry["actor_type"];
const ACTORS: readonly ActorType[] = ["user", "ai", "system", "anonymous"];

interface ApiAudit {
  id: string;
  action: string;
  actor_type: string;
  actor_id: string;
  target_type: string;
  target_id?: string | null;
  ip_address?: string | null;
  created_at: string;
}

function toActor(t: string): ActorType {
  return (ACTORS as readonly string[]).includes(t)
    ? (t as ActorType)
    : "system";
}

export interface AuditLogContainerProps {
  readonly client?: ApiClient;
}

function isForbidden(error: unknown): boolean {
  return error instanceof ApiError && error.status === 403;
}

export function AuditLogContainer({
  client: injected,
}: AuditLogContainerProps) {
  const client = useMemo(() => injected ?? createAuthedApiClient(), [injected]);

  const list = useQuery({
    queryKey: ["admin", "audit-logs"],
    queryFn: async () => {
      const res = await client.get("/admin/audit-logs");
      return (res as { data?: ApiAudit[] }).data ?? [];
    },
    retry: false,
  });

  if (isForbidden(list.error)) {
    return (
      <p role="alert" className="text-body-md text-error">
        監査ログにアクセスする権限がありません（運営 admin 専用）。
      </p>
    );
  }
  if (list.error) {
    return (
      <p role="alert" className="text-body-md text-error">
        監査ログの取得に失敗しました。
      </p>
    );
  }
  if (list.isLoading) {
    return <p className="text-body-md text-surface">読み込み中…</p>;
  }

  const rows = list.data ?? [];
  if (rows.length === 0) {
    return <p className="text-body-md text-surface">監査ログがありません。</p>;
  }

  const entries: AuditEntry[] = rows.map((r) => ({
    id: r.id,
    action: r.action,
    actor_type: toActor(r.actor_type),
    actor_id: r.actor_id,
    target_type: r.target_type,
    target_id: r.target_id ?? "",
    ip_address: r.ip_address ?? null,
    created_at: r.created_at,
  }));

  return <AuditLogTable entries={entries} />;
}
