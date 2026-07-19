/**
 * S-O01 自動スケジュール — T-UC-25 / モック忠実再構築 v2
 *
 * 06_mockups/cron/S-O01-schedule.html に準拠:
 *   - 次に動くスケジュール (next_run_at 昇順の時系列カード + 更新ボタン)
 *   - カテゴリ別グループ (実装の夜間自動進行 / ナレッジ整理 / 通知・レポート配信)
 *   - 各行: アイコン + 名前 + 説明 + コスト/担当タグ + cron 日本語ラベル + cron 式 +
 *     次回 + トグル + 削除 (2 段階)
 *
 * 実行履歴 (mock) は cron 実行履歴 API が無いため未描画 (GAP-013)。
 * 法令・運用の必須ジョブ (mock) はプラットフォーム側ジョブの可視化 API が無いため
 * 未描画 (GAP-014) — 偽の稼働状況を出さない。
 * データ配線・props・export・aria-label は不変（vitest / e2e が参照）。
 */

"use client";

import * as React from "react";
import { useState } from "react";
import {
  Brain,
  CalendarClock,
  ClipboardList,
  Clock,
  Mail,
  PlayCircle,
  RefreshCw,
  Sparkles,
  Trash2,
} from "lucide-react";

import { cn } from "../../../../lib/cn";

export interface CronJob {
  readonly id: string;
  readonly name: string;
  readonly schedule: string;
  readonly enabled: boolean;
  readonly nextRunAt: string;
  /** target_action (task_replay 等)。グループ分け・アイコン・タグに使う。 */
  readonly targetAction?: string;
  /** next_run_at の ISO 生値 (相対時刻の実算出用)。 */
  readonly nextRunIso?: string | null;
}

export interface CronScheduleProps {
  readonly jobs: readonly CronJob[];
  readonly onToggle: (id: string, enabled: boolean) => void;
  /** 即時実行。未指定なら「即時実行」ボタンを出さない（バックエンド未対応時など）。 */
  readonly onRunNow?: (id: string) => void;
  /** 削除。未指定なら削除ボタンを出さない。 */
  readonly onDelete?: (id: string) => void;
  /** 「次に動くスケジュール」の更新ボタン (一覧再取得)。 */
  readonly onRefresh?: () => void;
}

/** target_action ごとの表示仕様 (ScheduleBuilder の ACTIONS と整合)。 */
interface ActionSpec {
  readonly group: "impl" | "knowledge" | "notify";
  readonly icon: React.ReactNode;
  readonly iconTone: string;
  readonly desc: string;
  readonly costTag: string;
  readonly costTone: string;
  readonly staff: string;
}

const ACTION_SPEC: Record<string, ActionSpec> = {
  task_replay: {
    group: "impl",
    icon: <PlayCircle size={18} />,
    iconTone: "bg-primary-container text-primary-container-fg",
    desc: "タスクボードの「着手可」レーンにあるタスクを、同時実行枠の範囲で自動的に再生します。",
    costTag: "Claude プラン枠を使用",
    costTone: "bg-primary-container text-primary-container-fg",
    staff: "ソー（実装）",
  },
  knowledge_organize: {
    group: "knowledge",
    icon: <Brain size={18} />,
    iconTone: "bg-tertiary-container text-tertiary-container-fg",
    desc: "新規追加されたナレッジに対してカテゴリ分け・タグ付け・重複統合を実行します。",
    costTag: "BYOK API 使用",
    costTone: "bg-secondary-container text-secondary-container-fg",
    staff: "ティチャラ",
  },
  industry_extract: {
    group: "knowledge",
    icon: <Sparkles size={18} />,
    iconTone: "bg-tertiary-container text-tertiary-container-fg",
    desc: "複数案件で類似度の高いパターンを検出して、共通ナレッジへの昇格を承認待ちに提案します。",
    costTag: "BYOK API 使用",
    costTone: "bg-secondary-container text-secondary-container-fg",
    staff: "ティチャラ",
  },
  report_summary: {
    group: "notify",
    icon: <Mail size={18} />,
    iconTone: "bg-secondary-container text-secondary-container-fg",
    desc: "進捗をまとめたレポートを生成して関係者へ配信します。",
    costTag: "BYOK API 使用",
    costTone: "bg-secondary-container text-secondary-container-fg",
    staff: "スティーブ",
  },
  daily_digest: {
    group: "notify",
    icon: <ClipboardList size={18} />,
    iconTone: "bg-secondary-container text-secondary-container-fg",
    desc: "当日の活動をまとめた日次ダイジェストを配信します。",
    costTag: "BYOK API 使用",
    costTone: "bg-secondary-container text-secondary-container-fg",
    staff: "スティーブ",
  },
  weekly_burndown: {
    group: "notify",
    icon: <CalendarClock size={18} />,
    iconTone: "bg-surface-variant text-on-surface-variant",
    desc: "週次のバーンダウンを集計します。バックエンドのみで AI 社員は使いません。",
    costTag: "コスト無料",
    costTone: "bg-tertiary-container text-tertiary-container-fg",
    staff: "バックエンドのみ",
  },
};

