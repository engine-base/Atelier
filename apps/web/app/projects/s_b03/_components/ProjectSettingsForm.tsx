/**
 * S-B03 プロジェクト設定フォーム — T-UC-05 (design-audit v2)
 *
 * 見た目は 06_mockups/project/S-B03-settings.html に忠実:
 *   page-header → 基本情報カード(名前/クライアント名/説明/種別/ステータス) →
 *   AI 学習設定 → クライアント招待 → エクスポート → 危険な操作(danger zone)。
 *
 * design-audit v2 での是正:
 *   - クライアント名: 死に入力 (GET が返さず PATCH も送らない) → 実 API 往復に
 *   - 種別 select: モックにあるのに欠落 → 実装 (self_product/client_project/personal)
 *   - ステータス: 下書き(draft) 欠落で保存すると進行中に化ける実バグ → 4 択に是正
 *   - AI 学習トグル: 初期値を GET の ai_learning_opt_out から受ける (常に OFF 表示だった)
 *   - 跨ぎナレッジ参照: 見た目だけの偽トグルを撤去 (API 不在 → GAP-017)
 *   - エクスポート: onClick 皆無の死にボタン 5 個 → 実 /outputs 配線 (onExport)
 *   - 削除: 確認なし即 DELETE → 2 段階確認
 */

"use client";

import * as React from "react";
import { useState } from "react";
import Link from "next/link";
import { Download, Loader2, ShieldCheck, Users } from "lucide-react";
import { z } from "zod";

import { Field } from "../../../../components/forms/Field";
import { Form, useAtelierForm } from "../../../../components/forms/Form";
import { cn } from "../../../../lib/cn";
import { t } from "../../../../lib/i18n";

const Schema = z.object({
  name: z.string().min(1, "入力必須").max(200),
  client_name: z.string().max(200).optional(),
  description: z.string().max(2000).optional(),
  type: z.enum(["self_product", "client_project", "personal"]),
  lifecycle: z.enum(["active", "draft", "paused", "archived"]),
});
export type ProjectSettingsValues = z.infer<typeof Schema>;

/** モック S-B03 の 種別 select (契約 enum に対応)。 */
export const PROJECT_TYPE_LABEL: Readonly<
  Record<ProjectSettingsValues["type"], string>
> = {
  self_product: "自社プロダクト",
  client_project: "クライアント案件",
  personal: "個人開発",
};

/** モック S-B03 の ステータス select (draft を含む 4 択)。 */
export const LIFECYCLE_LABEL: Readonly<
  Record<ProjectSettingsValues["lifecycle"], string>
> = {
  active: "進行中",
  draft: "下書き",
  paused: "一時停止",
  archived: "アーカイブ",
};

/** エクスポート対象工程 (モックの 5 ボタン) → workflow_stage_enum。 */
export const EXPORT_STAGES = [
  { stage: "hearing", label: "ヒアリング" },
  { stage: "requirements", label: "要件定義" },
  { stage: "architecture", label: "アーキ設計" },
  { stage: "design", label: "デザイン" },
  { stage: "breakdown", label: "機能分解" },
] as const;
export type ExportStage = (typeof EXPORT_STAGES)[number]["stage"];

export interface ProjectSettingsFormProps {
  readonly defaultValues: ProjectSettingsValues;
  readonly onSubmit: (v: ProjectSettingsValues) => Promise<void> | void;
  readonly onDelete?: () => void;
  readonly serverError?: string | null;
  /** AI 学習「利用を許可」トグルの現在値 (GET の ai_learning_opt_out 由来) と即時変更ハンドラ。 */
  readonly aiLearningOptIn?: boolean;
  readonly onAiLearningChange?: (optIn: boolean) => void;
  /** 招待管理 (S-L01) への導線。意味的 URL + project 文脈を保持する。 */
  readonly inviteHref?: string;
  /** 工程成果物のエクスポート (署名付き URL を開く)。結果メッセージは exportMessage で表示。 */
  readonly onExport?: (stage: ExportStage) => void;
  readonly exportingStage?: ExportStage | null;
  readonly exportMessage?: string | null;
  readonly exportError?: boolean;
}

const FIELD_CLASS =
  "w-full rounded-md border border-transparent bg-surface-variant px-3.5 py-2.5 " +
  "text-body-md text-on-surface transition focus:border-primary focus:bg-white " +
  "focus:outline-none focus:ring-4 focus:ring-primary-container";

const CARD_CLASS = "rounded-lg border border-border bg-white p-5";
const SECTION_TITLE_CLASS = "mb-4 text-base font-bold text-on-surface";

/** 実操作トグル: checkbox を隠し、track/knob を peer-checked で駆動。onChange で即時適用。 */
function ToggleSwitch({
  checked,
  onChange,
  label,
}: {
  readonly checked: boolean;
  readonly onChange: (next: boolean) => void;
  readonly label: string;
}) {
  return (
    <label className="relative inline-flex h-[22px] w-10 shrink-0 cursor-pointer items-center">
      <input
        type="checkbox"
        aria-label={label}
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        className="peer sr-only"
      />
      <span className="absolute inset-0 rounded-full bg-surface-variant transition-colors peer-checked:bg-primary peer-focus-visible:outline-2 peer-focus-visible:outline-offset-2 peer-focus-visible:outline-primary" />
      <span className="absolute left-0.5 top-0.5 h-[18px] w-[18px] rounded-full bg-white shadow-sm transition-all peer-checked:left-5" />
    </label>
  );
}

