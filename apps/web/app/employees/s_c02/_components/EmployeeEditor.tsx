/**
 * S-C02 AI 社員詳細・編集 — T-UC-07 / モック忠実再構築 v2
 *
 * 06_mockups/employee/S-C02-detail.html に忠実な本文:
 *   社員ヘッダ (avatar-xl + 表示名 + 役職バッジ + EN·specialty·所属 + チャット開始)
 *   → タブ (プロフィール / ナレッジ n) → 2 カラム
 *   (左: 表示 / 口調ラジオカード / カスタム文章, 右: できること / 担当範囲)
 *   → 固定保存バー。
 *
 * Rule 10 対応:
 *   - 口調はモック通りのラジオカード (サンプル文付き)
 *   - 「Lucide から選ぶ」は実装 (EMPLOYEE_ICON_CHOICES → PATCH icon)
 *   - 「画像アップロード」は GAP-009 解消で実装 (署名付き URL → PUT →
 *     PATCH icon=storage_path。icon が path のときは署名付き URL の <img> 描画)
 *   - 活動履歴タブは活動 API 未提供のため撤去 (GAP-008)
 */

"use client";

import * as React from "react";
import { useState } from "react";
import { z } from "zod";
import { Check, MessageSquare, Zap } from "lucide-react";

import {
  EmployeeIcon,
  EMPLOYEE_ICON_CHOICES,
  type EmployeeId,
} from "../../../../components/EmployeeIcon";
import { Field } from "../../../../components/forms/Field";
import { Form, useAtelierForm } from "../../../../components/forms/Form";
import { cn } from "../../../../lib/cn";

const TONE_PRESETS = [
  "polite",
  "friendly",
  "casual",
  "concise",
  "coaching",
] as const;

type Tone = (typeof TONE_PRESETS)[number];

/** モックの口調ラベル (敬語・丁寧 …) に忠実。値は API の tone_preset を維持。 */
const TONE_LABEL: Record<Tone, string> = {
  polite: "敬語・丁寧（デフォルト）",
  friendly: "ですます調・親しみ",
  casual: "タメ口・フランク",
  concise: "ビジネス簡潔",
  coaching: "コーチング・前向き",
};

/** 各口調のサンプル文 (モック tone-sample に対応)。 */
const TONE_SAMPLE: Record<Tone, string> = {
  polite: "「ご確認をお願いいたします」",
  friendly: "「確認お願いしますね」",
  casual: "「確認しといて」",
  concise: "「確認願います」",
  coaching: "「次の一手を一緒に考えましょう」",
};

const Schema = z.object({
  display_name: z.string().min(1, "入力必須").max(100),
  tone_preset: z.enum(TONE_PRESETS),
  custom_tone_text: z.string().max(500).optional(),
  // lucide 名 or storage path (GAP-009 画像 — avatars/... は 50 を超える)
  icon: z.string().max(200).optional(),
});
export type EmployeeValues = z.infer<typeof Schema>;

export interface EmployeeOrgInfo {
  /** 役職 (COO / 部長 / メンバー / ナレッジ統括 等の表示ラベル)。 */
  readonly roleLabel: string;
  /** 所属 (営業・契約部 等の表示ラベル)。 */
  readonly deptLabel: string;
  /** レポート対象 (あなた（オーナー） / COO 表示名 / 部長表示名)。 */
  readonly reportsTo?: string;
  /** 直属の部下 (部署リーダー 5 名 / メンバー 1 名 / なし)。 */
  readonly subordinates?: string;
}

export interface EmployeeActivity {
  readonly type: "task" | "decision" | "execution" | "thread";
  readonly title: string;
  readonly detail?: string | null;
  readonly at: string;
}