const FALLBACK_SPEC: ActionSpec = {
  group: "impl",
  icon: <Clock size={18} />,
  iconTone: "bg-primary-container text-primary-container-fg",
  desc: "",
  costTag: "—",
  costTone: "bg-surface-variant text-on-surface-variant",
  staff: "—",
};

const GROUPS: readonly {
  key: ActionSpec["group"];
  name: string;
  desc: string;
  icon: React.ReactNode;
  tone: string;
}[] = [
  {
    key: "impl",
    name: "実装の夜間自動進行",
    desc: "あなたが寝てる間に着手可タスクを自動消化（Claude プラン枠を使用）",
    icon: <PlayCircle size={16} />,
    tone: "bg-primary-container text-primary-container-fg",
  },
  {
    key: "knowledge",
    name: "ナレッジ整理（ティチャラ）",
    desc: "蓄積されたナレッジの整理・統合・横断パターン抽出。BYOK API キーを使用",
    icon: <Brain size={16} />,
    tone: "bg-tertiary-container text-tertiary-container-fg",
  },
  {
    key: "notify",
    name: "通知・レポート配信",
    desc: "クライアントや関係者への定期通知",
    icon: <Mail size={16} />,
    tone: "bg-secondary-container text-secondary-container-fg",
  },
];

const DOW = ["日", "月", "火", "水", "木", "金", "土"];

/** cron 式 → 人間可読ラベル (単純パターンのみ。他は cron 式のまま)。 */
export function cronLabel(expr: string): string {
  const m = /^(\d{1,2})\s+(\S+)\s+(\S+)\s+\*\s+(\S+)$/.exec(expr.trim());
  if (!m) return expr;
  const [, min, hour, dom, dow] = m as unknown as [string, string, string, string, string];
  const mm = min.padStart(2, "0");
  if (hour === "*" && dom === "*" && dow === "*") return `毎時 ${Number(min)} 分`;
  if (!/^\d{1,2}$/.test(hour)) return expr;
  const h = Number(hour);
  const time = `${h}:${mm}`;
  const period = h < 5 ? "深夜" : h < 11 ? "朝" : h < 18 ? "昼" : "夜";
  if (dom === "*" && dow === "*") return `毎日 ${period} ${time}`;
  if (dom === "*" && /^\d$/.test(dow)) return `毎週 ${DOW[Number(dow)] ?? dow}曜 ${time}`;
  if (/^\d{1,2}$/.test(dom) && dow === "*") return `毎月 ${Number(dom)} 日 ${period} ${time}`;
  return expr;
}

/** next_run_at までの相対表示 (あと X 時間 Y 分 / あと X 日 Y 時間)。 */
function relUntil(iso: string): string {
  const diff = new Date(iso).getTime() - Date.now();
  if (diff <= 0) return "まもなく";
  const min = Math.floor(diff / 60000);
  if (min < 60) return `あと ${min} 分`;
  const hours = Math.floor(min / 60);
  if (hours < 24) return `あと ${hours} 時間 ${String(min % 60).padStart(2, "0")} 分`;
  const days = Math.floor(hours / 24);
  return `あと ${days} 日 ${hours % 24} 時間`;
}

function fmtWhen(iso: string): string {
  const d = new Date(iso);
  return `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")} (${DOW[d.getDay()]})`;
}

