/**
 * S-C01 AI 社員組織図 コンテナ — T-UC-06 (実 ai-employees API 配線)
 *
 * GET /ai-employees を取得し department 別に OrgChart へ渡す。社員クリックで onSelect。
 * loading/empty/error/403 対応。api client は prop 注入可能 (テスト時に fake を渡す)。
 */

"use client";

import * as React from "react";
import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";

import { ApiError, type ApiClient } from "@atelier/api-client";

import { type EmployeeId } from "../../../../components/EmployeeIcon";
import { createAuthedApiClient } from "../../../../lib/auth/connector";
import { OrgChart, type Department, type OrgNode } from "./OrgChart";

const DEPARTMENTS: readonly Department[] = [
  "executive",
  "sales",
  "product",
  "architecture",
  "design",
  "dev_qa",
  "cross_functional",
];

interface ApiEmployee {
  id: string;
  name: string;
  display_name: string;
  department: string;
}

function toDept(d: string): Department {
  return (DEPARTMENTS as readonly string[]).includes(d)
    ? (d as Department)
    : "cross_functional";
}

export interface OrgChartContainerProps {
  readonly client?: ApiClient;
  readonly onSelect?: (id: EmployeeId) => void;
}

function isForbidden(error: unknown): boolean {
  return error instanceof ApiError && error.status === 403;
}

export function OrgChartContainer({
  client: injected,
  onSelect,
}: OrgChartContainerProps) {
  const client = useMemo(() => injected ?? createAuthedApiClient(), [injected]);

  const list = useQuery({
    queryKey: ["ai-employees", "org"],
    queryFn: async () => {
      const res = await client.get("/ai-employees");
      return (res as { data?: ApiEmployee[] }).data ?? [];
    },
    retry: false,
  });

  if (isForbidden(list.error)) {
    return (
      <p role="alert" className="text-body-md text-error">
        AI 社員にアクセスする権限がありません。
      </p>
    );
  }
  if (list.error) {
    return (
      <p role="alert" className="text-body-md text-error">
        AI 社員の取得に失敗しました。
      </p>
    );
  }
  if (list.isLoading) {
    return <p className="text-body-md text-on-surface-variant">読み込み中…</p>;
  }

  const emps = list.data ?? [];
  if (emps.length === 0) {
    return (
      <p className="text-body-md text-on-surface-variant">
        AI 社員がいません。
      </p>
    );
  }

  const nodes: OrgNode[] = emps.map((e) => ({
    id: (e.name || e.id) as EmployeeId,
    displayName: e.display_name,
    department: toDept(e.department),
  }));

  return <OrgChart nodes={nodes} onSelect={onSelect} />;
}
