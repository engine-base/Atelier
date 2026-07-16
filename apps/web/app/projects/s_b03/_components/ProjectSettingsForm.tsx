/**
 * S-B03 プロジェクト設定フォーム — T-UC-05
 *
 * - project name / description / client_name 編集
 * - lifecycle (active/paused/archived) 切替
 * - delete (soft-delete + grace) は Danger Zone
 *
 * 見た目は 06_mockups/project/S-B03-settings.html に忠実:
 *   page-header → 基本情報カード(フォーム) → AI 学習設定 → クライアント招待 →
 *   エクスポート → 危険な操作(danger zone) の順。
 * データ配線 (name/client_name/description/lifecycle・onSubmit・onDelete・serverError)
 * は不変で、AI 学習/招待/エクスポートはモック同様の表示セクション。
 */

"use client";

import * as React from "react";
import Link from "next/link";
import { Download, ShieldCheck, Users } from "lucide-react";
import { z } from "zod";

import { Field } from "../../../../components/forms/Field";
import { Form, useAtelierForm } from "../../../../components/forms/Form";
import { cn } from "../../../../lib/cn";
import { t } from "../../../../lib/i18n";

const Schema = z.object({
  name: z.string().min(1, "入力必須").max(200),
  client_name: z.string().max(200).optional(),
  description: z.string().max(2000).optional(),
  lifecycle: z.enum(["active", "paused", "archived"]),
});
export type ProjectSettingsValues = z.infer<typeof Schema>;

export interface ProjectSettingsFormProps {
  readonly defaultValues: ProjectSettingsValues;
  readonly onSubmit: (v: ProjectSettingsValues) => Promise<void> | void;
  readonly onDelete?: () => void;
  readonly serverError?: string | null;
}

const FIELD_CLASS =
  "w-full rounded-md border border-transparent bg-surface-variant px-3.5 py-2.5 " +
  "text-body-md text-on-surface transition focus:border-primary focus:bg-white " +
  "focus:outline-none focus:ring-4 focus:ring-primary-container";

const CARD_CLASS = "rounded-lg border border-border bg-white p-5";
const SECTION_TITLE_CLASS = "mb-4 text-base font-bold text-on-surface";

const EXPORT_STEPS = [
  "ヒアリング",
  "要件定義",
  "アーキ設計",
  "デザイン",
  "機能分解",
] as const;

/** 表示専用トグル (モックの非対話 `.toggle` を忠実再現)。 */
function ToggleVisual({ on }: { readonly on: boolean }) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        "relative inline-block h-[22px] w-10 shrink-0 rounded-full transition-colors",
        on ? "bg-primary" : "bg-surface-variant",
      )}
    >
      <span
        className={cn(
          "absolute top-0.5 h-[18px] w-[18px] rounded-full bg-white shadow-sm transition-all",
          on ? "left-5" : "left-0.5",
        )}
      />
    </span>
  );
}