export interface EmployeeEditorProps {
  readonly employeeId: EmployeeId;
  /** 実 API 由来の識別情報 (name/role/department)。以前は COO 固定のべた書きだった。 */
  readonly name: string;
  readonly role: string;
  readonly department: string;
  /** 付与済みスキル (表示名 — container が /skills で名前解決) / ナレッジカテゴリ。 */
  readonly attachedSkills: readonly string[];
  readonly attachedKnowledgeCats: readonly string[];
  /**
   * 活動履歴 (GAP-008 — GET /ai-employees/{id}/activities)。
   * 未指定ならタブ自体を出さない (Rule 10)。
   */
  readonly activities?: readonly EmployeeActivity[];
  readonly defaultValues: EmployeeValues;
  readonly onSubmit: (v: EmployeeValues) => Promise<void> | void;
  readonly serverError?: string | null;
  /**
   * アイコン画像アップロード (GAP-009)。未指定ならボタン非描画 (Rule 10)。
   * 成功時は container 側で PATCH → 再取得され iconSrc が更新される。
   */
  readonly onUploadImage?: (file: File) => Promise<void> | void;
  /** アップロード進行中 (ボタン disabled + 文言)。 */
  readonly uploadingImage?: boolean;
  /** アップロード失敗の inline error (storage 未設定 503 等を誠実表示)。 */
  readonly uploadError?: string | null;
  /** icon が storage path のときの署名付き画像 URL (container が解決)。 */
  readonly iconSrc?: string | null;
  /** テンプレ specialty (ヘッダのメタ行)。 */
  readonly specialty?: string;
  /** 組織情報 (担当範囲カード)。未指定なら raw role/department を出す。 */
  readonly orgInfo?: EmployeeOrgInfo;
  /** チャット開始 (ヘッダ右)。未指定なら描画しない。 */
  readonly onStartChat?: () => void;
}

const CARD = "rounded-lg border border-border bg-white p-5";
const SECTION_TITLE = "text-base font-bold text-on-surface";

type TabKey = "profile" | "knowledge" | "activities";

