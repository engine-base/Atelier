/**
 * S-A03 ワークスペース設定フォーム — T-UC-02 (client component)
 *
 * - workspace name 編集 + AI 学習 opt-out トグル (default OFF maintain rule)
 * - 削除は 30 日 grace + danger zone
 */

'use client';

import * as React from 'react';
import { z } from 'zod';

import { Field } from '../../../../components/forms/Field';
import { Form, useAtelierForm } from '../../../../components/forms/Form';
import { t } from '../../../../lib/i18n';

const Schema = z.object({
  name: z.string().min(1, '入力必須').max(100),
  aiLearningOptOut: z.boolean(),
});
export type WorkspaceSettingsValues = z.infer<typeof Schema>;

export interface WorkspaceSettingsFormProps {
  readonly defaultValues: WorkspaceSettingsValues;
  readonly onSubmit: (v: WorkspaceSettingsValues) => Promise<void> | void;
  readonly onDelete?: () => void;
  readonly serverError?: string | null;
}

export function WorkspaceSettingsForm({
  defaultValues,
  onSubmit,
  onDelete,
  serverError,
}: WorkspaceSettingsFormProps) {
  const form = useAtelierForm({ schema: Schema, defaultValues });

  return (
    <div className="flex flex-col gap-lg">
      <Form form={form} onValid={onSubmit} className="gap-md">
        <h1 className="text-headline-md font-bold text-on-surface">
          ワークスペース設定
        </h1>
        {serverError ? (
          <p role="alert" className="text-label-lg text-error">
            {serverError}
          </p>
        ) : null}
        <Field label="名前" required error={form.formState.errors.name?.message}>
          <input
            {...form.register('name')}
            className="h-10 rounded-md border border-surface-variant bg-surface px-sm text-body-md text-on-surface"
          />
        </Field>
        <Field
          label="AI 学習に利用する"
          description="既定では OFF。顧客データを Atelier の AI 改善に使う場合のみ ON にしてください。"
        >
          <label className="flex items-center gap-sm text-body-md">
            <input type="checkbox" {...form.register('aiLearningOptOut')} />
            <span>有効化する</span>
          </label>
        </Field>
        <button
          type="submit"
          className="inline-flex h-10 w-fit items-center rounded-md bg-primary px-md text-label-lg text-primary-fg"
        >
          {t('common.save')}
        </button>
      </Form>
      {onDelete ? (
        <section
          aria-label="Danger zone"
          className="flex flex-col gap-sm rounded-md border border-error/40 bg-error/5 p-md"
        >
          <h2 className="text-label-lg font-semibold text-error">Danger Zone</h2>
          <p className="text-body-sm text-on-surface-variant">
            削除後 30 日間は復元可能です(F-LEGAL-007)。
          </p>
          <button
            type="button"
            onClick={onDelete}
            className="inline-flex h-9 w-fit items-center rounded-md border border-error px-sm text-label-md text-error hover:bg-error/10"
          >
            ワークスペースを削除
          </button>
        </section>
      ) : null}
    </div>
  );
}
