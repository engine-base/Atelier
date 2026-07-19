/**
 * S-C02 AI 社員編集 コンテナ — T-UC-07 (実 ai-employees API 配線) v2
 *
 * GET /ai-employees/{id} で初期値を取得し、PATCH /ai-employees/{id}
 * (display_name / tone_preset / custom_tone_text / icon) で更新する。
 * 表示充実 (全て実データ):
 *   - GET /skills で attached_skills (uuid[]) を名前解決 (「できること」チップ)
 *   - GET /ai-employees/templates で specialty (ヘッダのメタ行)
 *   - GET /ai-employees で組織関係を実算出 (レポート対象 / 直属の部下)
 * loading/error/403 対応。api client は prop 注入可能 (テスト時に fake を渡す)。
 */

"use client";

import * as React from "react";
import { Loading } from "../../../../components/Loading";
import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { ApiError, type ApiClient } from "@atelier/api-client";

import { type EmployeeId } from "../../../../components/EmployeeIcon";
import { createAuthedApiClient } from "../../../../lib/auth/connector";
import { DEPT_LABEL } from "../../s_c01/_components/OrgChart";
import {
  EmployeeEditor,
  type EmployeeOrgInfo,
  type EmployeeValues,
} from "./EmployeeEditor";

type TonePreset = EmployeeValues["tone_preset"];
const TONES: readonly TonePreset[] = [
  "polite",
  "friendly",
  "casual",
  "concise",
  "coaching",
];

interface ApiEmployee {
  id?: string;
  name: string;
  display_name: string;
  role: string;
  department: string;
  tone_preset: string;
  custom_tone_text?: string | null;
  icon?: string | null;
  template_id?: string | null;
  attached_skills?: readonly string[] | null;
  attached_knowledge_cats?: readonly string[] | null;
}

interface ApiSkill {
  id: string;
  name: string;
}

interface ApiTemplate {
  id: string;
  specialty?: string;
}

function toTone(preset: string): TonePreset {
  return (TONES as readonly string[]).includes(preset)
    ? (preset as TonePreset)
    : "polite";
}

function asArray<T>(v: unknown): T[] {
  return Array.isArray(v) ? (v as T[]) : [];
}

function deptLabelOf(d: string): string {
  return (DEPT_LABEL as Record<string, string>)[d] ?? d;
}

function roleLabelOf(
  role: string,
  department: string,
  specialty: string | undefined,
): string {
  const head = specialty?.split("・")[0];
  if (role === "coo") return "COO";
  if (role === "lead")
    return department === "cross_functional" ? (head ?? "統括") : "部長";
  return "メンバー";
}

export interface EmployeeEditorContainerProps {
  readonly employeeId: string;
  readonly client?: ApiClient;
  /** チャット開始 (ヘッダ)。page が router.push を注入する。 */
  readonly onStartChat?: () => void;
}

function isForbidden(error: unknown): boolean {
  return error instanceof ApiError && error.status === 403;
}

export function EmployeeEditorContainer({
  employeeId,
  client: injected,
  onStartChat,
}: EmployeeEditorContainerProps) {
  const client = useMemo(() => injected ?? createAuthedApiClient(), [injected]);
  const queryClient = useQueryClient();
  const [serverError, setServerError] = useState<string | null>(null);

  const detail = useQuery({
    queryKey: ["ai-employee", employeeId],
    queryFn: async () => {
      const res = await client.get("/ai-employees/{employee_id}", {
        params: { path: { employee_id: employeeId } },
      });
      return (res as { data?: ApiEmployee }).data ?? null;
    },
    retry: false,
  });

  // 補助データ (失敗しても編集フォーム自体は出す)
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
  const orgQuery = useQuery({
    queryKey: ["ai-employees", "org"],
    queryFn: async () => {
      const res = await client.get("/ai-employees");
      return asArray<ApiEmployee>((res as { data?: unknown }).data);
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

  const updateMut = useMutation({
    mutationFn: (v: EmployeeValues) =>
      client.patch("/ai-employees/{employee_id}", {
        params: { path: { employee_id: employeeId } },
        body: {
          display_name: v.display_name,
          tone_preset: v.tone_preset,
          ...(v.custom_tone_text
            ? { custom_tone_text: v.custom_tone_text }
            : {}),
          // "" はアイコン解除 (頭文字表示に戻す)。描画側は falsy を頭文字にフォールバック。
          ...(v.icon !== undefined ? { icon: v.icon } : {}),
        },
      }),
    onSuccess: () => {
      setServerError(null);
      void queryClient.invalidateQueries({
        queryKey: ["ai-employee", employeeId],
      });
      void queryClient.invalidateQueries({ queryKey: ["ai-employees", "org"] });
    },
    onError: () =>
      setServerError("保存に失敗しました。時間をおいて再試行してください。"),
  });

  if (isForbidden(detail.error)) {
    return (
      <p role="alert" className="text-body-md text-error">
        この AI 社員を編集する権限がありません。
      </p>
    );
  }
  if (detail.error) {
    return (
      <p role="alert" className="text-body-md text-error">
        AI 社員の取得に失敗しました。
      </p>
    );
  }
  if (detail.isLoading || !detail.data) {
    return <Loading className="py-md" />;
  }

  const e = detail.data;
  const defaultValues: EmployeeValues = {
    display_name: e.display_name,
    tone_preset: toTone(e.tone_preset),
    custom_tone_text: e.custom_tone_text ?? "",
    icon: e.icon ?? "",
  };

  // ── 実データでの表示解決 ─────────────────────────────
  const skillNameById = new Map(
    (skillsQuery.data ?? []).map((s) => [s.id, s.name]),
  );
  const skillNames = (e.attached_skills ?? [])
    .map((id) => skillNameById.get(id) ?? null)
    .filter((n): n is string => Boolean(n));

  const specialty = e.template_id
    ? (templatesQuery.data ?? []).find((t) => t.id === e.template_id)?.specialty
    : undefined;

  const org = orgQuery.data ?? [];
  const coo = org.find((x) => x.role === "coo");
  const sameDept = org.filter(
    (x) => x.department === e.department && x.id !== e.id,
  );
  const lead = sameDept.find((x) => x.role === "lead");
  const members = sameDept.filter((x) => x.role === "member");
  const leads = org.filter((x) => x.role === "lead");

  const orgInfo: EmployeeOrgInfo = {
    roleLabel: roleLabelOf(e.role, e.department, specialty),
    deptLabel: deptLabelOf(e.department),
    ...(e.role === "coo"
      ? {
          reportsTo: "あなた（オーナー）",
          subordinates:
            leads.length > 0 ? `部署リーダー ${leads.length} 名` : "なし",
        }
      : e.role === "lead"
        ? {
            ...(coo ? { reportsTo: coo.display_name } : {}),
            subordinates:
              members.length > 0 ? `メンバー ${members.length} 名` : "なし",
          }
        : {
            ...(lead
              ? { reportsTo: lead.display_name }
              : coo
                ? { reportsTo: coo.display_name }
                : {}),
          }),
  };

  return (
    <EmployeeEditor
      employeeId={(e.name || "tony") as EmployeeId}
      name={e.name}
      role={e.role}
      department={e.department}
      attachedSkills={
        skillsQuery.data !== undefined ? skillNames : (e.attached_skills ?? [])
      }
      attachedKnowledgeCats={e.attached_knowledge_cats ?? []}
      defaultValues={defaultValues}
      serverError={serverError}
      specialty={specialty}
      orgInfo={orgInfo}
      onSubmit={(v) => updateMut.mutate(v)}
      {...(onStartChat ? { onStartChat } : {})}
    />
  );
}