export function EmployeeEditor({
  employeeId,
  name,
  role,
  department,
  attachedSkills,
  attachedKnowledgeCats,
  defaultValues,
  onSubmit,
  serverError,
  specialty,
  orgInfo,
  onStartChat,
  activities,
  onUploadImage,
  uploadingImage,
  uploadError,
  iconSrc,
}: EmployeeEditorProps) {
  const form = useAtelierForm({ schema: Schema, defaultValues });
  const selectedTone = form.watch("tone_preset");
  const selectedIcon = form.watch("icon");
  const isDirty = form.formState.isDirty;
  const [tab, setTab] = useState<TabKey>("profile");
  const [iconPickerOpen, setIconPickerOpen] = useState(false);
  const fileInputRef = React.useRef<HTMLInputElement>(null);

  // icon が storage path (画像) のときは iconName 描画をせず <img> (src) を使う
  const iconIsImage = Boolean(selectedIcon && selectedIcon.includes("/"));
  const iconProps = iconIsImage
    ? iconSrc
      ? { src: iconSrc }
      : {}
    : selectedIcon
      ? { iconName: selectedIcon }
      : {};

  // 保存成功 → 親が再取得した defaultValues でフォームを確定させる
  // (これが無いと保存後も「未保存の変更があります」が残り続ける)。
  const defaultsKey = JSON.stringify(defaultValues);
  const { reset } = form;
  React.useEffect(() => {
    reset(JSON.parse(defaultsKey) as EmployeeValues);
  }, [defaultsKey, reset]);

  const enName = name ? name.charAt(0).toUpperCase() + name.slice(1) : "";
  const metaLine = [enName, specialty, orgInfo?.deptLabel ?? department]
    .filter(Boolean)
    .join(" · ");

  return (
    <section className="flex flex-col">
      {/* プロフィールヘッダ */}
      <header className="mb-6 flex flex-wrap items-center gap-6 rounded-lg bg-gradient-to-br from-primary-container to-tertiary-container p-7">
        <EmployeeIcon
          employeeId={employeeId}
          size="lg"
          {...iconProps}
          className="h-16 w-16 text-2xl"
        />
        <div className="min-w-0 flex-1">
          <div className="mb-1 flex items-center gap-2">
            <h1 className="text-[26px] font-bold tracking-tight text-on-surface">
              {defaultValues.display_name}
            </h1>
            {orgInfo?.roleLabel || role ? (
              <span className="inline-flex items-center rounded-sm bg-primary px-2 py-0.5 text-[10.5px] font-semibold text-on-primary">
                {orgInfo?.roleLabel ?? role}
              </span>
            ) : null}
          </div>
          <p className="text-base text-on-surface-variant">{metaLine}</p>
        </div>
        {onStartChat ? (
          <button
            type="button"
            onClick={onStartChat}
            className="inline-flex h-9 items-center gap-1.5 rounded-md border border-border bg-white px-4 text-sm font-semibold text-on-surface transition-colors hover:border-primary hover:text-primary"
          >
            <MessageSquare className="h-4 w-4" aria-hidden="true" />
            チャット開始
          </button>
        ) : null}
      </header>

      {/* タブ (実切替。活動履歴は GAP-008 解消で実 API 配線) */}
      <div role="tablist" aria-label="社員詳細タブ" className="mb-6 flex gap-1 border-b border-border">
        <button
          type="button"
          role="tab"
          aria-selected={tab === "profile"}
          onClick={() => setTab("profile")}
          className={cn(
            "border-b-2 px-4 py-2.5 text-[13px] font-semibold",
            tab === "profile"
              ? "border-primary text-primary"
              : "border-transparent text-on-surface-variant hover:text-on-surface",
          )}
        >
          プロフィール
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={tab === "knowledge"}
          onClick={() => setTab("knowledge")}
          className={cn(
            "border-b-2 px-4 py-2.5 text-[13px] font-semibold",
            tab === "knowledge"
              ? "border-primary text-primary"
              : "border-transparent text-on-surface-variant hover:text-on-surface",
          )}
        >
          ナレッジ{" "}
          <span className="text-on-surface-variant">
            {attachedKnowledgeCats.length}
          </span>
        </button>
        {activities ? (
          <button
            type="button"
            role="tab"
            aria-selected={tab === "activities"}
            onClick={() => setTab("activities")}
            className={cn(
              "border-b-2 px-4 py-2.5 text-[13px] font-semibold",
              tab === "activities"
                ? "border-primary text-primary"
                : "border-transparent text-on-surface-variant hover:text-on-surface",
            )}
          >
            活動履歴{" "}
            <span className="text-on-surface-variant">{activities.length}</span>
          </button>
        ) : null}
      </div>

      {tab === "activities" && activities ? (
        <div className={CARD}>
          <h2 className={`mb-3 ${SECTION_TITLE}`}>最近の活動</h2>
          {activities.length === 0 ? (
            <p className="text-sm text-on-surface-variant">
              まだ活動がありません。タスク割当・チャット・確定事項がここに並びます。
            </p>
          ) : (
            <ul className="flex flex-col divide-y divide-border">
              {activities.map((a, i) => (
                <li key={`${a.type}-${i}`} className="flex items-start gap-3 py-2.5">
                  <span
                    className={cn(
                      "mt-0.5 inline-flex shrink-0 rounded-full px-2 py-0.5 text-[10.5px] font-bold",
                      a.type === "task" && "bg-primary-container text-on-primary-container",
                      a.type === "decision" &&
                        "bg-secondary-container text-on-secondary-container",
                      a.type === "execution" &&
                        "bg-tertiary-container text-tertiary-container-fg",
                      a.type === "thread" && "bg-surface-variant text-on-surface-variant",
                    )}
                  >
                    {a.type === "task"
                      ? "タスク"
                      : a.type === "decision"
                        ? "決定"
                        : a.type === "execution"
                          ? "実行"
                          : "チャット"}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[13px] font-medium text-on-surface">
                      {a.title}
                    </span>
                    {a.detail ? (
                      <span className="block text-[11.5px] text-on-surface-variant">
                        {a.detail}
                      </span>
                    ) : null}
                  </span>
                  <time className="shrink-0 text-[11px] tabular-nums text-on-surface-variant">
                    {new Date(a.at).toLocaleDateString("ja-JP", {
                      month: "numeric",
                      day: "numeric",
                    })}
                  </time>
                </li>
              ))}
            </ul>
          )}
        </div>
      ) : null}

      {tab === "knowledge" ? (
        <div className={CARD}>
          <h2 className={`mb-3 ${SECTION_TITLE}`}>参照ナレッジカテゴリ</h2>
          <p className="mb-3 text-sm text-on-surface-variant">
            この AI 社員が回答時に参照するナレッジのカテゴリです。
          </p>
          {attachedKnowledgeCats.length > 0 ? (
            <div className="flex flex-wrap gap-1.5">
              {attachedKnowledgeCats.map((cat) => (
                <span
                  key={cat}
                  className="inline-flex items-center rounded-full bg-tertiary-container px-3 py-1.5 text-[12.5px] font-semibold text-tertiary-container-fg"
                >
                  {cat}
                </span>
              ))}
            </div>
          ) : (
            <p className="text-sm text-on-surface-variant">
              参照カテゴリはまだ設定されていません。
            </p>
          )}
        </div>
      ) : (
        <Form form={form} onValid={onSubmit} className="gap-0">
          {serverError ? (
            <p role="alert" className="mb-4 text-label-lg text-error">
              {serverError}
            </p>
          ) : null}

          <div className="grid grid-cols-1 items-start gap-5 lg:grid-cols-[1.4fr_1fr]">
            {/* 左: 編集可能項目 */}
            <div className="flex flex-col gap-4">
              {/* 表示 */}
              <div className={CARD}>
                <h2 className={`mb-4 ${SECTION_TITLE}`}>表示</h2>
                <Field
                  label="表示名"
                  required
                  error={form.formState.errors.display_name?.message}
                  className="mb-4"
                >
                  <input
                    {...form.register("display_name")}
                    className="h-10 rounded-md border border-border bg-surface px-sm text-body-md text-on-surface focus:border-primary focus:outline-none"
                  />
                </Field>
                <div className="flex flex-col gap-xs">
                  <span className="text-label-lg font-semibold text-on-surface">
                    アイコン
                  </span>
                  <div className="flex items-center gap-3">
                    <EmployeeIcon
                      employeeId={employeeId}
                      size="lg"
                      {...iconProps}
                    />
                    {onUploadImage ? (
                      <>
                        <input
                          ref={fileInputRef}
                          type="file"
                          accept="image/png,image/jpeg,image/webp"
                          className="hidden"
                          aria-label="アイコン画像を選択"
                          onChange={(ev) => {
                            const f = ev.target.files?.[0];
                            ev.target.value = "";
                            if (f) void onUploadImage(f);
                          }}
                        />
                        <button
                          type="button"
                          disabled={Boolean(uploadingImage)}
                          onClick={() => fileInputRef.current?.click()}
                          className="inline-flex h-9 items-center rounded-md border border-border px-4 text-sm font-semibold text-on-surface transition-colors hover:border-primary disabled:opacity-50"
                        >
                          {uploadingImage ? "アップロード中…" : "画像アップロード"}
                        </button>
                      </>
                    ) : null}
                    <button
                      type="button"
                      aria-expanded={iconPickerOpen}
                      onClick={() => setIconPickerOpen((o) => !o)}
                      className="inline-flex h-9 items-center rounded-md px-3 text-sm font-semibold text-on-surface-variant transition-colors hover:bg-surface-variant"
                    >
                      Lucide から選ぶ
                    </button>
                    {selectedIcon ? (
                      <button
                        type="button"
                        onClick={() =>
                          form.setValue("icon", "", { shouldDirty: true })
                        }
                        className="inline-flex h-9 items-center rounded-md px-3 text-sm font-semibold text-on-surface-variant hover:bg-surface-variant"
                      >
                        頭文字に戻す
                      </button>
                    ) : null}
                  </div>
                  {uploadError ? (
                    <p role="alert" className="mt-1 text-label-md text-error">
                      {uploadError}
                    </p>
                  ) : null}
                  {iconPickerOpen ? (
                    <div
                      role="listbox"
                      aria-label="アイコンを選択"
                      className="mt-2 flex flex-wrap gap-2 rounded-md border border-border bg-surface p-3"
                    >
                      {EMPLOYEE_ICON_CHOICES.map((ic) => (
                        <button
                          key={ic}
                          type="button"
                          role="option"
                          aria-selected={selectedIcon === ic}
                          aria-label={`アイコン ${ic}`}
                          onClick={() => {
                            form.setValue("icon", ic, { shouldDirty: true });
                            setIconPickerOpen(false);
                          }}
                          className={cn(
                            "rounded-md border p-1 transition-colors",
                            selectedIcon === ic
                              ? "border-primary bg-primary-container"
                              : "border-transparent hover:border-border",
                          )}
                        >
                          <EmployeeIcon
                            employeeId={employeeId}
                            size="md"
                            iconName={ic}
                          />
                        </button>
                      ))}
                    </div>
                  ) : null}
                </div>
              </div>

              {/* 口調 (モック tone-option ラジオカード) */}
              <fieldset className={CARD}>
                <legend className="sr-only">口調プリセット</legend>
                <h2 className={`mb-4 ${SECTION_TITLE}`}>口調</h2>
                <div className="flex flex-col gap-1.5">
                  {TONE_PRESETS.map((tp) => {
                    const selected = selectedTone === tp;
                    return (
                      <label
                        key={tp}
                        className={cn(
                          "flex cursor-pointer items-center gap-2.5 rounded-md border px-3.5 py-3 transition-colors",
                          selected
                            ? "border-primary bg-primary-container"
                            : "border-border hover:border-primary",
                        )}
                      >
                        <input
                          type="radio"
                          value={tp}
                          {...form.register("tone_preset")}
                          className="m-0 shrink-0"
                        />
                        <span>
                          <span className="block text-[13px] font-semibold text-on-surface">
                            {TONE_LABEL[tp]}
                          </span>
                          <span
                            className={cn(
                              "mt-0.5 block text-[11.5px] italic",
                              selected
                                ? "text-primary-container-fg opacity-75"
                                : "text-on-surface-variant",
                            )}
                          >
                            {TONE_SAMPLE[tp]}
                          </span>
                        </span>
                      </label>
                    );
                  })}
                </div>
              </fieldset>

              {/* カスタム文章 */}
              <div className={CARD}>
                <h2 className={`mb-4 ${SECTION_TITLE}`}>カスタム文章（任意）</h2>
                <Field
                  label="カスタム文章（任意）"
                  description="プロンプトに追加される指示文。空欄でも構いません。"
                  error={form.formState.errors.custom_tone_text?.message}
                >
                  <textarea
                    {...form.register("custom_tone_text")}
                    rows={4}
                    placeholder="特定のキャラクター性を加える文章を入力（最大500字）"
                    className="rounded-md border border-border bg-surface px-sm py-xs text-body-md text-on-surface focus:border-primary focus:outline-none"
                  />
                </Field>
              </div>
            </div>

            {/* 右: 参照のみ */}
            <aside className="flex flex-col gap-4">
              {/* できること (スキル) — 実 API attached_skills を /skills で名前解決済 */}
              <div className={CARD}>
                <h2 className={`mb-3 ${SECTION_TITLE}`}>できること</h2>
                <p className="mb-3 text-sm text-on-surface-variant">
                  この AI 社員に付与されているスキルです。運営側で整えられているため変更できません。
                </p>
                {attachedSkills.length > 0 ? (
                  <div className="flex flex-wrap gap-1.5">
                    {attachedSkills.map((skill) => (
                      <span
                        key={skill}
                        className="inline-flex items-center gap-1.5 rounded-full bg-primary-container px-3 py-1.5 text-[12.5px] font-semibold text-primary-container-fg"
                      >
                        <Zap className="h-3.5 w-3.5" aria-hidden="true" />
                        {skill}
                      </span>
                    ))}
                  </div>
                ) : (
                  <p className="text-sm text-on-surface-variant">
                    付与されているスキルはありません。
                  </p>
                )}
              </div>

              {/* 担当範囲 — 実 API role/department + 組織関係の実算出 */}
              <div className={CARD}>
                <h2 className="mb-3 text-sm font-bold text-on-surface">担当範囲</h2>
                <div className="flex flex-col gap-2 text-sm">
                  {[
                    ["役職", orgInfo?.roleLabel ?? role],
                    ["所属", orgInfo?.deptLabel ?? department],
                    ["レポート対象", orgInfo?.reportsTo],
                    ["直属の部下", orgInfo?.subordinates],
                  ]
                    .filter(([, value]) => Boolean(value))
                    .map(([label, value]) => (
                      <div
                        key={label}
                        className="flex items-center justify-between py-1"
                      >
                        <span className="text-on-surface-variant">{label}</span>
                        <strong className="font-semibold text-on-surface">
                          {value}
                        </strong>
                      </div>
                    ))}
                </div>
              </div>
            </aside>
          </div>

          {/* 固定保存バー */}
          <div className="sticky bottom-0 z-10 mt-8 flex items-center gap-3 border-t border-border bg-surface/95 px-6 py-4 backdrop-blur">
            {isDirty ? (
              <span className="inline-flex items-center gap-1.5 text-[12.5px] font-semibold text-secondary">
                <Zap className="h-3.5 w-3.5" aria-hidden="true" />
                未保存の変更があります
              </span>
            ) : (
              <span className="text-[12.5px] text-on-surface-variant">
                変更はありません
              </span>
            )}
            <div className="ml-auto flex gap-2">
              <button
                type="button"
                onClick={() => form.reset(defaultValues)}
                className="inline-flex h-10 items-center rounded-md px-4 text-sm font-semibold text-on-surface hover:bg-surface-variant"
              >
                キャンセル
              </button>
              <button
                type="submit"
                className="inline-flex h-10 items-center gap-1.5 rounded-md bg-primary px-4 text-sm font-semibold text-on-primary hover:bg-primary-hover"
              >
                <Check className="h-4 w-4" aria-hidden="true" />
                保存
              </button>
            </div>
          </div>
        </Form>
      )}
    </section>
  );
}
