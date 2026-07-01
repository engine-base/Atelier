/**
 * S-T03 AI 社員テンプレ コンテナ — T-UC-32 (実 admin API 配線)
 *
 * GET /admin/ai-employee-templates（運営 admin 専用・read-only）を取得し TemplateList に渡す。
 * 複製/編集/削除のテンプレ変更 API は未提供のため read-only 表示（アクション列なし）。
 * api client は prop 注入可能 (テスト時に fake を渡す)。
 */

"use client";

import * as React from "react";
import { Loading } from "../../../../components/Loading";
import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";

import { ApiError, type ApiClient } from "@atelier/api-client";

import { createAuthedApiClient } from "../../../../lib/auth/connector";
import { TemplateList, type Template } from "./TemplateList";

interface ApiTemplate {
  id: string;
  default_name?: string;
  default_display_name?: string;
  role: string;
  specialty?: string;
  system_prompt?: string;
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

  const list = useQuery({
    queryKey: ["admin", "ai-employee-templates"],
    queryFn: async () => {
      const res = await client.get("/admin/ai-employee-templates");
      return (res as { data?: ApiTemplate[] }).data ?? [];
    },
    retry: false,
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

  return <TemplateList templates={templates} />;
}
