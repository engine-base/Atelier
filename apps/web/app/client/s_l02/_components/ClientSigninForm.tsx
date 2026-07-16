/**
 * S-L02 クライアントサインインフォーム — T-UC-21
 *
 * 招待トークン (URL クエリ ?token=...) を入力 or 自動展開、display_name 任意。
 * R-T08 互換: 専用 client_portal JWT を発行 (T-A-35)、別 cookie 分離。
 *
 * 見た目は 06_mockups/client/S-L02-signin.html の白い auth-card に忠実:
 *   有効期限バー → 見出し → 説明 → 入力 → 「プロジェクトを開く」ボタン。
 * 認証機構 (フィールド・register・onSubmit・バリデーション・error 表示) は不変。
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

/** モック .input を踏襲: surface-variant 地・focus で白 + primary リング。 */
const INPUT_CLASS =
  "w-full rounded-md border border-transparent bg-surface-variant px-[14px] py-[10px] text-body-md text-on-surface transition-colors focus:border-primary focus:bg-white focus:outline-none focus:shadow-[0_0_0_3px_var(--color-primary-container)]";

function ClockIcon() {
  return (
    <svg
      aria-hidden="true"
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="shrink-0"
    >
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7v5l3 2" />
    </svg>
  );
}

function ArrowRightIcon() {
  return (
    <svg
      aria-hidden="true"
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M5 12h14" />
      <path d="m13 6 6 6-6 6" />
    </svg>
  );
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
      className="rounded-lg border border-border bg-white px-8 py-7"
    >
      {/* 有効期限バー */}
      <div className="flex items-center justify-center gap-2 rounded-md bg-secondary-container px-2 py-2 text-[12px] text-on-secondary-container">
        <ClockIcon />
        <span>
          このリンクの有効期限は{" "}
          <strong className="font-bold">残り 4 日</strong> です
        </span>
      </div>

      {/* 見出し + 説明 */}
      <div className="flex flex-col gap-xs">
        <h2 className="text-base font-bold text-on-surface">
          クライアントポータルへサインイン
        </h2>
        <p className="text-[13px] leading-relaxed text-on-surface-variant">
          この招待リンクから、プロジェクトの進捗・成果物・モックを
          <strong className="font-semibold text-on-surface">
            閲覧・コメント
          </strong>
          できます。編集はできません。
        </p>
      </div>

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
        <input {...form.register("invitation_token")} className={INPUT_CLASS} />
      </Field>

      <Field
        label="表示名 (任意)"
        error={form.formState.errors.display_name?.message}
      >
        <input {...form.register("display_name")} className={INPUT_CLASS} />
      </Field>

      <button
        type="submit"
        disabled={form.formState.isSubmitting}
        className="inline-flex w-full items-center justify-center gap-2 rounded-md bg-primary px-6 py-3 text-label-lg font-semibold text-primary-fg transition-colors hover:bg-[#1E54D8] focus-visible:outline-none disabled:opacity-50"
      >
        <span>プロジェクトを開く</span>
        <ArrowRightIcon />
      </button>
    </Form>
  );
}
