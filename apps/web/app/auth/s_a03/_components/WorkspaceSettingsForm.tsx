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
 * メンバー / MCPトークンはモック忠実の静的表示 (対応 props/API が無いため)。
 */

"use client";

import * as React from "react";
import { z } from "zod";

import { Field } from "../../../../components/forms/Field";
import { Form, useAtelierForm } from "../../../../components/forms/Form";
import { cn } from "../../../../lib/cn";
import { t } from "../../../../lib/i18n";

const Schema = z.object({
  name: z.string().min(1, "入力必須").max(100),
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
}

/** モックの settings-tabs (7 セクション、基本情報が active)。表示専用。 */
const SETTINGS_TABS = [
  "基本情報",
  "メンバー",
  "招待管理",
  "MCPトークン",
  "AI学習",
  "プラン",
  "退会",
] as const;

interface MemberRow {
  readonly initial: string;
  readonly name: string;
  readonly email: string;
  readonly role: string;
  readonly roleTone: string;
  readonly avatarClass: string;
}

/** メンバー一覧 (モック忠実の静的表示)。対応する API/props が無い。 */
const MEMBERS: readonly MemberRow[] = [
  {
    initial: "M",
    name: "高本まさと",
    email: "masato@engine-base.com",
    role: "オーナー",
    roleTone: "bg-primary-container text-on-primary-container",
    avatarClass: "bg-primary text-on-primary",
  },
  {
    initial: "T",
    name: "高本聖斗",
    email: "takamoto@engine-base.com",
    role: "メンバー",
    roleTone: "bg-surface-variant text-on-surface-variant",
    avatarClass: "bg-[#7C3AED] text-white",
  },
  {
    initial: "S",
    name: "佐藤花子",
    email: "sato@engine-base.com",
    role: "閲覧者",
    roleTone: "bg-surface-variant text-on-surface-variant",
    avatarClass: "bg-[#0891B2] text-white",
  },
] as const;

interface TokenRow {
  readonly name: string;
  readonly meta: string;
  readonly status: string;
  readonly statusTone: string;
  readonly scopes: string;
}

/** MCP トークン一覧 (モック忠実の静的表示)。 */
const TOKENS: readonly TokenRow[] = [
  {
    name: "Claude Desktop (Mac)",
    meta: "atelier_pat_••••••••••••3a9f · 最終使用 2 時間前",
    status: "active",
    statusTone: "bg-tertiary-container text-on-tertiary-container",
    scopes: "read, write",
  },
  {
    name: "CI/CD Pipeline",
    meta: "atelier_pat_••••••••••••f81e · 未使用",
    status: "revoked",
    statusTone: "bg-surface-variant text-on-surface-variant",
    scopes: "read",
  },
] as const;

const CARD = "rounded-lg border border-border bg-white p-5";
const SECTION_TITLE = "text-base font-bold tracking-tight text-on-surface";
const BADGE = "inline-flex items-center rounded-sm px-2 py-0.5 text-[10.5px] font-semibold";

const BTN_PRIMARY =
  "inline-flex w-fit items-center justify-center gap-1.5 rounded-md bg-primary px-4 py-2 text-label-lg font-semibold text-on-primary transition-colors hover:bg-[#1E54D8] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary";
const BTN_PRIMARY_SM =
  "inline-flex items-center justify-center gap-1.5 rounded-md bg-primary px-3 py-1.5 text-label-md font-semibold text-on-primary transition-colors hover:bg-[#1E54D8] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary";
const BTN_OUTLINED_SM =
  "inline-flex w-fit items-center justify-center gap-1.5 rounded-md border border-primary px-3 py-1.5 text-label-md font-semibold text-primary transition-colors hover:bg-primary-container focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary";
const BTN_GHOST_SM =
  "inline-flex items-center justify-center rounded-md p-1.5 text-on-surface transition-colors hover:bg-surface-variant focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary";

function PlusIcon() {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 16 16"
      width="14"
      height="14"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
    >
      <path d="M8 3v10M3 8h10" />
    </svg>
  );
}

