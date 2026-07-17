/**
 * SkillForm — F-007 SKILL.md の新規登録 / 編集フォーム (T-UC-42)
 *
 * 新規(create)時: name / version(semver) / content_md / description / is_active /
 *   allowed_employee_roles を入力。
 * 編集(edit)時: name / version は不変 (API 仕様 SkillUpdate)。content_md 等のみ編集可。
 *
 * 純粋な presentational component。送信は onSubmit prop に委譲する。
 */

"use client";

import * as React from "react";
import { useState } from "react";
import { z } from "zod";

import { Field } from "../../../../components/forms/Field";
import { Form, useAtelierForm } from "../../../../components/forms/Form";
import { AdminButton } from "../../_components/AdminButton";

const SEMVER = /^\d+\.\d+\.\d+$/;

const CreateSchema = z.object({
  name: z.string().min(1, "スキル名は必須です"),
  version: z
    .string()
    .regex(SEMVER, "semver 形式 (例 1.0.0) で入力してください"),
  description: z.string().optional(),
  content_md: z.string().min(1, "SKILL.md の本文は必須です"),
  allowed_employee_roles: z.string().optional(),
  is_active: z.boolean(),
});
export type SkillFormValues = z.infer<typeof CreateSchema>;

export interface SkillFormSubmit {
  readonly name: string;
  readonly version: string;
  readonly description: string | null;
  readonly content_md: string;
  readonly allowed_employee_roles: string[];
  readonly is_active: boolean;
}

export interface SkillFormProps {
  readonly mode: "create" | "edit";
  readonly defaultValues?: Partial<SkillFormValues>;
  readonly onSubmit: (values: SkillFormSubmit) => Promise<void> | void;
  readonly onCancel: () => void;
  readonly submitting?: boolean;
}

function parseRoles(raw: string | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(",")
    .map((r) => r.trim())
    .filter((r) => r.length > 0);
}

export function SkillForm({
  mode,
  defaultValues,
  onSubmit,
  onCancel,
  submitting,
}: SkillFormProps) {
  const isEdit = mode === "edit";
  const form = useAtelierForm({
    schema: CreateSchema,
    defaultValues: {
      name: defaultValues?.name ?? "",
      version: defaultValues?.version ?? "",
      description: defaultValues?.description ?? "",
      content_md: defaultValues?.content_md ?? "",
      allowed_employee_roles: defaultValues?.allowed_employee_roles ?? "",
      is_active: defaultValues?.is_active ?? true,
    },
  });
  const [isActive, setIsActive] = useState<boolean>(
    defaultValues?.is_active ?? true,
  );

  const handleValid = (v: SkillFormValues) => {
    return onSubmit({
      name: v.name,
      version: v.version,
      description: v.description?.trim() ? v.description.trim() : null,
      content_md: v.content_md,
      allowed_employee_roles: parseRoles(v.allowed_employee_roles),
      is_active: isActive,
    });
  };

  return (
    <Form form={form} onValid={handleValid} className="gap-md">
      <Field
        label="スキル名"
        required
        error={form.formState.errors.name?.message}
      >
        <input
          type="text"
          disabled={isEdit}
          {...form.register("name")}
          className="h-10 rounded-md border border-border bg-surface px-sm font-mono text-body-md text-on-surface disabled:opacity-60"
        />
      </Field>
      <Field
        label="バージョン (semver)"
        required
        error={form.formState.errors.version?.message}
        description={
          isEdit
            ? "name/version は編集できません。新バージョンは新規登録してください。"
            : undefined
        }
      >
        <input
          type="text"
          placeholder="1.0.0"
          disabled={isEdit}
          {...form.register("version")}
          className="h-10 rounded-md border border-border bg-surface px-sm text-body-md text-on-surface disabled:opacity-60"
        />
      </Field>
      <Field label="説明" error={form.formState.errors.description?.message}>
        <input
          type="text"
          {...form.register("description")}
          className="h-10 rounded-md border border-border bg-surface px-sm text-body-md text-on-surface"
        />
      </Field>
      <Field
        label="許可ロール (カンマ区切り)"
        error={form.formState.errors.allowed_employee_roles?.message}
      >
        <input
          type="text"
          placeholder="lead, member"
          {...form.register("allowed_employee_roles")}
          className="h-10 rounded-md border border-border bg-surface px-sm text-body-md text-on-surface"
        />
      </Field>
      <Field
        label="SKILL.md 本文"
        required
        error={form.formState.errors.content_md?.message}
      >
        <textarea
          rows={8}
          {...form.register("content_md")}
          className="rounded-md border border-border bg-surface px-sm py-sm font-mono text-body-md text-on-surface"
        />
      </Field>
      <label className="flex items-center gap-sm text-label-lg text-on-surface">
        <input
          type="checkbox"
          checked={isActive}
          onChange={(e) => setIsActive(e.target.checked)}
        />
        有効 (active)
      </label>
      <div className="flex justify-end gap-sm">
        <AdminButton type="button" variant="ghost" onClick={onCancel}>
          キャンセル
        </AdminButton>
        <AdminButton type="submit" variant="primary" disabled={submitting}>
          {isEdit ? "更新" : "登録"}
        </AdminButton>
      </div>
    </Form>
  );
}
