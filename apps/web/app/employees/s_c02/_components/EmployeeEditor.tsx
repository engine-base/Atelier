/**
 * S-C02 AI 社員詳細・編集 — T-UC-07
 *
 * EmployeeIcon + 表示名 + role + system prompt 編集。
 * archived フラグで論理削除 (実 API は別 PR)。
 */

'use client';

import * as React from 'react';
import { z } from 'zod';

import { EmployeeIcon, type EmployeeId } from '../../../../components/EmployeeIcon';
import { Field } from '../../../../components/forms/Field';
import { Form, useAtelierForm } from '../../../../components/forms/Form';

const Schema = z.object({
  display_name: z.string().min(1, '入力必須').max(100),
  role: z.enum(['executive', 'engineer', 'pm', 'specialist']),
  system_prompt: z.string().max(4000),
  archived: z.boolean(),
});
export type EmployeeValues = z.infer<typeof Schema>;

export interface EmployeeEditorProps {
  readonly employeeId: EmployeeId;
  readonly defaultValues: EmployeeValues;
  readonly onSubmit: (v: EmployeeValues) => Promise<void> | void;
}

export function EmployeeEditor({ employeeId, defaultValues, onSubmit }: EmployeeEditorProps) {
  const form = useAtelierForm({ schema: Schema, defaultValues });
  return (
    <section className="flex flex-col gap-lg">
      <header className="flex items-center gap-md">
        <EmployeeIcon employeeId={employeeId} size="lg" />
        <h1 className="text-headline-md font-bold text-on-surface">AI 社員詳細・編集</h1>
      </header>
      <Form form={form} onValid={onSubmit} className="gap-md">
        <Field label="表示名" required error={form.formState.errors.display_name?.message}>
          <input
            {...form.register('display_name')}
            className="h-10 rounded-md border border-surface-variant bg-surface px-sm text-body-md text-on-surface"
          />
        </Field>
        <Field label="役割" required error={form.formState.errors.role?.message}>
          <select
            {...form.register('role')}
            className="h-10 rounded-md border border-surface-variant bg-surface px-sm text-body-md text-on-surface"
          >
            <option value="executive">エグゼクティブ</option>
            <option value="engineer">エンジニア</option>
            <option value="pm">プロジェクト マネージャー</option>
            <option value="specialist">スペシャリスト</option>
          </select>
        </Field>
        <Field label="System prompt" error={form.formState.errors.system_prompt?.message}>
          <textarea
            {...form.register('system_prompt')}
            rows={6}
            className="rounded-md border border-surface-variant bg-surface px-sm py-xs text-body-sm font-mono text-on-surface"
          />
        </Field>
        <Field label="アーカイブ">
          <label className="flex items-center gap-sm text-body-md">
            <input type="checkbox" {...form.register('archived')} />
            <span>このAI 社員をアーカイブする</span>
          </label>
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
