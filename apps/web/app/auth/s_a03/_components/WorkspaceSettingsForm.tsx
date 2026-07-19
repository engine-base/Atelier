/**
 * S-A03 ワークスペース設定フォーム — T-UC-02 (client component)
 *
 * モック 06_mockups/workspace/S-A03-settings.html に忠実な本文を描画する:
 *   page-header → settings-tabs → 2 カラムグリッド
 *   (基本情報 / メンバー / MCPトークン / AI 学習設定 / 危険な操作)。
 *
 * データ配線は不変:
 *   - workspace name は form.register('name') で編集 (Field label「名前」)
 *   - AI 学習は opt-in トグル (既定 OFF を維持 — 絶対ルール #6)
 *   - 削除は onDelete が渡された時のみ danger zone を表示 (WS 削除 API 無し)
 * メンバー / MCPトークンは membersSlot / tokensSlot で実 API 配線した section を
 * 差し込む (以前は静的モックだった)。未指定時は何も出さない。
 */

"use client";

import * as React from "react";
import { z } from "zod";

import { Field } from "../../../../components/forms/Field";
import { Form, useAtelierForm } from "../../../../components/forms/Form";
import { cn } from "../../../../lib/cn";
import { t } from "../../../../lib/i18n";

const Schema = z.object({
  name: z.string().min(2, "2 文字以上で入力してください").max(50),
  // UI は「利用する (optIn)」で持つ。optOut を直バインドすると
  // 既定 OFF なのに checked 表示になり、操作の意味も反転する実バグがあった。
  aiLearningOptIn: z.boolean(),
});
export type WorkspaceSettingsValues = z.infer<typeof Schema>;

export interface WorkspaceSettingsFormProps {
  readonly defaultValues: WorkspaceSettingsValues;
  readonly onSubmit: (v: WorkspaceSettingsValues) => Promise<void> | void;
  readonly onDelete?: () => void;
  readonly serverError?: string | null;
  /** 実 API 配線済みのメンバー / MCPトークン section を差し込む。 */
  readonly membersSlot?: React.ReactNode;
  readonly tokensSlot?: React.ReactNode;
}

/** モックの settings-tabs を実リンク化 (design-audit v2 — 死にタブ 7 個を是正)。
 * 同一ページ内セクションはアンカー、招待管理/退会は実ページへ。
 * 「プラン」は課金 API 不在のため撤去 (GAP-021)。 */
const SETTINGS_TABS: ReadonlyArray<{ label: string; href: string }> = [
  { label: "基本情報", href: "#ws-basic" },
  { label: "メンバー", href: "#ws-members" },
  { label: "招待管理", href: "/portal/invitations" },
  { label: "MCPトークン", href: "#ws-tokens" },
  { label: "AI学習", href: "#ws-ai" },
  { label: "退会", href: "/data-deletion" },
];

const CARD = "rounded-lg border border-border bg-white p-5";
const SECTION_TITLE = "text-base font-bold tracking-tight text-on-surface";

const BTN_PRIMARY =
  "inline-flex w-fit items-center justify-center gap-1.5 rounded-md bg-primary px-4 py-2 text-label-lg font-semibold text-on-primary transition-colors hover:bg-[#1E54D8] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary";

function ShieldCheckIcon() {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 20 20"
      width="18"
      height="18"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="mt-0.5 shrink-0"
    >
      <path d="M10 2.5 3.5 5v4.5c0 3.7 2.7 6.4 6.5 8 3.8-1.6 6.5-4.3 6.5-8V5L10 2.5Z" />
      <path d="M7 10l2 2 4-4" />
    </svg>
  );
}

