/**
 * 横断: ユーザープロフィール画面 — T-UC-37
 *
 * email / display_name / avatar 表示、変更フォーム。
 */

'use client';

import * as React from 'react';
import { z } from 'zod';

import { Field } from '../../components/forms/Field';
import { Form, useAtelierForm } from '../../components/forms/Form';
import { Avatar } from '../../components/Avatar';
import { t } from '../../lib/i18n';

const Schema = z.object({
  display_name: z.string().min(1).max(100),
  email: z.string().email(),
});

export default function UC37Page() {
  const form = useAtelierForm({
    schema: Schema,
    defaultValues: { display_name: '', email: '' },
  });
  const name = form.watch('display_name') || form.watch('email') || 'User';

  return (
    <div className="mx-auto flex w-full max-w-xl flex-col gap-lg px-md py-lg">
      <header className="flex items-center gap-md">
        <Avatar name={name} size="lg" />
        <h1 className="text-headline-md font-bold text-on-surface">プロフィール</h1>
      </header>
      <Form form={form} onValid={async () => undefined}>
        <Field label="表示名" required error={form.formState.errors.display_name?.message}>
          <input
            {...form.register('display_name')}
            className="h-10 rounded-md border border-surface-variant bg-surface px-sm text-body-md text-on-surface"
          />
        </Field>
        <Field label={t('auth.email')} required error={form.formState.errors.email?.message}>
          <input
            type="email"
            {...form.register('email')}
            className="h-10 rounded-md border border-surface-variant bg-surface px-sm text-body-md text-on-surface"
          />
        </Field>
        <button
          type="submit"
          className="inline-flex h-10 w-fit items-center rounded-md bg-primary px-md text-label-lg text-primary-fg"
        >
          {t('common.save')}
        </button>
      </Form>
    </div>
  );
}
