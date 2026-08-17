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
  /** 実 API 配線済みのメンバー / MCPトークン / プラン / 招待管理 section を差し込む。 */
  readonly membersSlot?: React.ReactNode;
  readonly tokensSlot?: React.ReactNode;
  readonly planSlot?: React.ReactNode;
  readonly invitationsSlot?: React.ReactNode;
  /** 現在のワークスペースアイコン (null = 頭文字表示)。GAP-021 */
  readonly icon?: string | null;
  /** アイコン保存 (null = クリア)。未指定なら「変更」ボタンを出さない (死にボタン禁止)。 */
  readonly onIconSave?: (icon: string | null) => void;
  /** 初期表示タブ (GAP-116)。Stripe checkout から戻った時は 'plan' を渡す。 */
  readonly initialTab?: SettingsTabKey;
}

/** GAP-116 (経営者指示の仕様変更): タブは「ページ内アンカーで縦積み全表示」から
 * 「選択タブの節のみ表示」へ変更。招待管理・退会も別ページ遷移ではなく
 * タブパネルとして表示する (遷移するとタブ文脈が失われる — 経営者指摘)。 */
export type SettingsTabKey =
  | "basic"
  | "members"
  | "invitations"
  | "tokens"
  | "ai"
  | "plan"
  | "leave";

const PANEL_TABS: ReadonlyArray<{ label: string; key: SettingsTabKey }> = [
  { label: "基本情報", key: "basic" },
  { label: "メンバー", key: "members" },
  { label: "招待管理", key: "invitations" },
  { label: "MCPトークン", key: "tokens" },
  { label: "AI学習", key: "ai" },
  { label: "プラン", key: "plan" },
  { label: "退会", key: "leave" },
];

/** icon の UTF-8 バイト長 (バックエンド検証 ICON_MAX_BYTES=8 と同一基準)。 */
const ICON_MAX_BYTES = 8;

