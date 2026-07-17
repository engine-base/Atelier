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

"use client";

import * as React from "react";
import { z } from "zod";

import { Field } from "../../../../components/forms/Field";
import { Form, useAtelierForm } from "../../../../components/forms/Form";
import { t } from "../../../../lib/i18n";

const Schema = z.object({
  email: z.string().email("メール形式で入力してください"),
  password: z.string().min(8, "パスワードは 8 文字以上"),
});
export type SigninValues = z.infer<typeof Schema>;

export interface SigninFormProps {
  readonly onSubmit: (v: SigninValues) => Promise<void> | void;
  readonly onMagicLink?: (email: string) => void;
  readonly serverError?: string | null;
  readonly locked?: boolean;
}

export function SigninForm({
  onSubmit,
  onMagicLink,
  serverError,
  locked,
}: SigninFormProps) {
  const form = useAtelierForm({
    schema: Schema,
    defaultValues: { email: "", password: "" },
  });
  const email = form.watch("email");

  return (
    <Form form={form} onValid={onSubmit} className="w-full gap-4">
      {locked ? (
        <p
          role="alert"
          className="rounded-md border-l-[3px] border-error bg-[#FEE2E2] px-3 py-2 text-xs text-[#991B1B]"
        >
          {t("auth.lockoutMessage")}
        </p>
      ) : null}
      {serverError ? (
        <p
          role="alert"
          className="rounded-md border-l-[3px] border-error bg-[#FEE2E2] px-3 py-2 text-xs text-[#991B1B]"
        >
          {serverError}
        </p>
      ) : null}
      <Field
        label={t("auth.email")}
        required
        error={form.formState.errors.email?.message}
      >
        <input
          type="email"
          autoComplete="email"
          {...form.register("email")}
          className="w-full rounded-md border border-transparent bg-surface-variant px-3.5 py-2.5 text-sm text-on-surface transition-colors focus:border-primary focus:bg-white focus:outline-none focus:ring-2 focus:ring-primary-container"
        />
      </Field>
      <Field
        label={t("auth.password")}
        required
        error={form.formState.errors.password?.message}
      >
        <input
          type="password"
          autoComplete="current-password"
          {...form.register("password")}
          className="w-full rounded-md border border-transparent bg-surface-variant px-3.5 py-2.5 text-sm text-on-surface transition-colors focus:border-primary focus:bg-white focus:outline-none focus:ring-2 focus:ring-primary-container"
        />
      </Field>
      <button
        type="submit"
        disabled={locked || form.formState.isSubmitting}
        className="inline-flex w-full items-center justify-center gap-1.5 rounded-md bg-primary px-6 py-3 text-sm font-semibold text-on-primary transition-colors hover:bg-[#1E54D8] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-container disabled:opacity-50"
      >
        {t("auth.signin")}
      </button>
      {onMagicLink ? (
        <button
          type="button"
          disabled={!email || locked}
          onClick={() => onMagicLink(email)}
          className="inline-flex w-full items-center justify-center rounded-md px-4 py-2.5 text-sm font-semibold text-primary transition-colors hover:bg-primary-container disabled:opacity-50"
        >
          {t("auth.magicLink")}
        </button>
      ) : null}
    </Form>
  );
}
