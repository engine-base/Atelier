/**
 * S-C02 AI 社員詳細・編集 — T-UC-07 / F-VIS 是正
 *
 * モック 06_mockups/employee/S-C02-detail.html に忠実な本文を描画する:
 *   社員ヘッダ(avatar-xl + 表示名 + 役職バッジ + プロフィール) → タブ → 2 カラム
 *   (左: 表示 / 口調 / カスタム文章 の編集フォーム, 右: できること / 担当範囲 / 最近の活動)
 *   → 固定保存バー。編集可能フィールドは実 API (PATCH /ai-employees/{id}) に配線。
 *   display_name / tone_preset / custom_tone_text を実 props にバインドする。
 */

"use client";

import * as React from "react";
import { z } from "zod";
import { Check, Zap } from "lucide-react";

import {
  EmployeeIcon,
  type EmployeeId,
} from "../../../../components/EmployeeIcon";
import { Field } from "../../../../components/forms/Field";
import { Form, useAtelierForm } from "../../../../components/forms/Form";

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
});
export type EmployeeValues = z.infer<typeof Schema>;

export interface EmployeeEditorProps {
  readonly employeeId: EmployeeId;
  /** 実 API 由来の識別情報 (name/role/department)。以前は COO 固定のべた書きだった。 */
  readonly name: string;
  readonly role: string;
  readonly department: string;
  /** 付与済みスキル / ナレッジカテゴリ (実 API attached_*)。 */
  readonly attachedSkills: readonly string[];
  readonly attachedKnowledgeCats: readonly string[];
  readonly defaultValues: EmployeeValues;
  readonly onSubmit: (v: EmployeeValues) => Promise<void> | void;
  readonly serverError?: string | null;
}

const CARD = "rounded-lg border border-border bg-white p-5";
const SECTION_TITLE = "text-base font-bold text-on-surface";

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
}: EmployeeEditorProps) {
  const form = useAtelierForm({ schema: Schema, defaultValues });
  const selectedTone = form.watch("tone_preset");
  const isDirty = form.formState.isDirty;

  return (
    <section className="flex flex-col">
      {/* プロフィールヘッダ */}
      <header className="mb-6 flex items-center gap-6 rounded-lg bg-gradient-to-br from-primary-container to-tertiary-container p-7">
        <EmployeeIcon
          employeeId={employeeId}
          size="lg"
          className="h-16 w-16 text-2xl"
        />
        <div className="min-w-0 flex-1">
          <div className="mb-1 flex items-center gap-2">
            <h1 className="text-[26px] font-bold tracking-tight text-on-surface">
              {defaultValues.display_name}
            </h1>
            {role ? (
              <span className="inline-flex items-center rounded-sm bg-primary-container px-2 py-0.5 text-[10.5px] font-semibold text-primary-container-fg">
                {role}
              </span>
            ) : null}
          </div>
          <p className="text-base text-on-surface-variant">
            {[name, department].filter(Boolean).join(" · ")}
          </p>
        </div>
      </header>

      {/* タブ */}
      <div className="mb-6 flex gap-1 border-b border-border">
        <button
          type="button"
          aria-current="page"
          className="border-b-2 border-primary px-4 py-2.5 text-[13px] font-semibold text-primary"
        >
          プロフィール
        </button>
        <button
          type="button"
          className="border-b-2 border-transparent px-4 py-2.5 text-[13px] font-semibold text-on-surface-variant hover:text-on-surface"
        >
          ナレッジ{" "}
          <span className="text-on-surface-variant">
            {attachedKnowledgeCats.length}
          </span>
        </button>
        <button
          type="button"
          className="border-b-2 border-transparent px-4 py-2.5 text-[13px] font-semibold text-on-surface-variant hover:text-on-surface"
        >
          活動履歴
        </button>
      </div>

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
                {/* 画像アップロードAPI・アイコンピッカーが未提供のため、機能を偽らず非活性。 */}
                <div className="flex items-center gap-3">
                  <EmployeeIcon employeeId={employeeId} size="lg" />
                  <button
                    type="button"
                    disabled
                    title="アイコン画像のアップロードは準備中です"
                    className="inline-flex h-9 cursor-not-allowed items-center rounded-md border border-border px-4 text-sm font-semibold text-on-surface-variant opacity-50"
                  >
                    画像アップロード
                  </button>
                  <button
                    type="button"
                    disabled
                    title="アイコンの選択は準備中です"
                    className="inline-flex h-9 cursor-not-allowed items-center rounded-md px-4 text-sm font-semibold text-on-surface-variant opacity-50"
                  >
                    Lucide から選ぶ
                  </button>
                </div>
              </div>
            </div>

            {/* 口調 (パーソナリティ設定) */}
            <div className={CARD}>
              <h2 className={`mb-4 ${SECTION_TITLE}`}>口調</h2>
              <Field
                label="口調プリセット"
                required
                error={form.formState.errors.tone_preset?.message}
              >
                <select
                  {...form.register("tone_preset")}
                  className="h-10 rounded-md border border-border bg-surface px-sm text-body-md text-on-surface focus:border-primary focus:outline-none"
                >
                  {TONE_PRESETS.map((tp) => (
                    <option key={tp} value={tp}>
                      {TONE_LABEL[tp]}
                    </option>
                  ))}
                </select>
              </Field>
              <p className="mt-3 rounded-md border border-border bg-primary-container px-3 py-2.5 text-[11.5px] italic text-primary-container-fg">
                {TONE_SAMPLE[selectedTone] ?? TONE_SAMPLE.polite}
              </p>
            </div>

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
            {/* できること (スキル) — 実 API attached_skills 由来 */}
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

            {/* 担当範囲 — 実 API role/department 由来 */}
            <div className={CARD}>
              <h2 className="mb-3 text-sm font-bold text-on-surface">担当範囲</h2>
              <div className="flex flex-col gap-2 text-sm">
                {[
                  ["役職", role],
                  ["所属", department],
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

            {/* 最近の活動 — 活動履歴 API 未提供のため空状態 (偽ログを出さない) */}
            <div className={CARD}>
              <h2 className="mb-3 text-sm font-bold text-on-surface">最近の活動</h2>
              <p className="text-[12.5px] text-on-surface-variant">
                活動履歴はまだありません。
              </p>
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
              className="inline-flex h-10 items-center gap-1.5 rounded-md bg-primary px-4 text-sm font-semibold text-on-primary hover:bg-[#1E54D8]"
            >
              <Check className="h-4 w-4" aria-hidden="true" />
              保存
            </button>
          </div>
        </div>
      </Form>
    </section>
  );
}
