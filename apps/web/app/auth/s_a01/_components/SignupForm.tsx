/**
 * S-A01 サインアップフォーム — T-UC-01 (client component)
 *
 * - メール + パスワード + パスワード確認 + 利用規約同意 (F-LEGAL-004)
 * - 同意チェックは Atelier 必達 (consents 配列で API に送る)
 */

'use client';

import * as React from 'react';
import { z } from 'zod';

import { Field } from '../../../../components/forms/Field';
import { Form, useAtelierForm } from '../../../../components/forms/Form';
import { t } from '../../../../lib/i18n';

const Schema = z
  .object({
    email: z.string().email('メール形式で入力してください'),
    password: z.string().min(8, 'パスワードは 8 文字以上'),
    confirm: z.string().min(8),
    consent: z.literal(true, {
      errorMap: () => ({ message: '利用規約とプライバシーポリシーへの同意が必要です' }),
    }),
  })
  .refine((d) => d.password === d.confirm, {
    message: 'パスワード確認が一致しません',
    path: ['confirm'],
  });
export type SignupValues = z.infer<typeof Schema>;

export interface SignupFormProps {
  readonly onSubmit: (v: SignupValues) => Promise<void> | void;
  readonly serverError?: string | null;
}

export function SignupForm({ onSubmit, serverError }: SignupFormProps) {
  const form = useAtelierForm({
    schema: Schema,
    defaultValues: { email: '', password: '', confirm: '', consent: false as unknown as true },
  });

  return (
    <Form form={form} onValid={onSubmit} className="mx-auto w-full max-w-md gap-md">
      <h1 className="text-headline-md font-bold text-on-surface">{t('auth.signup')}</h1>
      {serverError ? (
        <p role="alert" className="text-label-lg text-error">
          {serverError}
        </p>
      ) : null}
      <Field label={t('auth.email')} required error={form.formState.errors.email?.message}>
        <input
          type="email"
          autoComplete="email"
          {...form.register('email')}
          className="h-10 rounded-md border border-surface-variant bg-surface px-sm text-body-md text-on-surface"
        />
      </Field>
      <Field label={t('auth.password')} required error={form.formState.errors.password?.message}>
        <input
          type="password"
          autoComplete="new-password"
          {...form.register('password')}
          className="h-10 rounded-md border border-surface-variant bg-surface px-sm text-body-md text-on-surface"
        />
      </Field>
      <Field
        label="パスワード確認"
        required
        error={form.formState.errors.confirm?.message}
      >
        <input
          type="password"
          autoComplete="new-password"
          {...form.register('confirm')}
          className="h-10 rounded-md border border-surface-variant bg-surface px-sm text-body-md text-on-surface"
        />
      </Field>
      <Field label={t('auth.consent')} error={form.formState.errors.consent?.message}>
        <label className="flex items-center gap-sm text-body-md">
          <input type="checkbox" {...form.register('consent')} />
          <span>{t('auth.consent')}</span>
        </label>
      </Field>
      <button
        type="submit"
        disabled={form.formState.isSubmitting}
        className="inline-flex h-10 items-center justify-center rounded-md bg-primary px-md text-label-lg text-primary-fg disabled:opacity-50"
      >
        {t('auth.signup')}
      </button>
    </Form>
  );
}