export function ProjectSettingsForm({
  defaultValues,
  onSubmit,
  onDelete,
  serverError,
}: ProjectSettingsFormProps) {
  const form = useAtelierForm({ schema: Schema, defaultValues });
  return (
    <div className="flex flex-col gap-6">
      <header>
        <h1 className="text-3xl font-bold tracking-tight text-on-surface">
          プロジェクト設定
        </h1>
        <p className="mt-2 text-body-md text-on-surface-variant">
          基本情報・AI学習設定・クライアント招待・削除など。
        </p>
      </header>

      {/* 基本情報 */}
      <section className={CARD_CLASS}>
        <h2 className={SECTION_TITLE_CLASS}>基本情報</h2>
        <Form form={form} onValid={onSubmit} className="gap-4">
          {serverError ? (
            <p role="alert" className="text-label-lg text-error">
              {serverError}
            </p>
          ) : null}
          <Field
            label="プロジェクト名"
            required
            error={form.formState.errors.name?.message}
          >
            <input {...form.register("name")} className={FIELD_CLASS} />
          </Field>
          <Field
            label="クライアント名"
            error={form.formState.errors.client_name?.message}
          >
            <input {...form.register("client_name")} className={FIELD_CLASS} />
          </Field>
          <Field label="説明" error={form.formState.errors.description?.message}>
            <textarea
              {...form.register("description")}
              rows={4}
              className={FIELD_CLASS}
            />
          </Field>
          <Field
            label="ライフサイクル"
            required
            error={form.formState.errors.lifecycle?.message}
          >
            <select {...form.register("lifecycle")} className={FIELD_CLASS}>
              <option value="active">進行中</option>
              <option value="paused">一時停止</option>
              <option value="archived">アーカイブ</option>
            </select>
          </Field>
          <button
            type="submit"
            className={cn(
              "mt-2 inline-flex w-fit items-center gap-1.5 rounded-md bg-primary px-4 py-2",
              "text-sm font-semibold text-on-primary transition hover:bg-[#1E54D8]",
              "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary",
            )}
          >
            {t("common.save")}
          </button>
        </Form>
      </section>

      {/* AI 学習設定 */}
      <section className={CARD_CLASS}>
        <h2 className={SECTION_TITLE_CLASS}>AI 学習設定</h2>
        <div className="mb-4 flex items-start gap-2.5 rounded-md border-l-[3px] border-primary bg-primary-container p-3 text-body-sm text-primary-container-fg">
          <ShieldCheck aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0" />
          <div>
            <strong>デフォルト OFF（学習しない）</strong> · 個人情報保護法対応 ·
            このプロジェクトのデータは Anthropic / Voyage
            の学習データに含めません。
          </div>
        </div>
        <div className="flex items-center justify-between py-3">
          <div>
            <div className="font-semibold text-on-surface">
              AI 学習への利用を許可
            </div>
            <div className="text-body-sm text-on-surface-variant">
              ONにすると、改善のためのモデル学習に匿名データが提供されます。
            </div>
          </div>
          <ToggleVisual on={false} />
        </div>
        <div className="mt-2 flex items-center justify-between border-t border-border py-3">
          <div>
            <div className="font-semibold text-on-surface">
              プロジェクト跨ぎナレッジ参照
            </div>
            <div className="text-body-sm text-on-surface-variant">
              同アカウント内の他プロジェクトのナレッジを参照可能にする。
            </div>
          </div>
          <ToggleVisual on={true} />
        </div>
      </section>

      {/* クライアント招待 */}
      <section className={CARD_CLASS}>
        <h2 className={SECTION_TITLE_CLASS}>クライアント招待</h2>
        <p className="mb-4 text-body-sm text-on-surface-variant">
          クライアントを別経路で招待し、限定UIで成果物・モックを閲覧・コメント可能にします。
        </p>
        <Link
          href="/client/s_l01"
          className="inline-flex w-fit items-center gap-1.5 rounded-md border border-primary px-4 py-2 text-sm font-semibold text-primary transition hover:bg-primary-container"
        >
          <Users aria-hidden="true" className="h-4 w-4" />
          招待管理を開く
        </Link>
      </section>

      {/* エクスポート */}
      <section className={CARD_CLASS}>
        <h2 className={SECTION_TITLE_CLASS}>エクスポート</h2>
        <p className="mb-3 text-body-sm text-on-surface-variant">
          各工程の成果物は HTML / JSON / MD
          で個別ダウンロードできます。一括エクスポートはありません。
        </p>
        <div className="flex flex-wrap gap-2">
          {EXPORT_STEPS.map((label) => (
            <button
              key={label}
              type="button"
              className="inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-semibold text-on-surface transition hover:bg-surface-variant"
            >
              <Download aria-hidden="true" className="h-3.5 w-3.5" />
              {label}
            </button>
          ))}
        </div>
      </section>

      {/* 危険な操作 (Danger Zone) */}
      {onDelete ? (
        <section
          aria-label="Danger zone"
          className="rounded-lg border border-[#FECACA] bg-[#FEF2F2] p-5"
        >
          <span className="text-[11px] font-bold uppercase tracking-[0.14em] text-[#991B1B]">
            Danger Zone
          </span>
          <h2 className="mb-2 mt-1 text-base font-bold text-[#991B1B]">
            危険な操作
          </h2>
          <p className="mb-4 text-body-sm text-[#991B1B]">
            プロジェクト削除は 30 日後にハード削除されます。30
            日以内であればキャンセル可能。
          </p>
          <button
            type="button"
            onClick={onDelete}
            className="inline-flex w-fit items-center gap-1.5 rounded-md bg-error px-4 py-2 text-sm font-semibold text-on-error transition hover:bg-[#B91C1C] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-error"
          >
            プロジェクトを削除
          </button>
        </section>
      ) : null}
    </div>
  );
}
