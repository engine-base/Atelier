/**
 * S-PUB04 データ削除請求 — T-UC-29 (F-LEGAL-007)
 *
 * 退会済ユーザーまたは第三者がデータ削除を請求するフォーム。
 * 30 日 grace を案内、確認のため email 入力を 2 回。
 */

'use client';

import * as React from 'react';
import { z } from 'zod';

import { Field } from '../../../../components/forms/Field';
import { Form, useAtelierForm } from '../../../../components/forms/Form';

const Schema = z
  .object({
    email: z.string().email('メール形式で入力してください'),
    email_confirm: z.string().email('メール形式で入力してください'),
    reason: z.string().max(2000).optional(),
    consent: z.literal(true, {
      errorMap: () => ({ message: '削除に同意してください' }),
    }),
  })
  .refine((d) => d.email === d.email_confirm, {
    message: 'メールアドレスが一致しません',
    path: ['email_confirm'],
  });
export type DeletionValues = z.infer<typeof Schema>;

export interface DataDeletionFormProps {
  readonly onSubmit: (v: DeletionValues) => Promise<void> | void;
}

export function DataDeletionForm({ onSubmit }: DataDeletionFormProps) {
  const form = useAtelierForm({
    schema: Schema,
    defaultValues: {
      email: '',
      email_confirm: '',
      reason: '',
      consent: false as unknown as true,
    },
  });

  return (
    <Form form={form} onValid={onSubmit} className="mx-auto w-full max-w-xl gap-md">
      <h1 className="text-headline-md font-bold text-on-surface">データ削除請求</h1>
      <p className="text-body-md text-on-surface">
        本フォームを送信すると、関連データを <strong>30 日後に完全削除</strong>します
        (F-LEGAL-007)。30 日以内なら復元可能です。
      </p>
      <Field label="メールアドレス" required error={form.formState.errors.email?.message}>
        <input
          type="email"
          {...form.register('email')}
          className="h-10 rounded-md border border-surface-variant bg-surface px-sm text-body-md text-on-surface"
        />
      </Field>
      <Field
        label="メールアドレス確認"
        required
        error={form.formState.errors.email_confirm?.message}
      >
        <input
          type="email"
          {...form.register('email_confirm')}
          className="h-10 rounded-md border border-surface-variant bg-surface px-sm text-body-md text-on-surface"
        />
      </Field>
      <Field label="理由 (任意)" error={form.formState.errors.reason?.message}>
        <textarea
          {...form.register('reason')}
          rows={4}
          className="rounded-md border border-surface-variant bg-surface px-sm py-xs text-body-md text-on-surface"
        />
      </Field>
      <Field label="削除への同意" error={form.formState.errors.consent?.message}>
        <label className="flex items-center gap-sm text-body-md">
          <input type="checkbox" {...form.register('consent')} />
          <span>30 日後の完全削除に同意します</span>
        </label>
      </Field>
      <button
        type="submit"
        className="inline-flex h-10 w-fit items-center rounded-md bg-error px-md text-label-lg text-error-fg"
      >
        削除請求を送信
      </button>
    </Form>
  );
}
