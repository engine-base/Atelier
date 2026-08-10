/**
 * S-T03 AI 社員テンプレ コンテナ — T-UC-32 / GAP-031⑤ (実 admin API 配線)
 *
 * GET /admin/ai-employee-templates（運営 admin 専用）で一覧＋選択テンプレの詳細、
 * GET /admin/skills でスキル pills のラベル解決と「スキル追加」候補、
 * GET /admin/ai-employee-templates/{id}/deployment で実展開先カウント、
 * PATCH /admin/ai-employee-templates/{id} で部分更新（保存 = version 自動
 * increment + ai_employees.template_id 参照経由で全 WS 反映）。
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
  TemplateEditor,
  TemplateList,
  type SkillOption,
  type Template,
  type TemplateEditorPatch,
  type TemplateEditorTemplate,
} from "./TemplateList";

interface ApiTemplate {
  id: string;
  default_name?: string;
  default_display_name?: string;
  department?: string;
  role: string;
  specialty?: string;
  system_prompt?: string;
  version?: number;
  default_skills?: string[];
  default_knowledge_cats?: string[];
}

interface ApiSkill {
  id: string;
  name?: string;
  version?: string;
}

interface ApiDeployment {
  template_id?: string;
  workspace_count?: number;
  employee_count?: number;
}

export interface TemplateListContainerProps {
  readonly client?: ApiClient;
}

function isForbidden(error: unknown): boolean {
  return error instanceof ApiError && error.status === 403;
}

export function TemplateListContainer({
  client: injected,
}: TemplateListContainerProps) {
  const client = useMemo(() => injected ?? createAuthedApiClient(), [injected]);
  const queryClient = useQueryClient();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [action, setAction] = useState<{
    kind: "notice" | "error";
    text: string;
  } | null>(null);

  const list = useQuery({
    queryKey: ["admin", "ai-employee-templates"],
    queryFn: async () => {
      const res = await client.get("/admin/ai-employee-templates");
      const data = (res as { data?: unknown }).data;
      return Array.isArray(data) ? (data as ApiTemplate[]) : [];
    },
    retry: false,
  });

  const skillsQuery = useQuery({
    queryKey: ["admin", "skills", "for-template-editor"],
    queryFn: async () => {
      const res = await client.get("/admin/skills", {
        params: { query: { include_inactive: false } },
      });
      const data = (res as { data?: unknown }).data;
      return Array.isArray(data) ? (data as ApiSkill[]) : [];
    },
    retry: false,
  });

  const selected: ApiTemplate | null = useMemo(() => {
    const items = list.data ?? [];
    if (items.length === 0) return null;
    return items.find((t) => t.id === selectedId) ?? items[0] ?? null;
  }, [list.data, selectedId]);

  const deploymentQuery = useQuery({
    queryKey: ["admin", "ai-employee-templates", selected?.id, "deployment"],
    enabled: Boolean(selected?.id),
    queryFn: async () => {
      const res = await client.get(
        "/admin/ai-employee-templates/{template_id}/deployment",
        { params: { path: { template_id: selected?.id ?? "" } } },
      );
      const data = (res as { data?: unknown }).data;
      return data && typeof data === "object" ? (data as ApiDeployment) : null;
    },
    retry: false,
  });

  const save = useMutation({
    mutationFn: async (input: {
      templateId: string;
      patch: TemplateEditorPatch;
    }) => {
      const res = await client.patch(
        "/admin/ai-employee-templates/{template_id}",
        {
          params: { path: { template_id: input.templateId } },
          body: input.patch as Record<string, unknown>,
        },
      );
      const data = (res as { data?: unknown }).data;
      return data && typeof data === "object" ? (data as ApiTemplate) : null;
    },
    onSuccess: async (updated) => {
      setAction({
        kind: "notice",
        text: updated?.version
          ? `テンプレを保存しました（v${updated.version} — 全 WS の参照社員に次回利用時から反映）。`
          : "テンプレを保存しました（全 WS の参照社員に次回利用時から反映）。",
      });
      await queryClient.invalidateQueries({
        queryKey: ["admin", "ai-employee-templates"],
      });
    },
    onError: () => {
      setAction({
        kind: "error",
        text: "テンプレの保存に失敗しました。",
      });
    },
  });

  if (isForbidden(list.error)) {
    return (
      <p role="alert" className="text-body-md text-error">
        テンプレートにアクセスする権限がありません（運営 admin 専用）。
      </p>
    );
  }
  if (list.error) {
    return (
      <p role="alert" className="text-body-md text-error">
        テンプレートの取得に失敗しました。
      </p>
    );
  }
  if (list.isLoading) {
    return <Loading className="py-md" />;
  }

  const templates: Template[] = (list.data ?? []).map((t) => ({
    id: t.id,
    name: t.default_display_name || t.default_name || t.id,
    role: t.role,
    description: t.specialty ?? t.system_prompt ?? "",
  }));

  const availableSkills: SkillOption[] = (skillsQuery.data ?? []).map((s) => ({
    id: s.id,
    label: s.version ? `${s.name ?? s.id} v${s.version}` : (s.name ?? s.id),
  }));

  const editorTemplate: TemplateEditorTemplate | null = selected
    ? {
        id: selected.id,
        defaultName: selected.default_name ?? "",
        displayName: selected.default_display_name ?? selected.default_name ?? "",
        department: selected.department ?? "",
        role: selected.role,
        systemPrompt: selected.system_prompt ?? "",
        specialty: selected.specialty ?? "",
        version: selected.version ?? 1,
        skills: selected.default_skills ?? [],
        knowledgeCats: selected.default_knowledge_cats ?? [],
      }
    : null;

  const deployment =
    deploymentQuery.data &&
    typeof deploymentQuery.data.workspace_count === "number" &&
    typeof deploymentQuery.data.employee_count === "number"
      ? {
          workspaceCount: deploymentQuery.data.workspace_count,
          employeeCount: deploymentQuery.data.employee_count,
        }
      : null;

  return (
    <div className="grid gap-4 lg:grid-cols-[minmax(260px,1fr)_2fr]">
      <TemplateList
        templates={templates}
        selectedId={editorTemplate?.id ?? null}
        onSelect={(id) => {
          setSelectedId(id);
          setAction(null);
        }}
      />
      {editorTemplate ? (
        <TemplateEditor
          key={`${editorTemplate.id}:${editorTemplate.version}`}
          template={editorTemplate}
          availableSkills={availableSkills}
          deployment={deployment}
          saving={save.isPending}
          actionNotice={action?.kind === "notice" ? action.text : null}
          actionError={action?.kind === "error" ? action.text : null}
          onSave={(patch) => {
            setAction(null);
            save.mutate({ templateId: editorTemplate.id, patch });
          }}
        />
      ) : null}
    </div>
  );
}
