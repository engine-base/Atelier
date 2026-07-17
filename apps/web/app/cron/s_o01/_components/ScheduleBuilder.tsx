/**
 * S-O01 新規スケジュール作成フォーム（追加フォーム）。
 *
 * 以前はバックエンド未対応として送信配線を持たない静的 UI だったが、実 API
 * (POST /cron-schedules) が存在するため制御フォーム化して配線した。名前・アクション
 * (target_action)・スケジュール(cron_expression) を選び、onCreate で作成する。
 * アクション候補は API の CronTargetAction に整合させ、実在しない選択肢は出さない。
 */

"use client";

import * as React from "react";
import { useMemo, useState } from "react";
import {
  Brain,
  CalendarClock,
  ClipboardList,
  Mail,
  Plus,
  PlayCircle,
  Settings,
  Sparkles,
} from "lucide-react";

/** API schemas/cron の CronTargetAction に一致させる。 */
export type CronTargetAction =
  | "task_replay"
  | "knowledge_organize"
  | "industry_extract"
  | "report_summary"
  | "daily_digest"
  | "weekly_burndown";

interface ActionOpt {
  readonly value: CronTargetAction;
  readonly icon: React.ReactNode;
  readonly name: string;
  readonly skill: string;
  readonly tag: string;
  readonly tagCls: string;
}

const ACTIONS: readonly ActionOpt[] = [
  {
    value: "task_replay",
    icon: <PlayCircle size={14} />,
    name: "着手可のタスクを再生する",
    skill: "ソーの実装能力を起動",
    tag: "プラン枠",
    tagCls: "bg-primary-container text-on-primary-container",
  },
  {
    value: "knowledge_organize",
    icon: <Brain size={14} />,
    name: "ナレッジを整理する",
    skill: "ティチャラのナレッジ整理能力を起動",
    tag: "API",
    tagCls: "bg-secondary-container text-on-secondary-container",
  },
  {
    value: "industry_extract",
    icon: <Sparkles size={14} />,
    name: "横断パターンを抽出する",
    skill: "ティチャラの横断抽出能力を起動",
    tag: "API",
    tagCls: "bg-secondary-container text-on-secondary-container",
  },
  {
    value: "report_summary",
    icon: <Mail size={14} />,
    name: "進捗レポートを配信する",
    skill: "スティーブのレポート生成能力を起動",
    tag: "API",
    tagCls: "bg-secondary-container text-on-secondary-container",
  },
  {
    value: "daily_digest",
    icon: <ClipboardList size={14} />,
    name: "日次ダイジェストを配信する",
    skill: "スティーブのサマリー能力を起動",
    tag: "API",
    tagCls: "bg-secondary-container text-on-secondary-container",
  },
  {
    value: "weekly_burndown",
    icon: <CalendarClock size={14} />,
    name: "週次バーンダウンを集計する",
    skill: "バックエンドのみ（AI 社員なし）",
    tag: "無料",
    tagCls: "bg-tertiary-container text-on-tertiary-container",
  },
];

interface PresetOpt {
  readonly label: string;
  readonly cron: string | null; // null = カスタム(下の cron セルを使う)
}

const PRESETS: readonly PresetOpt[] = [
  { label: "毎日 深夜 2:00", cron: "0 2 * * *" },
  { label: "毎日 深夜 3:00", cron: "0 3 * * *" },
  { label: "毎週月曜 4:00", cron: "0 4 * * 1" },
  { label: "毎月 1 日 9:00", cron: "0 9 1 * *" },
  { label: "毎時 0 分", cron: "0 * * * *" },
  { label: "カスタム", cron: null },
];

interface CronCell {
  readonly key: "min" | "hour" | "dom" | "mon" | "dow";
  readonly label: string;
  readonly def: string;
}

const CRON_CELLS: readonly CronCell[] = [
  { key: "min", label: "分", def: "0" },
  { key: "hour", label: "時", def: "3" },
  { key: "dom", label: "日", def: "*" },
  { key: "mon", label: "月", def: "*" },
  { key: "dow", label: "曜", def: "*" },
];

export interface ScheduleBuilderProps {
  readonly onCreate: (payload: {
    name: string;
    cron_expression: string;
    target_action: CronTargetAction;
  }) => void;
  readonly submitting?: boolean;
  readonly error?: string | null;
}

