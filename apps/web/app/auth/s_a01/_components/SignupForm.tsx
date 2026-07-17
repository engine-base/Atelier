/**
 * S-A01 サインアップフォーム — T-UC-01 (client component)
 *
 * - メール + パスワード + パスワード確認 + 利用規約同意 (F-LEGAL-004)
 * - 同意チェックは Atelier 必達 (consents 配列で API に送る)
 */

"use client";

import * as React from "react";
import { z } from "zod";

import { Field } from "../../../../components/forms/Field";
import { Form, useAtelierForm } from "../../../../components/forms/Form";
import { t } from "../../../../lib/i18n";

const Schema = z
  .object({
    email: z.string().email("メール形式で入力してください"),
    password: z.string().min(8, "パスワードは 8 文字以上"),
    confirm: z.string().min(8),
    consent: z.literal(true, {
      errorMap: () => ({
        message: "利用規約とプライバシーポリシーへの同意が必要です",
      }),
    }),
  })
  .refine((d) => d.password === d.confirm, {
    message: "パスワード確認が一致しません",
    path: ["confirm"],
  });
export type SignupValues = z.infer<typeof Schema>;

export interface SignupFormProps {
  readonly onSubmit: (v: SignupValues) => Promise<void> | void;
  readonly serverError?: string | null;
}

export function SignupForm({ onSubmit, serverError }: SignupFormProps) {
  const form = useAtelierForm({
    schema: Schema,
    defaultValues: {
      email: "",
      password: "",
      confirm: "",
      consent: false as unknown as true,
    },
  });

  return (
    <Form form={form} onValid={onSubmit} className="w-full gap-4">
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
          autoComplete="new-password"
          {...form.register("password")}
          className="w-full rounded-md border border-transparent bg-surface-variant px-3.5 py-2.5 text-sm text-on-surface transition-colors focus:border-primary focus:bg-white focus:outline-none focus:ring-2 focus:ring-primary-container"
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
          {...form.register("confirm")}
          className="w-full rounded-md border border-transparent bg-surface-variant px-3.5 py-2.5 text-sm text-on-surface transition-colors focus:border-primary focus:bg-white focus:outline-none focus:ring-2 focus:ring-primary-container"
        />
      </Field>
      {/* 同意行 (モックの consent-row) */}
      <div>
        <label className="flex items-start gap-2.5 rounded-md bg-surface-variant p-3 text-xs leading-relaxed text-on-surface-variant">
          <input
            type="checkbox"
            {...form.register("consent")}
            className="mt-0.5 shrink-0"
          />
          <span>{t("auth.consent")}</span>
        </label>
        {form.formState.errors.consent?.message ? (
          <span role="alert" className="mt-1 block text-xs text-error">
            {form.formState.errors.consent.message}
          </span>
        ) : null}
      </div>
      <button
        type="submit"
        disabled={form.formState.isSubmitting}
        className="inline-flex w-full items-center justify-center gap-1.5 rounded-md bg-primary px-6 py-3 text-sm font-semibold text-on-primary transition-colors hover:bg-[#1E54D8] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-container disabled:opacity-50"
      >
        {t("auth.signup")}
      </button>
    </Form>
  );
}
