/**
 * S-C01 AI 社員組織図 コンテナ — T-UC-06 (実 ai-employees API 配線) v2
 *
 * GET /ai-employees を department 別に OrgChart / EmployeeList へ渡す。
 * さらに実データでカードを充実させる (モック .org-card 準拠):
 *   - GET /skills で attached_skills (uuid[]) を名前解決
 *   - GET /ai-employees/templates で specialty (役割ライン) を解決
 * 社員クリックで onSelect。view prop で 組織図 / リスト を切替 (両方実ビュー)。
 * loading/empty/error/403 対応。api client は prop 注入可能 (テスト時に fake を渡す)。
 */

"use client";

import * as React from "react";
import { Loading } from "../../../../components/Loading";
import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";

import { ApiError, type ApiClient } from "@atelier/api-client";

import { type EmployeeId } from "../../../../components/EmployeeIcon";
import { createAuthedApiClient } from "../../../../lib/auth/connector";
import { EmployeeList, type EmployeeListRow } from "./EmployeeList";
import { OrgChart, type Department } from "./OrgChart";

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
  role?: string;
  template_id?: string | null;
  attached_skills?: readonly string[];
  tone_preset?: string;
  icon?: string | null;
}

interface ApiSkill {
  id: string;
  name: string;
}

interface ApiTemplate {
  id: string;
  specialty?: string;
}

function toDept(d: string): Department {
  return (DEPARTMENTS as readonly string[]).includes(d)
    ? (d as Department)
    : "cross_functional";
}

function asArray<T>(v: unknown): T[] {
  return Array.isArray(v) ? (v as T[]) : [];
}

function capitalize(s: string): string {
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : s;
}

/** 役割ライン: COO は specialty 先頭区分を併記、横断 lead は specialty 先頭区分 (例: ナレッジ統括)。 */
function roleLabelOf(
  role: string | undefined,
  department: Department,
  specialty: string | undefined,
): string {
  const head = specialty?.split("・")[0];
  if (role === "coo") return head ? `COO · ${head}` : "COO";
  if (role === "lead")
    return department === "cross_functional" ? (head ?? "統括") : "部長";
  return "メンバー";
}

export interface OrgChartContainerProps {
  readonly client?: ApiClient;
  readonly onSelect?: (id: string) => void;
  /** 組織図 / リスト (view-toggle は page 側)。 */
  readonly view?: "org" | "list";
}

function isForbidden(error: unknown): boolean {
  return error instanceof ApiError && error.status === 403;
}

export function OrgChartContainer({
  client: injected,
  onSelect,
  view = "org",
}: OrgChartContainerProps) {
  const client = useMemo(() => injected ?? createAuthedApiClient(), [injected]);

  const list = useQuery({
    queryKey: ["ai-employees", "org"],
    queryFn: async () => {
      const res = await client.get("/ai-employees");
      return asArray<ApiEmployee>((res as { data?: unknown }).data);
    },
    retry: false,
  });

  // 補助データ (失敗しても組織図自体は出す — 名前解決だけ落ちる)
  const skillsQuery = useQuery({
    queryKey: ["skills", "catalog"],
    queryFn: async () => {
      const res = await client.get("/skills", {
        params: { query: { limit: 200 } },
      });
      return asArray<ApiSkill>((res as { data?: unknown }).data);
    },
    retry: false,
  });
  const templatesQuery = useQuery({
    queryKey: ["ai-employees", "templates"],
    queryFn: async () => {
      const res = await client.get("/ai-employees/templates", {});
      return asArray<ApiTemplate>((res as { data?: unknown }).data);
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
    return <Loading className="py-md" />;
  }

  const emps = list.data ?? [];
  if (emps.length === 0) {
    return (
      <p className="text-body-md text-on-surface-variant">
        AI 社員がいません。
      </p>
    );
  }

  const skillNameById = new Map(
    (skillsQuery.data ?? []).map((s) => [s.id, s.name]),
  );
  const specialtyByTemplate = new Map(
    (templatesQuery.data ?? []).map((t) => [t.id, t.specialty]),
  );

  const rows: EmployeeListRow[] = emps.map((e) => {
    const dept = toDept(e.department);
    const specialty = e.template_id
      ? specialtyByTemplate.get(e.template_id)
      : undefined;
    const skills = (e.attached_skills ?? [])
      .map((id) => skillNameById.get(id))
      .filter((n): n is string => Boolean(n));
    return {
      id: (e.name || e.id) as EmployeeId, // persona (アイコン表示用)
      selectId: e.id, // 遷移用 実UUID (name を渡すと GET /ai-employees/{id} が失敗する)
      displayName: e.display_name,
      department: dept,
      enName: capitalize(e.name),
      roleLabel: roleLabelOf(e.role, dept, specialty),
      // /skills 未取得 (エラー等) の間は行を出さない (undefined = 非表示)
      ...(skillsQuery.data !== undefined ? { skills } : {}),
      ...(e.tone_preset ? { tonePreset: e.tone_preset } : {}),
      ...(e.icon ? { iconName: e.icon } : {}),
    };
  });

  return view === "list" ? (
    <EmployeeList rows={rows} onSelect={onSelect} />
  ) : (
    <OrgChart nodes={rows} onSelect={onSelect} />
  );
}
