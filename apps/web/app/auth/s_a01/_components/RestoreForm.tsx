/**
 * S-A01 退会済みアカウントの復元フォーム — GAP-233 (T-A-05 の復元導線)
 *
 * 退会 (soft-delete) から 30 日以内なら、メールアドレスとパスワードで
 * POST /auth/account/restore を呼びアカウントを復活させる。
 * 従来この API はどの UI からも呼べず、受付表示の「キャンセル可能」が
 * 実行不能だった。サインイン画面からの導線としてここに置く。
 */

"use client";

import * as React from "react";
import { z } from "zod";

import { Field } from "../../../../components/forms/Field";
import { Form, useAtelierForm } from "../../../../components/forms/Form";

const Schema = z.object({
  email: z.string().email("メール形式で入力してください"),
  password: z.string().min(1, "パスワードを入力してください"),
});
export type RestoreValues = z.infer<typeof Schema>;

export interface RestoreFormProps {
  readonly onSubmit: (v: RestoreValues) => Promise<void> | void;
  readonly serverError?: string | null;
}

const FIELD_CLASS =
  "w-full rounded-md border border-transparent bg-surface-variant px-3.5 py-2.5 text-sm text-on-surface transition-colors focus:border-primary focus:bg-white focus:outline-none focus:ring-2 focus:ring-primary-container";

export function RestoreForm({ onSubmit, serverError }: RestoreFormProps) {
  const form = useAtelierForm({
    schema: Schema,
    defaultValues: { email: "", password: "" },
  });

  return (
    <Form form={form} onValid={onSubmit} className="w-full gap-4">
      <p className="text-sm text-on-surface-variant">
        退会手続きから 30 日以内であれば、アカウントとデータを元に戻せます。
        退会時のメールアドレスとパスワードを入力してください。
      </p>
      {serverError ? (
        <p
          role="alert"
          className="rounded-md border-l-[3px] border-error bg-[#FEE2E2] px-3 py-2 text-xs text-[#991B1B]"
        >
          {serverError}
        </p>
      ) : null}
      <Field
        label="メールアドレス"
        required
        error={form.formState.errors.email?.message}
      >
        <input
          type="email"
          autoComplete="email"
          {...form.register("email")}
          className={FIELD_CLASS}
        />
      </Field>
      <Field
        label="パスワード"
        required
        error={form.formState.errors.password?.message}
      >
        <input
          type="password"
          autoComplete="current-password"
          {...form.register("password")}
          className={FIELD_CLASS}
        />
      </Field>
      <button
        type="submit"
        disabled={form.formState.isSubmitting}
        className="inline-flex w-full items-center justify-center gap-1.5 rounded-md bg-primary px-6 py-3 text-sm font-semibold text-on-primary transition-colors hover:bg-primary-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-container disabled:opacity-50"
      >
        アカウントを復元する
      </button>
    </Form>
  );
}