function iconByteLength(value: string): number {
  return new TextEncoder().encode(value).length;
}

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
  planSlot,
  invitationsSlot,
  icon,
  onIconSave,
  initialTab,
}: WorkspaceSettingsFormProps) {
  const form = useAtelierForm({ schema: Schema, defaultValues });
  // GAP-116: 選択タブの節のみ表示 (非アクティブは hidden — unmount しないので
  // フォーム状態と Stripe 戻りポーリングはタブ切替を跨いで保持される)
  const [activeTab, setActiveTab] = React.useState<SettingsTabKey>(initialTab ?? "basic");
  const [confirmingDelete, setConfirmingDelete] = React.useState(false);
  const [editingIcon, setEditingIcon] = React.useState(false);
  const [iconDraft, setIconDraft] = React.useState("");
  const [iconError, setIconError] = React.useState<string | null>(null);
  const nameValue = form.watch("name");
  const iconInitial = (nameValue?.trim()?.charAt(0) ?? "W").toUpperCase();

  const saveIcon = (value: string | null) => {
    if (value !== null && iconByteLength(value) > ICON_MAX_BYTES) {
      setIconError("アイコンは絵文字 1 つまたは 1〜3 文字までです。");
      return;
    }
    setIconError(null);
    setEditingIcon(false);
    onIconSave?.(value);
  };

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

      <div className="flex gap-1 overflow-x-auto border-b border-border">
        <div role="tablist" aria-label="設定セクション" className="flex gap-1">
          {PANEL_TABS.map((tab) => {
            const selected = activeTab === tab.key;
            return (
              <button
                key={tab.label}
                type="button"
                role="tab"
                id={`ws-tab-${tab.key}`}
                aria-selected={selected}
                aria-controls={`ws-panel-${tab.key}`}
                onClick={() => setActiveTab(tab.key)}
                className={cn(
                  "whitespace-nowrap border-b-2 px-4 py-2.5 text-label-lg font-semibold transition",
                  selected
                    ? "border-primary text-primary"
                    : "border-transparent text-on-surface-variant hover:text-on-surface",
                )}
              >
                {tab.label}
              </button>
            );
          })}
        </div>
      </div>

      {serverError ? (
        <p role="alert" className="text-label-lg text-error">
          {serverError}
        </p>
      ) : null}

      {/* GAP-116: 各タブパネル。hidden で切替 (unmount しない) */}
      <div
        role="tabpanel"
        id="ws-panel-basic"
        aria-labelledby="ws-tab-basic"
        hidden={activeTab !== "basic"}
        className={cn(
          activeTab === "basic" ? "grid grid-cols-1 gap-6 md:grid-cols-2" : "hidden",
        )}
      >
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
            <div className="flex flex-wrap items-center gap-3">
              <span
                aria-hidden="true"
                className="flex h-12 w-12 items-center justify-center rounded-md bg-primary-container text-lg font-bold text-on-primary-container"
              >
                {icon || iconInitial}
              </span>
              {editingIcon && onIconSave ? (
                <span className="flex flex-wrap items-center gap-2">
                  <label className="sr-only" htmlFor="ws-icon-input">
                    アイコン（絵文字または短い文字）
                  </label>
                  <input
                    id="ws-icon-input"
                    value={iconDraft}
                    onChange={(e) => setIconDraft(e.target.value)}
                    placeholder="🎨 / EB"
                    autoFocus
                    className="h-10 w-24 rounded-md border border-border bg-surface px-3 text-center text-body-md text-on-surface focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary-container"
                  />
                  <button
                    type="button"
                    onClick={() => saveIcon(iconDraft.trim() || null)}
                    className="inline-flex items-center rounded-md bg-primary px-3 py-1.5 text-label-md font-semibold text-on-primary transition-colors hover:bg-[#1E54D8]"
                  >
                    アイコンを保存
                  </button>
                  {icon ? (
                    <button
                      type="button"
                      onClick={() => saveIcon(null)}
                      className="inline-flex items-center rounded-md border border-border px-3 py-1.5 text-label-md font-semibold text-on-surface transition hover:bg-surface-variant"
                    >
                      クリア
                    </button>
                  ) : null}
                  <button
                    type="button"
                    onClick={() => {
                      setEditingIcon(false);
                      setIconError(null);
                    }}
                    className="inline-flex items-center rounded-md px-3 py-1.5 text-label-md font-semibold text-on-surface-variant transition hover:bg-surface-variant"
                  >
                    キャンセル
                  </button>
                </span>
              ) : (
                <>
                  <span className="text-body-sm text-on-surface-variant">
                    {icon
                      ? "絵文字または短い文字を表示中"
                      : "未設定時は名前の頭文字を表示します"}
                  </span>
                  {/* GAP-021: icon 更新 API (PATCH /workspaces/{id} {icon}) 実装済 — モックの「変更」ボタンを実配線 */}
                  {onIconSave ? (
                    <button
                      type="button"
                      onClick={() => {
                        setIconDraft(icon ?? "");
                        setIconError(null);
                        setEditingIcon(true);
                      }}
                      className="inline-flex items-center rounded-md border border-primary px-3 py-1.5 text-label-md font-semibold text-primary transition-colors hover:bg-primary-container"
                    >
                      変更
                    </button>
                  ) : null}
                </>
              )}
            </div>
            {iconError ? (
              <p role="alert" className="text-body-sm text-error">
                {iconError}
              </p>
            ) : null}
          </div>
          <button type="submit" className={BTN_PRIMARY}>
            {t("common.save")}
          </button>
        </Form>
        </section>
      </div>

      {/* メンバー (実 API 配線 section) */}
      <div
        role="tabpanel"
        id="ws-panel-members"
        aria-labelledby="ws-tab-members"
        hidden={activeTab !== "members"}
        className={cn(activeTab === "members" ? "grid grid-cols-1 gap-6" : "hidden")}
      >
        {membersSlot}
      </div>

      {/* 招待管理 (GAP-116 追補 — S-L01 実体のタブパネル埋め込み) */}
      <div
        role="tabpanel"
        id="ws-panel-invitations"
        aria-labelledby="ws-tab-invitations"
        hidden={activeTab !== "invitations"}
        className={cn(activeTab === "invitations" ? "grid grid-cols-1 gap-6" : "hidden")}
      >
        {invitationsSlot}
      </div>

      {/* MCPトークン (実 API 配線 section) */}
      <div
        role="tabpanel"
        id="ws-panel-tokens"
        aria-labelledby="ws-tab-tokens"
        hidden={activeTab !== "tokens"}
        className={cn(activeTab === "tokens" ? "grid grid-cols-1 gap-6" : "hidden")}
      >
        {tokensSlot}
      </div>

      {/* AI 学習設定 */}
      <div
        role="tabpanel"
        id="ws-panel-ai"
        aria-labelledby="ws-tab-ai"
        hidden={activeTab !== "ai"}
        className={cn(activeTab === "ai" ? "grid grid-cols-1 gap-6" : "hidden")}
      >
        <section
          id="ws-ai"
          className={CARD}
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
          {/* GAP-116: タブ分離で基本情報の保存ボタンが同時に見えなくなったため、
              同一フォームの保存をこのタブにも置く */}
          <button
            type="button"
            onClick={() => void form.handleSubmit((v) => onSubmit(v))()}
            className={cn(BTN_PRIMARY, "mt-4")}
          >
            {t("common.save")}
          </button>
        </section>
      </div>

      {/* プラン (GAP-021 — 実 billing API 配線 section) */}
      <div
        role="tabpanel"
        id="ws-panel-plan"
        aria-labelledby="ws-tab-plan"
        hidden={activeTab !== "plan"}
        className={cn(activeTab === "plan" ? "grid grid-cols-1 gap-6" : "hidden")}
      >
        {planSlot}
      </div>

      {/* 退会 (GAP-116 追補): WS 削除 (危険な操作) + アカウント退会への導線 */}
      <div
        role="tabpanel"
        id="ws-panel-leave"
        aria-labelledby="ws-tab-leave"
        hidden={activeTab !== "leave"}
        className={cn(activeTab === "leave" ? "grid grid-cols-1 gap-6" : "hidden")}
      >
        {onDelete ? (
          <section
            aria-label="Danger zone"
            className="rounded-lg border border-[#FECACA] bg-[#FEF2F2] p-5"
          >
            <h2 className="mb-2 text-base font-bold tracking-tight text-[#991B1B]">
              ワークスペースの削除
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
        <section aria-label="アカウント退会" className={CARD}>
          <h2 className={cn(SECTION_TITLE, "mb-2")}>アカウント退会</h2>
          <p className="mb-4 text-body-sm text-on-surface-variant">
            アカウント自体の退会とデータ削除は専用の手続きページで行います
            (削除対象データの確認と同意が必要なため)。
          </p>
          <a
            href="/data-deletion"
            className="inline-flex w-fit items-center rounded-md border border-error px-4 py-2 text-label-lg font-semibold text-error transition hover:bg-[#FEF2F2]"
          >
            退会手続きへ進む
          </a>
        </section>
      </div>
    </div>
  );
}
