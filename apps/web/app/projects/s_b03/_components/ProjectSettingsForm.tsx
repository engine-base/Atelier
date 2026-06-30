/**
 * S-B03 プロジェクト設定フォーム — T-UC-05
 *
 * - project name / description / client_name 編集
 * - lifecycle (active/paused/archived) 切替
 * - delete (soft-delete + grace) は Danger Zone
 */

"use client";

import * as React from "react";
import { z } from "zod";

import { Field } from "../../../../components/forms/Field";
import { Form, useAtelierForm } from "../../../../components/forms/Form";
import { t } from "../../../../lib/i18n";

const Schema = z.object({
  name: z.string().min(1, "入力必須").max(200),
  client_name: z.string().max(200).optional(),
  description: z.string().max(2000).optional(),
  lifecycle: z.enum(["active", "paused", "archived"]),
});
export type ProjectSettingsValues = z.infer<typeof Schema>;

export interface ProjectSettingsFormProps {
  readonly defaultValues: ProjectSettingsValues;
  readonly onSubmit: (v: ProjectSettingsValues) => Promise<void> | void;
  readonly onDelete?: () => void;
  readonly serverError?: string | null;
}

export function ProjectSettingsForm({
  defaultValues,
  onSubmit,
  onDelete,
  serverError,
}: ProjectSettingsFormProps) {
  const form = useAtelierForm({ schema: Schema, defaultValues });
  return (
    <div className="flex flex-col gap-lg">
      <Form form={form} onValid={onSubmit} className="gap-md">
        <h1 className="text-headline-md font-bold text-on-surface">
          プロジェクト設定
        </h1>
        {serverError ? (
          <p role="alert" className="text-label-lg text-error">
            {serverError}
          </p>
        ) : null}
        <Field
          label="プロジェクト名"
          required
          error={form.formState.errors.name?.message}
        >
          <input
            {...form.register("name")}
            className="h-10 rounded-md border border-surface-variant bg-surface px-sm text-body-md text-on-surface"
          />
        </Field>
        <Field
          label="クライアント名"
          error={form.formState.errors.client_name?.message}
        >
          <input
            {...form.register("client_name")}
            className="h-10 rounded-md border border-surface-variant bg-surface px-sm text-body-md text-on-surface"
          />
        </Field>
        <Field label="説明" error={form.formState.errors.description?.message}>
          <textarea
            {...form.register("description")}
            rows={4}
            className="rounded-md border border-surface-variant bg-surface px-sm py-xs text-body-md text-on-surface"
          />
        </Field>
        <Field
          label="ライフサイクル"
          required
          error={form.formState.errors.lifecycle?.message}
        >
          <select
            {...form.register("lifecycle")}
            className="h-10 rounded-md border border-surface-variant bg-surface px-sm text-body-md text-on-surface"
          >
            <option value="active">進行中</option>
            <option value="paused">一時停止</option>
            <option value="archived">アーカイブ</option>
          </select>
        </Field>
        <button
          type="submit"
          className="inline-flex h-10 w-fit items-center rounded-md bg-primary px-md text-label-lg text-primary-fg"
        >
          {t("common.save")}
        </button>
      </Form>
      {onDelete ? (
        <section
          aria-label="Danger zone"
          className="flex flex-col gap-sm rounded-md border border-error/40 bg-error/5 p-md"
        >
          <h2 className="text-label-lg font-semibold text-error">
            Danger Zone
          </h2>
          <p className="text-body-sm text-on-surface-variant">
            削除後は 30 日間 grace 期間で復元可能 (F-LEGAL-007)。
          </p>
          <button
            type="button"
            onClick={onDelete}
            className="inline-flex h-9 w-fit items-center rounded-md border border-error px-sm text-label-md text-error hover:bg-error/10"
          >
            プロジェクトを削除
          </button>
        </section>
      ) : null}
    </div>
  );
}