function TrashIcon() {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 16 16"
      width="15"
      height="15"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M2.5 4h11M6 4V2.5h4V4M4 4l.6 9.5h6.8L12 4" />
    </svg>
  );
}

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
}: WorkspaceSettingsFormProps) {
  const form = useAtelierForm({ schema: Schema, defaultValues });
  const nameValue = form.watch("name");
  const iconInitial = (nameValue?.trim()?.charAt(0) ?? "W").toUpperCase();

  return (
    <div className="flex flex-col gap-7">
      <header>
        <h1 className="text-3xl font-bold tracking-tight text-on-surface">
          ワークスペース設定
        </h1>
        <p className="mt-1 text-body-md text-on-surface-variant">
          ENGINE BASE の基本情報・メンバー・MCPトークン・退会設定。
        </p>
      </header>

      <div className="flex gap-1 overflow-x-auto border-b border-border">
        {SETTINGS_TABS.map((tab, i) => (
          <span
            key={tab}
            aria-current={i === 0 ? "page" : undefined}
            className={cn(
              "whitespace-nowrap border-b-2 px-4 py-2.5 text-label-lg font-semibold",
              i === 0
                ? "border-primary text-primary"
                : "border-transparent text-on-surface-variant",
            )}
          >
            {tab}
          </span>
        ))}
      </div>

      {serverError ? (
        <p role="alert" className="text-label-lg text-error">
          {serverError}
        </p>
      ) : null}

      <div className="grid grid-cols-1 gap-6 md:grid-cols-2">
        {/* 基本情報 — フォーム本体 (name + アイコン + 保存) */}
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
              <button type="button" className={BTN_OUTLINED_SM}>
                変更
              </button>
            </div>
          </div>
          <button type="submit" className={BTN_PRIMARY}>
            {t("common.save")}
          </button>
        </Form>

        {/* メンバー */}
        <section className={CARD} aria-label="メンバー">
          <h2 className={cn(SECTION_TITLE, "mb-4")}>
            メンバー（{MEMBERS.length}）
          </h2>
          <ul>
            {MEMBERS.map((m) => (
              <li
                key={m.email}
                className="flex items-center gap-3 border-b border-border py-3 last:border-b-0"
              >
                <span
                  aria-hidden="true"
                  className={cn(
                    "flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-label-md font-bold",
                    m.avatarClass,
                  )}
                >
                  {m.initial}
                </span>
                <div className="min-w-0 flex-1">
                  <div className="truncate font-semibold text-on-surface">
                    {m.name}
                  </div>
                  <div className="truncate text-body-sm text-on-surface-variant">
                    {m.email}
                  </div>
                </div>
                <span className={cn(BADGE, m.roleTone)}>{m.role}</span>
              </li>
            ))}
          </ul>
          <button type="button" className={cn(BTN_OUTLINED_SM, "mt-4")}>
            <PlusIcon />
            メンバー招待
          </button>
        </section>

        {/* MCPトークン */}
        <section className={cn(CARD, "md:col-span-2")} aria-label="MCPトークン">
          <div className="mb-4 flex items-center justify-between">
            <h2 className={SECTION_TITLE}>MCPトークン</h2>
            <button type="button" className={BTN_PRIMARY_SM}>
              <PlusIcon />
              発行
            </button>
          </div>
          <p className="mb-4 text-body-sm text-on-surface-variant">
            Claude デスクトップ等の MCP
            クライアントからこのワークスペースの AI
            社員を呼び出すためのトークン。
          </p>
          <ul>
            {TOKENS.map((tk) => (
              <li
                key={tk.name}
                className="grid grid-cols-[1fr_auto_auto_auto] items-center gap-3 border-b border-border py-3 last:border-b-0"
              >
                <div className="min-w-0">
                  <div className="truncate font-semibold text-on-surface">
                    {tk.name}
                  </div>
                  <div className="truncate font-mono text-body-sm text-on-surface-variant">
                    {tk.meta}
                  </div>
                </div>
                <span className={cn(BADGE, tk.statusTone)}>{tk.status}</span>
                <span className="text-body-sm text-on-surface-variant">
                  {tk.scopes}
                </span>
                <button
                  type="button"
                  className={BTN_GHOST_SM}
                  aria-label={`${tk.name} のトークンを取り消す`}
                >
                  <TrashIcon />
                </button>
              </li>
            ))}
          </ul>
        </section>

        {/* AI 学習設定 */}
        <section
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
            <button
              type="button"
              onClick={onDelete}
              className="inline-flex w-fit items-center justify-center rounded-md bg-error px-4 py-2 text-label-lg font-semibold text-on-error transition-colors hover:opacity-90 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-error"
            >
              ワークスペースを削除
            </button>
          </section>
        ) : null}
      </div>
    </div>
  );
}
