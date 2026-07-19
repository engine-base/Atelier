/**
 * S-PUB04 個人データ削除要求 — T-UC-29 (F-LEGAL-007, design-audit v2)
 *
 * モック 06_mockups/public/S-PUB04-data-deletion.html に忠実:
 *   削除内容 danger カード → 削除スケジュール → 申請フォーム → 他の請求カード。
 *
 * API (POST /public/data-deletion-requests) は認証必須で email は JWT から特定される。
 * そのためフォームの email は「ログイン中のアカウント」の表示専用 (モック通り disabled)。
 * 確認は「削除する」のタイプ入力 + 同意チェック (モック準拠)。
 */

"use client";

import * as React from "react";
import Link from "next/link";
import { z } from "zod";

import { Field } from "../../../../components/forms/Field";
import { Form, useAtelierForm } from "../../../../components/forms/Form";

const Schema = z.object({
  reason: z.string().max(2000).optional(),
  confirm_text: z
    .string()
    .refine((v): v is string => v === "削除する", {
      message: "「削除する」と入力してください",
    }),
  consent: z.literal(true, {
    errorMap: () => ({ message: "削除内容への同意が必要です" }),
  }),
});
export type DeletionValues = z.infer<typeof Schema>;

const DELETE_ITEMS = [
  "アカウント情報（メール・名前・アバター）",
  "所属する全ワークスペース・プロジェクト",
  "チャット履歴・成果物・モック",
  "議事録アップロード・添付ファイル",
  "BYOK API キー（Vault）",
  "承認 Inbox 履歴",
] as const;

const FIELD_CLASS =
  "w-full rounded-md border border-transparent bg-surface-variant px-3.5 py-2.5 text-body-md text-on-surface transition focus:border-primary focus:bg-white focus:outline-none focus:ring-4 focus:ring-primary-container";

export interface DataDeletionFormProps {
  /** ログイン中アカウントのメール (表示専用)。 */
  readonly email: string;
  readonly onSubmit: (v: DeletionValues) => Promise<void> | void;
  readonly serverError?: string | null;
}

export function DataDeletionForm({
  email,
  onSubmit,
  serverError,
}: DataDeletionFormProps) {
  const form = useAtelierForm({
    schema: Schema,
    defaultValues: {
      reason: "",
      confirm_text: "",
      consent: false as unknown as true,
    },
  });

  return (
    <div className="flex flex-col gap-6">
      <header>
        <p className="mb-2 text-[12px] text-on-surface-variant">
          個人情報保護法 第 32〜35 条 対応
        </p>
        <h1 className="mb-2 text-[26px] font-bold tracking-tight text-on-surface">
          個人データ削除要求
        </h1>
        <p className="text-body-md text-on-surface">
          個人情報保護法に基づき、ご自身の保有個人情報の削除・利用停止を請求できます。
        </p>
      </header>

      {/* 削除される内容 (danger カード) */}
      <section className="rounded-lg border border-[#FECACA] bg-[#FEF2F2] p-6">
        <h2 className="mb-2 text-lg font-bold text-[#991B1B]">削除される内容</h2>
        <p className="mb-3 text-sm text-[#7F1D1D]">
          以下のデータが完全削除されます。30 日以内であればキャンセル可能です。
        </p>
        <ul className="rounded-md bg-white px-5 py-4 text-[13.5px] text-on-surface">
          {DELETE_ITEMS.map((item) => (
            <li key={item} className="mb-2 flex items-start gap-2 last:mb-0">
              <span aria-hidden="true" className="text-on-surface-variant">
                •
              </span>
              {item}
            </li>
          ))}
        </ul>
        <p className="mt-3 text-sm text-[#7F1D1D]">
          <strong>残存するデータ：</strong>
          ナレッジは氏名・案件特定情報を除去した形で匿名保持されます（匿名化処理）。法定保管義務のあるログ（監査ログ
          1 年）は保管期間後に削除します。
        </p>
      </section>

      {/* 削除スケジュール */}
      <section className="flex items-start gap-3.5 rounded-lg bg-tertiary-container p-5 text-on-tertiary-container">
        <span aria-hidden="true" className="mt-0.5 text-xl">
          🕒
        </span>
        <div>
          <div className="mb-1 font-bold">削除スケジュール</div>
          <div className="text-sm leading-[1.7]">
            申請当日：データ削除予約
            <br />
            申請から 30 日後：ナレッジ匿名化＋個人情報ハード削除
            <br />
            申請から 30 日以内：再ログインでキャンセル可能
          </div>
        </div>
      </section>

      {/* 申請フォーム */}
      <section className="rounded-lg border border-border bg-white p-5">
        <h2 className="mb-4 text-base font-bold text-on-surface">
          削除要求フォーム
        </h2>
        <Form form={form} onValid={onSubmit} className="gap-4">
          {serverError ? (
            <p role="alert" className="text-label-lg text-error">
              {serverError}
            </p>
          ) : null}
          <Field label="メールアドレス（ログイン中のアカウント）">
            <input
              value={email}
              disabled
              aria-label="メールアドレス（ログイン中のアカウント）"
              className={`${FIELD_CLASS} cursor-not-allowed opacity-70`}
            />
          </Field>
          <Field
            label="削除を希望する理由（任意）"
            description="理由は任意ですが、サービス改善のために頂けると助かります。"
            error={form.formState.errors.reason?.message}
          >
            <textarea
              {...form.register("reason")}
              rows={3}
              placeholder="例：サービス利用を終了したため"
              className={FIELD_CLASS}
            />
          </Field>
          <Field
            label="確認のため「削除する」と入力してください"
            required
            error={form.formState.errors.confirm_text?.message}
          >
            <input
              {...form.register("confirm_text")}
              placeholder="削除する"
              className={FIELD_CLASS}
            />
          </Field>
          <Field label="同意" error={form.formState.errors.consent?.message}>
            <label className="flex cursor-pointer items-center gap-2 text-sm text-on-surface">
              <input type="checkbox" {...form.register("consent")} />
              <span>
                上記の削除内容を理解し、申請から 30
                日後に個人データが完全削除されることに同意します。
              </span>
            </label>
          </Field>
          <div className="mt-2 flex flex-wrap gap-3">
            <button
              type="submit"
              className="inline-flex items-center rounded-md bg-error px-4 py-2 text-sm font-semibold text-on-error transition hover:bg-[#B91C1C]"
            >
              削除を申請する
            </button>
            <Link
              href="/privacy"
              className="inline-flex items-center rounded-md px-4 py-2 text-sm font-semibold text-on-surface transition hover:bg-surface-variant"
            >
              キャンセル
            </Link>
          </div>
        </Form>
      </section>

      {/* 他の請求 */}
      <section className="rounded-lg bg-secondary-container p-5 text-secondary-container-fg">
        <h2 className="mb-2 text-[14px] font-bold">他の請求も可能です</h2>
        <p className="mb-3 text-sm">
          保有個人情報の<strong>開示・訂正・利用停止</strong>
          もご請求いただけます。メールでお問い合わせください。
        </p>
        <a
          href="mailto:privacy@atelier.app"
          className="inline-flex items-center gap-1.5 rounded-md border border-current px-3 py-1.5 text-sm font-semibold"
        >
          privacy@atelier.app
        </a>
      </section>
    </div>
  );
}
