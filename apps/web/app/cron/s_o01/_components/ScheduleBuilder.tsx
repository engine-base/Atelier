/**
 * S-O01 新規スケジュール作成フォーム（追加フォーム）。
 * 06_mockups/cron/S-O01-schedule.html の .builder-card に忠実な静的 UI。
 * バックエンド未対応のため送信配線は持たない（表示のみ）。
 */

"use client";

import * as React from "react";
import {
  Brain,
  Mail,
  Plus,
  PlayCircle,
  Settings,
  ShieldCheck,
  Sparkles,
} from "lucide-react";

interface ActionOpt {
  readonly icon: React.ReactNode;
  readonly name: string;
  readonly skill: string;
  readonly tag: string;
  readonly tagCls: string;
  readonly selected?: boolean;
}

const ACTIONS: ReadonlyArray<ActionOpt> = [
  {
    icon: <PlayCircle size={14} />,
    name: "着手可のタスクを再生する",
    skill: "ソーの実装能力を起動",
    tag: "プラン枠",
    tagCls: "bg-primary-container text-on-primary-container",
  },
  {
    icon: <Brain size={14} />,
    name: "ナレッジを整理する",
    skill: "ティチャラのナレッジ整理能力を起動",
    tag: "API",
    tagCls: "bg-secondary-container text-on-secondary-container",
    selected: true,
  },
  {
    icon: <Sparkles size={14} />,
    name: "横断パターンを抽出する",
    skill: "ティチャラの横断抽出能力を起動",
    tag: "API",
    tagCls: "bg-secondary-container text-on-secondary-container",
  },
  {
    icon: <ShieldCheck size={14} />,
    name: "整合性チェックを実行する",
    skill: "バックエンドのみ（AI 社員なし）",
    tag: "無料",
    tagCls: "bg-tertiary-container text-on-tertiary-container",
  },
  {
    icon: <Mail size={14} />,
    name: "進捗レポートを配信する",
    skill: "スティーブのレポート生成能力を起動",
    tag: "API",
    tagCls: "bg-secondary-container text-on-secondary-container",
  },
];

const PRESETS: ReadonlyArray<string> = [
  "毎日 深夜 2:00",
  "毎日 深夜 3:00",
  "毎週月曜 4:00",
  "毎月 1 日 9:00",
  "毎時 0 分",
  "カスタム",
];

const CRON_CELLS: ReadonlyArray<{ label: string; value: string }> = [
  { label: "分", value: "0" },
  { label: "時", value: "3" },
  { label: "日", value: "*" },
  { label: "月", value: "*" },
  { label: "曜", value: "*" },
];

export function ScheduleBuilder() {
  const [advOpen, setAdvOpen] = React.useState(false);

  return (
    <aside>
      <div className="rounded-lg border border-border bg-white px-6 py-5 lg:sticky lg:top-20">
        <div className="text-[15px] font-bold text-on-surface">
          新規スケジュールを作成
        </div>
        <p className="mb-[18px] text-xs text-on-surface-variant">
          何をいつ動かすか、3 ステップで決めるだけです。
        </p>

        {/* 1. 名前 */}
        <div className="mb-4">
          <label className="mb-1.5 block text-xs font-bold text-on-surface">
            1. 名前
          </label>
          <input
            className="w-full rounded-md border border-border bg-white px-3 py-2 text-[13px] text-on-surface outline-none focus:border-primary"
            placeholder="例：週次の進捗サマリー配信"
          />
        </div>

        {/* 2. 何をする？ */}
        <div className="mb-4">
          <label className="mb-1.5 block text-xs font-bold text-on-surface">
            2. 何をする？
            <span className="ml-1.5 font-medium text-on-surface-variant">
              （AI 社員が必要な場合は能力名も表示）
            </span>
          </label>
          <div className="grid gap-1.5">
            {ACTIONS.map((a) => (
              <button
                key={a.name}
                type="button"
                aria-pressed={a.selected ?? false}
                className={`grid grid-cols-[28px_1fr_auto] items-center gap-2.5 rounded-md border px-3 py-2.5 text-left transition-colors ${
                  a.selected
                    ? "border-primary bg-primary-container"
                    : "border-border hover:border-primary hover:bg-surface"
                }`}
              >
                <span
                  className={`flex h-7 w-7 items-center justify-center rounded-md ${
                    a.selected
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
            ))}
          </div>
        </div>

        {/* 3. いつ動かす？ */}
        <div className="mb-4">
          <label className="mb-1.5 block text-xs font-bold text-on-surface">
            3. いつ動かす？
          </label>
          <div className="grid grid-cols-2 gap-1.5">
            {PRESETS.map((p, i) => (
              <button
                key={p}
                type="button"
                aria-pressed={i === 1}
                className={`rounded-md px-2.5 py-2 text-center text-[11.5px] font-semibold transition-colors ${
                  i === 1
                    ? "bg-primary text-on-primary"
                    : "bg-surface-variant text-on-surface-variant hover:bg-primary-container hover:text-on-primary-container"
                }`}
              >
                {p}
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
                    key={c.label}
                    className="rounded-sm bg-white px-1.5 py-1.5 text-center"
                  >
                    <div className="mb-0.5 text-[9.5px] font-bold uppercase tracking-wide text-on-surface-variant">
                      {c.label}
                    </div>
                    <input
                      defaultValue={c.value}
                      aria-label={`cron ${c.label}`}
                      className="w-full border-none bg-transparent text-center font-mono text-[13px] font-bold text-on-surface outline-none"
                    />
                  </div>
                ))}
              </div>
              <div className="mt-1 text-[11px] italic text-on-surface-variant">
                読み方：毎日 朝 3:00 に実行されます
              </div>
            </div>
          ) : null}
        </div>

        {/* タイムゾーン */}
        <div className="mb-4">
          <label className="mb-1.5 block text-xs font-bold text-on-surface">
            タイムゾーン
          </label>
          <select className="w-full rounded-md border border-border bg-white px-3 py-2 text-[13px] text-on-surface outline-none focus:border-primary">
            <option>Asia/Tokyo（推奨）</option>
            <option>UTC</option>
          </select>
        </div>

        <button
          type="button"
          className="inline-flex w-full items-center justify-center gap-1.5 rounded-md bg-primary px-4 py-3 text-[13.5px] font-bold text-on-primary transition-[filter] hover:brightness-110"
        >
          <Plus size={14} />
          このスケジュールを作成
        </button>
      </div>
    </aside>
  );
}