export function ScheduleBuilder({
  onCreate,
  submitting = false,
  error,
}: ScheduleBuilderProps) {
  const [name, setName] = useState("");
  const [action, setAction] = useState<CronTargetAction>("task_replay");
  const [presetIdx, setPresetIdx] = useState(1);
  const [advOpen, setAdvOpen] = useState(false);
  const [cells, setCells] = useState<Record<CronCell["key"], string>>({
    min: "0",
    hour: "3",
    dom: "*",
    mon: "*",
    dow: "*",
  });

  const isCustom = PRESETS[presetIdx]?.cron === null;
  const cronExpression = useMemo(() => {
    const preset = PRESETS[presetIdx];
    if (preset && preset.cron !== null) return preset.cron;
    return `${cells.min} ${cells.hour} ${cells.dom} ${cells.mon} ${cells.dow}`
      .replace(/\s+/g, " ")
      .trim();
  }, [presetIdx, cells]);

  const canSubmit = name.trim().length > 0 && cronExpression.length > 0 && !submitting;

  const submit = (): void => {
    if (!canSubmit) return;
    onCreate({ name: name.trim(), cron_expression: cronExpression, target_action: action });
  };

  return (
    <aside>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
        className="rounded-lg border border-border bg-white px-6 py-5 lg:sticky lg:top-20"
      >
        <div className="text-[15px] font-bold text-on-surface">
          新規スケジュールを作成
        </div>
        <p className="mb-[18px] text-xs text-on-surface-variant">
          何をいつ動かすか、3 ステップで決めるだけです。
        </p>

        {/* 1. 名前 */}
        <div className="mb-4">
          <label
            htmlFor="cron-name"
            className="mb-1.5 block text-xs font-bold text-on-surface"
          >
            1. 名前
          </label>
          <input
            id="cron-name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            className="w-full rounded-md border border-border bg-white px-3 py-2 text-[13px] text-on-surface outline-none focus:border-primary"
            placeholder="例：週次の進捗サマリー配信"
          />
        </div>

        {/* 2. 何をする？ */}
        <div className="mb-4">
          <span className="mb-1.5 block text-xs font-bold text-on-surface">
            2. 何をする？
            <span className="ml-1.5 font-medium text-on-surface-variant">
              （AI 社員が必要な場合は能力名も表示）
            </span>
          </span>
          <div className="grid gap-1.5">
            {ACTIONS.map((a) => {
              const selected = a.value === action;
              return (
                <button
                  key={a.value}
                  type="button"
                  aria-pressed={selected}
                  onClick={() => setAction(a.value)}
                  className={`grid grid-cols-[28px_1fr_auto] items-center gap-2.5 rounded-md border px-3 py-2.5 text-left transition-colors ${
                    selected
                      ? "border-primary bg-primary-container"
                      : "border-border hover:border-primary hover:bg-surface"
                  }`}
                >
                  <span
                    className={`flex h-7 w-7 items-center justify-center rounded-md ${
                      selected
                        ? "bg-primary text-on-primary"
                        : "bg-surface-variant text-on-surface-variant"
                    }`}
                  >
                    {a.icon}
                  </span>
                  <span className="min-w-0">
                    <span className="block text-[12.5px] font-bold text-on-surface">
                      {a.name}
                    </span>
                    <span className="mt-px block text-[11px] text-on-surface-variant">
                      {a.skill}
                    </span>
                  </span>
                  <span
                    className={`rounded-full px-2 py-0.5 text-[10.5px] font-semibold ${a.tagCls}`}
                  >
                    {a.tag}
                  </span>
                </button>
              );
            })}
          </div>
        </div>

        {/* 3. いつ動かす？ */}
        <div className="mb-4">
          <span className="mb-1.5 block text-xs font-bold text-on-surface">
            3. いつ動かす？
          </span>
          <div className="grid grid-cols-2 gap-1.5">
            {PRESETS.map((p, i) => (
              <button
                key={p.label}
                type="button"
                aria-pressed={i === presetIdx}
                onClick={() => {
                  setPresetIdx(i);
                  if (p.cron === null) setAdvOpen(true);
                }}
                className={`rounded-md px-2.5 py-2 text-center text-[11.5px] font-semibold transition-colors ${
                  i === presetIdx
                    ? "bg-primary text-on-primary"
                    : "bg-surface-variant text-on-surface-variant hover:bg-primary-container hover:text-on-primary-container"
                }`}
              >
                {p.label}
              </button>
            ))}
          </div>

          <button
            type="button"
            onClick={() => setAdvOpen((v) => !v)}
            aria-expanded={advOpen}
            className="mt-2 inline-flex items-center gap-1 text-[11.5px] text-primary"
          >
            <Settings size={11} />
            詳細設定（cron 式で指定したい）
          </button>

          {advOpen ? (
            <div className="mt-3 rounded-md bg-surface-variant p-3">
              <div className="mb-1.5 grid grid-cols-5 gap-1.5">
                {CRON_CELLS.map((c) => (
                  <div
                    key={c.key}
                    className="rounded-sm bg-white px-1.5 py-1.5 text-center"
                  >
                    <div className="mb-0.5 text-[9.5px] font-bold uppercase tracking-wide text-on-surface-variant">
                      {c.label}
                    </div>
                    <input
                      value={cells[c.key]}
                      onChange={(e) => {
                        const v = e.target.value;
                        setCells((prev) => ({ ...prev, [c.key]: v }));
                        // cron セルを触ったら「カスタム」に切り替える。
                        const customIdx = PRESETS.findIndex((p) => p.cron === null);
                        if (!isCustom && customIdx >= 0) setPresetIdx(customIdx);
                      }}
                      aria-label={`cron ${c.label}`}
                      className="w-full border-none bg-transparent text-center font-mono text-[13px] font-bold text-on-surface outline-none"
                    />
                  </div>
                ))}
              </div>
              <div className="mt-1 font-mono text-[11px] text-on-surface-variant">
                cron: {cronExpression}
              </div>
            </div>
          ) : null}
        </div>

        {error ? (
          <p role="alert" className="mb-3 text-[12px] text-error">
            {error}
          </p>
        ) : null}

        <button
          type="submit"
          disabled={!canSubmit}
          className="inline-flex w-full items-center justify-center gap-1.5 rounded-md bg-primary px-4 py-3 text-[13.5px] font-bold text-on-primary transition-[filter] hover:brightness-110 disabled:opacity-50"
        >
          <Plus size={14} />
          {submitting ? "作成中…" : "このスケジュールを作成"}
        </button>
      </form>
    </aside>
  );
}