export function ProjectSettingsForm({
  defaultValues,
  onSubmit,
  onDelete,
  serverError,
  aiLearningOptIn = false,
  onAiLearningChange,
  inviteHref = "/portal/invitations",
  onExport,
  exportingStage = null,
  exportMessage,
  exportError = false,
}: ProjectSettingsFormProps) {
  const form = useAtelierForm({ schema: Schema, defaultValues });
  const [confirmingDelete, setConfirmingDelete] = useState(false);

  // 保存成功などで defaultValues が更新されたら dirty をリセット (S-C02 で確立したパターン)
  const defaultsKey = JSON.stringify(defaultValues);
  React.useEffect(() => {
    form.reset(defaultValues);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [defaultsKey]);

  return (
    <div className="flex flex-col gap-6">
      <header>
        <h1 className="text-2xl font-bold tracking-tight text-on-surface lg:text-3xl">
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
          <div className="grid gap-4 sm:grid-cols-2">
            <Field
              label="種別"
              required
              error={form.formState.errors.type?.message}
            >
              <select {...form.register("type")} className={FIELD_CLASS}>
                {(
                  Object.keys(PROJECT_TYPE_LABEL) as ProjectSettingsValues["type"][]
                ).map((v) => (
                  <option key={v} value={v}>
                    {PROJECT_TYPE_LABEL[v]}
                  </option>
                ))}
              </select>
            </Field>
            <Field
              label="ステータス"
              required
              error={form.formState.errors.lifecycle?.message}
            >
              <select {...form.register("lifecycle")} className={FIELD_CLASS}>
                {(
                  Object.keys(
                    LIFECYCLE_LABEL,
                  ) as ProjectSettingsValues["lifecycle"][]
                ).map((v) => (
                  <option key={v} value={v}>
                    {LIFECYCLE_LABEL[v]}
                  </option>
                ))}
              </select>
            </Field>
          </div>
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
        <div className="flex items-center justify-between gap-4 py-3">
          <div>
            <div className="font-semibold text-on-surface">
              AI 学習への利用を許可
            </div>
            <div className="text-body-sm text-on-surface-variant">
              ONにすると、改善のためのモデル学習に匿名データが提供されます。
            </div>
          </div>
          <ToggleSwitch
            label="AI 学習への利用を許可"
            checked={aiLearningOptIn}
            onChange={(next) => onAiLearningChange?.(next)}
          />
        </div>
        {/* モックの「プロジェクト跨ぎナレッジ参照」トグルは参照設定 API が存在しないため
            偽トグルを置かず撤去 (Rule 10 / GAP-017)。 */}
      </section>

      {/* クライアント招待 */}
      <section className={CARD_CLASS}>
        <h2 className={SECTION_TITLE_CLASS}>クライアント招待</h2>
        <p className="mb-4 text-body-sm text-on-surface-variant">
          クライアントを別経路で招待し、限定UIで成果物・モックを閲覧・コメント可能にします。
        </p>
        <Link
          href={inviteHref}
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
          {EXPORT_STAGES.map(({ stage, label }) => (
            <button
              key={stage}
              type="button"
              onClick={() => onExport?.(stage)}
              disabled={exportingStage !== null}
              className="inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-semibold text-on-surface transition hover:bg-surface-variant disabled:opacity-50"
            >
              {exportingStage === stage ? (
                <Loader2
                  aria-hidden="true"
                  className="h-3.5 w-3.5 animate-spin"
                />
              ) : (
                <Download aria-hidden="true" className="h-3.5 w-3.5" />
              )}
              {label}
            </button>
          ))}
        </div>
        {exportMessage ? (
          <p
            role="status"
            className={cn(
              "mt-3 text-body-sm",
              exportError ? "text-error" : "text-on-surface-variant",
            )}
          >
            {exportMessage}
          </p>
        ) : null}
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
          {confirmingDelete ? (
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-body-sm font-semibold text-[#991B1B]">
                本当に削除しますか？
              </span>
              <button
                type="button"
                onClick={() => {
                  setConfirmingDelete(false);
                  onDelete();
                }}
                className="inline-flex w-fit items-center rounded-md bg-error px-4 py-2 text-sm font-semibold text-on-error transition hover:bg-[#B91C1C]"
              >
                削除を確定
              </button>
              <button
                type="button"
                onClick={() => setConfirmingDelete(false)}
                className="inline-flex w-fit items-center rounded-md border border-border px-4 py-2 text-sm font-semibold text-on-surface transition hover:bg-surface-variant"
              >
                キャンセル
              </button>
            </div>
          ) : (
            <button
              type="button"
              onClick={() => setConfirmingDelete(true)}
              className="inline-flex w-fit items-center gap-1.5 rounded-md bg-error px-4 py-2 text-sm font-semibold text-on-error transition hover:bg-[#B91C1C] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-error"
            >
              プロジェクトを削除
            </button>
          )}
        </section>
      ) : null}
    </div>
  );
}