/** 状態 pill（稼働中 / 停止中）— 角丸 full・先頭 6px ドット。 */
function StatusPill({ enabled }: { readonly enabled: boolean }) {
  const cls = enabled
    ? "bg-tertiary-container text-on-tertiary-container"
    : "bg-surface-variant text-on-surface-variant";
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[11px] font-semibold ${cls}`}
    >
      <span aria-hidden className="h-1.5 w-1.5 rounded-full bg-current" />
      {enabled ? "稼働中" : "停止中"}
    </span>
  );
}

/**
 * 有効/無効トグル。見た目はスイッチだが実体は checkbox（e2e が
 * `input[type=checkbox]` を可視・クリック・isChecked で検証するため維持）。
 */
function EnableToggle({
  job,
  onToggle,
}: {
  readonly job: CronJob;
  readonly onToggle: (id: string, enabled: boolean) => void;
}) {
  return (
    <span className="relative inline-flex h-5 w-9 shrink-0 justify-self-end">
      <input
        type="checkbox"
        checked={job.enabled}
        onChange={(e) => onToggle(job.id, e.target.checked)}
        aria-label={`${job.name} を ${job.enabled ? "無効" : "有効"} 化`}
        className="peer absolute inset-0 z-10 m-0 cursor-pointer opacity-0"
      />
      <span
        aria-hidden
        className={`pointer-events-none absolute inset-0 rounded-full transition-colors ${
          job.enabled ? "bg-tertiary" : "bg-surface-variant"
        }`}
      />
      <span
        aria-hidden
        className={`pointer-events-none absolute top-0.5 h-4 w-4 rounded-full bg-white shadow transition-all ${
          job.enabled ? "left-[18px]" : "left-0.5"
        }`}
      />
    </span>
  );
}

function ScheduleRow({
  job,
  onToggle,
  onRunNow,
  onDelete,
}: {
  readonly job: CronJob;
  readonly onToggle: (id: string, enabled: boolean) => void;
  readonly onRunNow?: (id: string) => void;
  readonly onDelete?: (id: string) => void;
}) {
  const [confirming, setConfirming] = useState(false);
  const spec = ACTION_SPEC[job.targetAction ?? ""] ?? FALLBACK_SPEC;
  return (
    <li
      className={`grid grid-cols-[44px_1fr_auto] items-center gap-4 rounded-lg border border-border bg-white p-4 transition-colors hover:border-primary hover:shadow-sm sm:grid-cols-[44px_1fr_180px_auto_auto] ${
        job.enabled ? "" : "opacity-60"
      }`}
    >
      {/* アイコン */}
      <span
        className={cn(
          "flex h-11 w-11 items-center justify-center rounded-md",
          spec.iconTone,
        )}
      >
        {spec.icon}
      </span>

      {/* 名前 + 説明 + タグ */}
      <div className="min-w-0">
        <div className="truncate text-sm font-bold text-on-surface">
          {job.name}
        </div>
        {spec.desc ? (
          <p className="mt-0.5 text-[12px] leading-[1.55] text-on-surface-variant">
            {spec.desc}
          </p>
        ) : null}
        <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
          <StatusPill enabled={job.enabled} />
          <span
            className={cn(
              "inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10.5px] font-semibold",
              spec.costTone,
            )}
          >
            {spec.costTag}
          </span>
          <span className="inline-flex items-center gap-1 rounded-full bg-surface-variant px-2 py-0.5 text-[10.5px] font-semibold text-on-surface-variant">
            {spec.staff}
          </span>
        </div>
      </div>

      {/* 人間可読ラベル + cron 式 + 次回実行 */}
      <div className="col-span-3 text-left sm:col-span-1 sm:text-right">
        <div className="text-[13px] font-bold text-on-surface">
          {cronLabel(job.schedule)}
        </div>
        <code
          title="cron 式"
          className="font-mono text-[10.5px] tabular-nums text-on-surface-variant"
        >
          {job.schedule}
        </code>
        <div className="mt-1 text-[11px] tabular-nums text-on-surface-variant">
          次回 {job.nextRunAt}
        </div>
      </div>

      {/* 有効トグル */}
      <EnableToggle job={job} onToggle={onToggle} />

      {/* 操作 */}
      <div className="flex items-center justify-end gap-1">
        {onRunNow ? (
          <button
            type="button"
            onClick={() => onRunNow(job.id)}
            aria-label={`${job.name} を今すぐ実行`}
            className="inline-flex h-8 w-8 items-center justify-center rounded-md text-primary transition-colors hover:bg-primary-container"
          >
            <PlayCircle size={16} />
          </button>
        ) : null}
        {onDelete ? (
          confirming ? (
            <span className="inline-flex items-center gap-1">
              <button
                type="button"
                onClick={() => {
                  onDelete(job.id);
                  setConfirming(false);
                }}
                aria-label={`${job.name} を削除`}
                className="inline-flex h-8 items-center rounded-md bg-error px-2 text-[11px] font-semibold text-on-error transition-colors hover:opacity-90"
              >
                削除
              </button>
              <button
                type="button"
                onClick={() => setConfirming(false)}
                aria-label="削除を取り消す"
                className="inline-flex h-8 items-center rounded-md px-2 text-[11px] font-semibold text-on-surface transition-colors hover:bg-surface-variant"
              >
                取消
              </button>
            </span>
          ) : (
            <button
              type="button"
              onClick={() => setConfirming(true)}
              aria-label={`${job.name} を削除`}
              className="inline-flex h-8 w-8 items-center justify-center rounded-md text-on-surface-variant transition-colors hover:bg-surface-variant hover:text-error"
            >
              <Trash2 size={16} />
            </button>
          )
        ) : null}
      </div>
    </li>
  );
}

export function CronSchedule({
  jobs,
  onToggle,
  onRunNow,
  onDelete,
  onRefresh,
}: CronScheduleProps) {
  // 次に動くスケジュール: enabled かつ next_run_at があるものを昇順で最大 5 件
  const upcoming = jobs
    .filter((j) => j.enabled && j.nextRunIso)
    .sort(
      (a, b) =>
        new Date(a.nextRunIso!).getTime() - new Date(b.nextRunIso!).getTime(),
    )
    .slice(0, 5);

  const grouped = GROUPS.map((g) => ({
    ...g,
    rows: jobs.filter(
      (j) => (ACTION_SPEC[j.targetAction ?? ""] ?? FALLBACK_SPEC).group === g.key,
    ),
  })).filter((g) => g.rows.length > 0);

  return (
    <section aria-label="自動スケジュール" className="flex flex-col gap-5">
      {/* 次に動くスケジュール (モック upcoming-card) */}
      {upcoming.length > 0 ? (
        <div className="overflow-hidden rounded-lg border border-border bg-white">
          <div className="flex items-center border-b border-border bg-surface-variant px-5 py-4">
            <div>
              <div className="text-sm font-bold text-on-surface">
                次に動くスケジュール
              </div>
              <div className="mt-0.5 text-[11.5px] text-on-surface-variant">
                直近で {upcoming.length} 件が稼働予定
              </div>
            </div>
            {onRefresh ? (
              <button
                type="button"
                onClick={onRefresh}
                className="ml-auto inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-semibold text-on-surface-variant transition-colors hover:bg-white hover:text-on-surface"
              >
                <RefreshCw size={13} aria-hidden="true" />
                更新
              </button>
            ) : null}
          </div>
          <ol className="py-1">
            {upcoming.map((j) => {
              const spec = ACTION_SPEC[j.targetAction ?? ""] ?? FALLBACK_SPEC;
              return (
                <li
                  key={j.id}
                  className="grid grid-cols-[36px_1fr] items-center gap-x-3 gap-y-1.5 border-b border-border px-5 py-3.5 last:border-b-0 sm:grid-cols-[150px_1px_36px_1fr] sm:gap-4"
                >
                  {/* モバイルは 時刻 → アイコン+名前 の縦積み (150px 固定列だと名前が潰れる) */}
                  <div className="col-span-2 sm:col-span-1">
                    <span className="text-[13px] font-bold tabular-nums text-primary">
                      {relUntil(j.nextRunIso!)}
                    </span>
                    <span className="ml-2 text-[11px] tabular-nums text-on-surface-variant sm:ml-0 sm:mt-0.5 sm:block">
                      {fmtWhen(j.nextRunIso!)}
                    </span>
                  </div>
                  <span aria-hidden className="hidden h-9 w-px bg-border sm:block" />
                  <span
                    className={cn(
                      "flex h-9 w-9 items-center justify-center rounded-md",
                      spec.iconTone,
                    )}
                  >
                    {spec.icon}
                  </span>
                  <div className="min-w-0">
                    <div className="truncate text-[13.5px] font-bold text-on-surface">
                      {j.name}
                    </div>
                    <div className="mt-0.5 text-[11.5px] text-on-surface-variant">
                      {spec.staff} · {spec.costTag}
                    </div>
                  </div>
                </li>
              );
            })}
          </ol>
        </div>
      ) : null}

      {/* カテゴリ別グループ */}
      {jobs.length === 0 ? (
        <p className="py-12 text-center text-on-surface-variant">
          スケジュールされたジョブはありません
        </p>
      ) : (
        grouped.map((g) => (
          <div key={g.key}>
            <div className="flex items-center gap-3 px-1 pb-2.5">
              <span
                className={cn(
                  "flex h-[30px] w-[30px] items-center justify-center rounded-md",
                  g.tone,
                )}
              >
                {g.icon}
              </span>
              <div>
                <div className="text-sm font-bold text-on-surface">{g.name}</div>
                <div className="text-[11.5px] text-on-surface-variant">
                  {g.desc}
                </div>
              </div>
            </div>
            <ul className="grid gap-2">
              {g.rows.map((job) => (
                <ScheduleRow
                  key={job.id}
                  job={job}
                  onToggle={onToggle}
                  onRunNow={onRunNow}
                  onDelete={onDelete}
                />
              ))}
            </ul>
          </div>
        ))
      )}
    </section>
  );
}
