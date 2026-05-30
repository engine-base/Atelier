/**
 * S-A01 サインインフォーム — T-UC-01 (client component)
 *
 * - メール / パスワード ログイン
 * - マジックリンク 送信トリガ (別ボタン)
 * - lockout 警告 (5 連続失敗 = 15分ロック、サーバが 423 で返す想定)
 * - i18n / Form (RHF + Zod、Bundle C) / Field を活用
 *
 * 実 API 呼び出しは onSubmit prop に委譲 (コンテナ側で createApiClient を構築)。
 * 本コンポーネントは UI のみ責務とする。
 */

'use client';

import * as React from 'react';
import { z } from 'zod';

import { Field } from '../../../../components/forms/Field';
import { Form, useAtelierForm } from '../../../../components/forms/Form';
import { t } from '../../../../lib/i18n';

const Schema = z.object({
  email: z.string().email('メール形式で入力してください'),
  password: z.string().min(8, 'パスワードは 8 文字以上'),
});
export type SigninValues = z.infer<typeof Schema>;

export interface SigninFormProps {
  readonly onSubmit: (v: SigninValues) => Promise<void> | void;
  readonly onMagicLink?: (email: string) => void;
  readonly serverError?: string | null;
  readonly locked?: boolean;
}

export function SigninForm({ onSubmit, onMagicLink, serverError, locked }: SigninFormProps) {
  const form = useAtelierForm({ schema: Schema, defaultValues: { email: '', password: '' } });
  const email = form.watch('email');

  return (
    <Form form={form} onValid={onSubmit} className="mx-auto w-full max-w-md gap-md">
      <h1 className="text-headline-md font-bold text-on-surface">{t('auth.signin')}</h1>
      {locked ? (
        <p role="alert" className="text-label-lg text-error">
          {t('auth.lockoutMessage')}
        </p>
      ) : null}
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
          autoComplete="current-password"
          {...form.register('password')}
          className="h-10 rounded-md border border-surface-variant bg-surface px-sm text-body-md text-on-surface"
        />
      </Field>
      <div className="flex items-center justify-between gap-md">
        <button
          type="submit"
          disabled={locked || form.formState.isSubmitting}
          className="inline-flex h-10 items-center rounded-md bg-primary px-md text-label-lg text-primary-fg disabled:opacity-50"
        >
          {t('auth.signin')}
        </button>
        {onMagicLink ? (
          <button
            type="button"
            disabled={!email || locked}
            onClick={() => onMagicLink(email)}
            className="text-label-md text-primary hover:underline disabled:opacity-50"
          >
            {t('auth.magicLink')}
          </button>
        ) : null}
      </div>
    </Form>
  );
}