export function WorkspaceSettingsForm({
  defaultValues,
  onSubmit,
  onDelete,
  serverError,
  membersSlot,
  tokensSlot,
}: WorkspaceSettingsFormProps) {
  const form = useAtelierForm({ schema: Schema, defaultValues });
  const [confirmingDelete, setConfirmingDelete] = React.useState(false);
  const nameValue = form.watch("name");
  const iconInitial = (nameValue?.trim()?.charAt(0) ?? "W").toUpperCase();

  return (
    <div className="flex flex-col gap-7">
      <header>
        <h1 className="text-3xl font-bold tracking-tight text-on-surface">
          ワークスペース設定
        </h1>
        <p className="mt-1 text-body-md text-on-surface-variant">
          {nameValue || "ワークスペース"} の基本情報・メンバー・MCPトークン・退会設定。
        </p>
      </header>

      <nav
        aria-label="設定セクション"
        className="flex gap-1 overflow-x-auto border-b border-border"
      >
        {SETTINGS_TABS.map((tab, i) => (
          <a
            key={tab.label}
            href={tab.href}
            aria-current={i === 0 ? "page" : undefined}
            className={cn(
              "whitespace-nowrap border-b-2 px-4 py-2.5 text-label-lg font-semibold transition",
              i === 0
                ? "border-primary text-primary"
                : "border-transparent text-on-surface-variant hover:text-on-surface",
            )}
          >
            {tab.label}
          </a>
        ))}
      </nav>

      {serverError ? (
        <p role="alert" className="text-label-lg text-error">
          {serverError}
        </p>
      ) : null}

      <div className="grid grid-cols-1 gap-6 md:grid-cols-2">
        {/* 基本情報 — フォーム本体 (name + アイコン + 保存) */}
        <section id="ws-basic" className="contents">
        <Form form={form} onValid={onSubmit} className={cn(CARD, "gap-4")}>
          <h2 className={SECTION_TITLE}>基本情報</h2>
          <Field
            label="名前"
            required
            error={form.formState.errors.name?.message}
          >
            <input
              {...form.register("name")}
              className="h-10 w-full rounded-md border border-border bg-surface px-3 text-body-md text-on-surface focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary-container"
            />
          </Field>
          <div className="flex flex-col gap-xs">
            <span className="text-label-lg font-semibold text-on-surface">
              アイコン
            </span>
            <div className="flex items-center gap-3">
              <span
                aria-hidden="true"
                className="flex h-12 w-12 items-center justify-center rounded-md bg-primary-container text-lg font-bold text-on-primary-container"
              >
                {iconInitial}
              </span>
              <span className="text-body-sm text-on-surface-variant">
                名前の頭文字を自動表示します
              </span>
              {/* モックの「変更」ボタンは icon 更新 API が無い死にボタンだったため撤去 (GAP-021) */}
            </div>
          </div>
          <button type="submit" className={BTN_PRIMARY}>
            {t("common.save")}
          </button>
        </Form>
        </section>

        {/* メンバー (実 API 配線 section) */}
        <div id="ws-members" className="contents">
          {membersSlot}
        </div>

        {/* MCPトークン (実 API 配線 section) */}
        <div id="ws-tokens" className="contents">
          {tokensSlot}
        </div>

        {/* AI 学習設定 */}
        <section
          id="ws-ai"
          className={cn(CARD, "md:col-span-2")}
          aria-label="AI 学習設定"
        >
          <h2 className={cn(SECTION_TITLE, "mb-4")}>AI 学習設定</h2>
          <div className="mb-4 flex gap-3 rounded-md border-l-[3px] border-primary bg-primary-container p-3 text-on-primary-container">
            <ShieldCheckIcon />
            <p className="text-body-sm">
              <strong className="font-bold">デフォルト OFF。</strong>{" "}
              このワークスペースのデータは Anthropic / Voyage の AI
              学習に使用されません。ON
              にすると、改善のためのモデル学習に匿名データが利用されます。
            </p>
          </div>
          <label className="flex w-fit cursor-pointer items-center gap-3 text-body-md text-on-surface">
            <input
              type="checkbox"
              {...form.register("aiLearningOptIn")}
              className="h-4 w-4 accent-primary"
            />
            <span className="font-semibold">
              AI 学習への利用を許可する（推奨：OFF）
            </span>
          </label>
        </section>

        {/* 危険な操作 (Danger Zone) — onDelete が渡された時のみ */}
        {onDelete ? (
          <section
            aria-label="Danger zone"
            className="rounded-lg border border-[#FECACA] bg-[#FEF2F2] p-5 md:col-span-2"
          >
            <h2 className="mb-2 text-base font-bold tracking-tight text-[#991B1B]">
              危険な操作
            </h2>
            <span className="sr-only">Danger Zone</span>
            <p className="mb-4 text-body-sm text-[#991B1B]">
              ワークスペース削除は 30 日後にハード削除されます。30
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
                  className="inline-flex w-fit items-center rounded-md bg-error px-4 py-2 text-label-lg font-semibold text-on-error transition-colors hover:opacity-90"
                >
                  削除を確定
                </button>
                <button
                  type="button"
                  onClick={() => setConfirmingDelete(false)}
                  className="inline-flex w-fit items-center rounded-md border border-border px-4 py-2 text-label-lg font-semibold text-on-surface transition hover:bg-surface-variant"
                >
                  キャンセル
                </button>
              </div>
            ) : (
              <button
                type="button"
                onClick={() => setConfirmingDelete(true)}
                className="inline-flex w-fit items-center justify-center rounded-md bg-error px-4 py-2 text-label-lg font-semibold text-on-error transition-colors hover:opacity-90 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-error"
              >
                ワークスペースを削除
              </button>
            )}
          </section>
        ) : null}
      </div>
    </div>
  );
}
