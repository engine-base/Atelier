/**
 * S-C02 AI 社員詳細・編集 — T-UC-07
 *
 * EmployeeIcon + 表示名 + 口調プリセット(tone_preset) + カスタム口調(custom_tone_text) 編集。
 * 実 API (PATCH /ai-employees/{id}) の編集可能フィールドに揃える。
 */

"use client";

import * as React from "react";
import { z } from "zod";

import {
  EmployeeIcon,
  type EmployeeId,
} from "../../../../components/EmployeeIcon";
import { Field } from "../../../../components/forms/Field";
import { Form, useAtelierForm } from "../../../../components/forms/Form";

const TONE_PRESETS = [
  "polite",
  "friendly",
  "casual",
  "concise",
  "coaching",
] as const;

const TONE_LABEL: Record<(typeof TONE_PRESETS)[number], string> = {
  polite: "丁寧",
  friendly: "フレンドリー",
  casual: "カジュアル",
  concise: "簡潔",
  coaching: "コーチング",
};

const Schema = z.object({
  display_name: z.string().min(1, "入力必須").max(100),
  tone_preset: z.enum(TONE_PRESETS),
  custom_tone_text: z.string().max(500).optional(),
});
export type EmployeeValues = z.infer<typeof Schema>;

export interface EmployeeEditorProps {
  readonly employeeId: EmployeeId;
  readonly defaultValues: EmployeeValues;
  readonly onSubmit: (v: EmployeeValues) => Promise<void> | void;
  readonly serverError?: string | null;
}

export function EmployeeEditor({
  employeeId,
  defaultValues,
  onSubmit,
  serverError,
}: EmployeeEditorProps) {
  const form = useAtelierForm({ schema: Schema, defaultValues });
  return (
    <section className="flex flex-col gap-lg">
      <header className="flex items-center gap-md">
        <EmployeeIcon employeeId={employeeId} size="lg" />
        <h1 className="text-headline-md font-bold text-on-surface">
          AI 社員詳細・編集
        </h1>
      </header>
      <Form form={form} onValid={onSubmit} className="gap-md">
        {serverError ? (
          <p role="alert" className="text-label-lg text-error">
            {serverError}
          </p>
        ) : null}
        <Field
          label="表示名"
          required
          error={form.formState.errors.display_name?.message}
        >
          <input
            {...form.register("display_name")}
            className="h-10 rounded-md border border-surface-variant bg-surface px-sm text-body-md text-on-surface"
          />
        </Field>
        <Field
          label="口調プリセット"
          required
          error={form.formState.errors.tone_preset?.message}
        >
          <select
            {...form.register("tone_preset")}
            className="h-10 rounded-md border border-surface-variant bg-surface px-sm text-body-md text-on-surface"
          >
            {TONE_PRESETS.map((tp) => (
              <option key={tp} value={tp}>
                {TONE_LABEL[tp]}
              </option>
            ))}
          </select>
        </Field>
        <Field
          label="カスタム口調（任意）"
          error={form.formState.errors.custom_tone_text?.message}
        >
          <textarea
            {...form.register("custom_tone_text")}
            rows={4}
            placeholder="プリセットを上書きする口調の指示（最大 500 文字）"
            className="rounded-md border border-surface-variant bg-surface px-sm py-xs text-body-md text-on-surface"
          />
        </Field>
        <button
          type="submit"
          className="inline-flex h-10 w-fit items-center rounded-md bg-primary px-md text-label-lg text-primary-fg"
        >
          保存
        </button>
      </Form>
    </section>
  );
}
