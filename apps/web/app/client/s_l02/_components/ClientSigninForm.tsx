/**
 * S-L02 クライアントサインインフォーム — T-UC-21
 *
 * 招待トークン (URL クエリ ?token=...) を入力 or 自動展開、display_name 任意。
 * R-T08 互換: 専用 client_portal JWT を発行 (T-A-35)、別 cookie 分離。
 */

"use client";

import * as React from "react";
import { z } from "zod";

import { Field } from "../../../../components/forms/Field";
import { Form, useAtelierForm } from "../../../../components/forms/Form";

const Schema = z.object({
  invitation_token: z.string().min(10).max(200),
  display_name: z.string().max(100).optional(),
});
export type ClientSigninValues = z.infer<typeof Schema>;

export interface ClientSigninFormProps {
  readonly defaultToken?: string;
  readonly onSubmit: (v: ClientSigninValues) => Promise<void> | void;
  readonly serverError?: string | null;
}

export function ClientSigninForm({
  defaultToken,
  onSubmit,
  serverError,
}: ClientSigninFormProps) {
  const form = useAtelierForm({
    schema: Schema,
    defaultValues: { invitation_token: defaultToken ?? "", display_name: "" },
  });

  return (
    <Form
      form={form}
      onValid={onSubmit}
      className="mx-auto w-full max-w-md gap-md"
    >
      <h1 className="text-headline-md font-bold text-on-surface">
        クライアントサインイン
      </h1>
      {serverError ? (
        <p role="alert" className="text-label-lg text-error">
          {serverError}
        </p>
      ) : null}
      <Field
        label="招待トークン"
        required
        error={form.formState.errors.invitation_token?.message}
        description="メールでお送りした招待リンクのトークンです"
      >
        <input
          {...form.register("invitation_token")}
          className="h-10 rounded-md border border-surface-variant bg-surface px-sm text-body-md text-on-surface"
        />
      </Field>
      <Field
        label="表示名 (任意)"
        error={form.formState.errors.display_name?.message}
      >
        <input
          {...form.register("display_name")}
          className="h-10 rounded-md border border-surface-variant bg-surface px-sm text-body-md text-on-surface"
        />
      </Field>
      <button
        type="submit"
        disabled={form.formState.isSubmitting}
        className="inline-flex h-10 w-fit items-center rounded-md bg-primary px-md text-label-lg text-primary-fg disabled:opacity-50"
      >
        プロジェクトを開く
      </button>
    </Form>
  );
}
