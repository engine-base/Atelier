/**
 * S-C02 AI 社員編集 コンテナ — T-UC-07 (実 ai-employees API 配線)
 *
 * GET /ai-employees/{id} で初期値を取得し、PATCH /ai-employees/{id}
 * (display_name / tone_preset / custom_tone_text) で更新する。loading/error/403 対応。
 * api client は prop 注入可能 (テスト時に fake を渡す)。
 */

"use client";

import * as React from "react";
import { Loading } from "../../../../components/Loading";
import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { ApiError, type ApiClient } from "@atelier/api-client";

import { type EmployeeId } from "../../../../components/EmployeeIcon";
import { createAuthedApiClient } from "../../../../lib/auth/connector";
import { EmployeeEditor, type EmployeeValues } from "./EmployeeEditor";

type TonePreset = EmployeeValues["tone_preset"];
const TONES: readonly TonePreset[] = [
  "polite",
  "friendly",
  "casual",
  "concise",
  "coaching",
];

interface ApiEmployee {
  name: string;
  display_name: string;
  role: string;
  department: string;
  tone_preset: string;
  custom_tone_text?: string | null;
  attached_skills?: readonly string[] | null;
  attached_knowledge_cats?: readonly string[] | null;
}

function toTone(preset: string): TonePreset {
  return (TONES as readonly string[]).includes(preset)
    ? (preset as TonePreset)
    : "polite";
}

export interface EmployeeEditorContainerProps {
  readonly employeeId: string;
  readonly client?: ApiClient;
}

function isForbidden(error: unknown): boolean {
  return error instanceof ApiError && error.status === 403;
}

export function EmployeeEditorContainer({
  employeeId,
  client: injected,
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
        },
      }),
    onSuccess: () => {
      setServerError(null);
      void queryClient.invalidateQueries({
        queryKey: ["ai-employee", employeeId],
      });
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
  };

  return (
    <EmployeeEditor
      employeeId={(e.name || "tony") as EmployeeId}
      name={e.name}
      role={e.role}
      department={e.department}
      attachedSkills={e.attached_skills ?? []}
      attachedKnowledgeCats={e.attached_knowledge_cats ?? []}
      defaultValues={defaultValues}
      serverError={serverError}
      onSubmit={(v) => updateMut.mutate(v)}
    />
  );
}
