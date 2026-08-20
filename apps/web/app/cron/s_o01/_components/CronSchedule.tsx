/**
 * S-O01 自動スケジュール — T-UC-25 / モック忠実再構築 v2
 *
 * 06_mockups/cron/S-O01-schedule.html に準拠:
 *   - 次に動くスケジュール (next_run_at 昇順の時系列カード + 更新ボタン)
 *   - カテゴリ別グループ (実装の夜間自動進行 / ナレッジ整理 / 通知・レポート配信)
 *   - 各行: アイコン + 名前 + 説明 + コスト/担当タグ + cron 日本語ラベル + cron 式 +
 *     次回 + トグル + 削除 (2 段階)
 *
 * 実行履歴 (GAP-013 解消): GET /cron-runs の実データを「実行履歴」テーブルで描画
 * (スケジュール名/実行日時/所要時間/結果 — モック .history-card 準拠)。
 * 法令・運用バックエンド (GAP-014 解消): GET /cron-platform-jobs の read-only
 * 実データで描画 (退会データ 30 日後完全削除 / データ整合性チェック — 無効化不可)。
 * 最終実行は cron_run_history 実データ。稼働状況を偽装しない (未実行なら未実行と出す)。
 * GAP-179: 説明・コスト表示・担当は **API (GET /cron-actions) から取る**。
 * 以前はこのファイルに「BYOK API 使用」等を直書きしていたため、実際には
 * 一度も実行されていない自動実行に対して費用の嘘が表示されていた。
 * 実行コード (apps/api/src/services/cron/actions.py) を唯一の信頼源にする。
 *
 * データ配線・props・export・aria-label は不変（vitest / e2e が参照）。
 */

"use client";

import * as React from "react";
import { useState } from "react";
import {
  Brain,
  CalendarClock,
  Check,
  ClipboardList,
  Clock,
  Database,
  Lock,
  Mail,
  PlayCircle,
  RefreshCw,
  ShieldCheck,
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

export interface CronRun {
  readonly id: string;
  readonly name: string;
  readonly startedAt: string;
  readonly finishedAt?: string | null;
  /** GAP-179: deferred = 今は実行できないので自動再試行する (嘘の成功/失敗にしない)。 */
  readonly status: "running" | "success" | "error" | "deferred";
  /** どのスケジュールの実行か (行内に前回結果を出すため)。 */
  readonly scheduleId?: string | null;
  /**
   * GAP-193: この実行の前に飛ばした定刻の回数 (0 = 取りこぼしなし)。
   * PC を止めていた間の分は実行されない。**黙って消さない**ために出す。
   */
  readonly skippedOccurrences?: number;
}

/**
 * 自動実行の種類ごとのメタ情報 (GET /cron-actions)。
 * 説明・コスト・担当・PC 接続要否はすべてこの API 由来。
 */
export interface CronActionInfo {
  readonly action: string;
  readonly title: string;
  readonly description: string;
  readonly group: "impl" | "knowledge" | "notify";
  readonly staff: string;
  readonly requiresBridge: boolean;
  readonly costLabel: string;
  readonly costNote: string;
}

/** プラットフォーム必須ジョブ (GAP-014 — GET /cron-platform-jobs、read-only)。 */
export interface PlatformJob {
  readonly name: string;
  readonly category: "legal" | "report" | "pipeline";
  readonly required: boolean;
  readonly title: string;
  readonly description: string;
  readonly cron: string;
  readonly scheduleLabel: string;
  readonly nextRunAt?: string | null;
  readonly lastRun?: {
    readonly startedAt: string;
    readonly status: "running" | "success" | "error" | "deferred";
  } | null;
}

export interface CronScheduleProps {
  readonly jobs: readonly CronJob[];
  /** 実行履歴 (GAP-013)。未指定なら履歴セクションを出さない (Rule 10)。 */
  readonly runs?: readonly CronRun[];
  /** 法令・運用バックエンド (GAP-014)。未指定なら節を出さない (Rule 10)。 */
  readonly platformJobs?: readonly PlatformJob[];
  /** 種類ごとのメタ情報 (GET /cron-actions)。未取得なら説明・コストを出さない (Rule 10)。 */
  readonly actions?: readonly CronActionInfo[];
  readonly onToggle: (id: string, enabled: boolean) => void;
  /** 即時実行。未指定なら「即時実行」ボタンを出さない（バックエンド未対応時など）。 */
  readonly onRunNow?: (id: string) => void;
  /** 削除。未指定なら削除ボタンを出さない。 */
  readonly onDelete?: (id: string) => void;
  /** 「次に動くスケジュール」の更新ボタン (一覧再取得)。 */
  readonly onRefresh?: () => void;
}

/**
 * target_action ごとの **見た目だけ** の仕様 (アイコン・配色・グループ)。
 * 文言 (説明 / コスト / 担当) は API から取るのでここには置かない — 置くと
 * 「画面の説明」と「実際に走る処理」がまた食い違う (GAP-179 の原因)。
 */
interface ActionSpec {
  readonly group: "impl" | "knowledge" | "notify";
  readonly icon: React.ReactNode;
  readonly iconTone: string;
}

const ACTION_SPEC: Record<string, ActionSpec> = {
  task_replay: {
    group: "impl",
    icon: <PlayCircle size={18} />,
    iconTone: "bg-primary-container text-primary-container-fg",
  },
  knowledge_organize: {
    group: "knowledge",
    icon: <Brain size={18} />,
    iconTone: "bg-tertiary-container text-tertiary-container-fg",
  },
  industry_extract: {
    group: "knowledge",
    icon: <Sparkles size={18} />,
    iconTone: "bg-tertiary-container text-tertiary-container-fg",
  },
  report_summary: {
    group: "notify",
    icon: <Mail size={18} />,
    iconTone: "bg-secondary-container text-secondary-container-fg",
  },
  daily_digest: {
    group: "notify",
    icon: <ClipboardList size={18} />,
    iconTone: "bg-secondary-container text-secondary-container-fg",
  },
  weekly_burndown: {
    group: "notify",
    icon: <CalendarClock size={18} />,
    iconTone: "bg-surface-variant text-on-surface-variant",
  },
};

const FALLBACK_SPEC: ActionSpec = {
  group: "impl",
  icon: <Clock size={18} />,
  iconTone: "bg-primary-container text-primary-container-fg",
};

/** コスト表示の配色。文言は API の cost_label をそのまま出す (言い換えない)。 */
function costTone(label: string): string {
  return label.includes("無料")
    ? "bg-tertiary-container text-tertiary-container-fg"
    : "bg-primary-container text-primary-container-fg";
}

/** 実行結果の日本語ラベル (deferred を「失敗」と書かない)。 */
export function runStatusLabel(status: CronRun["status"]): string {
  if (status === "success") return "成功";
  if (status === "error") return "失敗";
  if (status === "deferred") return "保留";
  return "実行中";
}

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
    desc: "あなたが寝てる間に着手可タスクを自動消化（あなたの Claude プラン枠）",
    icon: <PlayCircle size={16} />,
    tone: "bg-primary-container text-primary-container-fg",
  },
  {
    key: "knowledge",
    name: "ナレッジ整理（ティチャラ）",
    desc: "蓄積されたナレッジの整理・統合・横断パターン抽出",
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
  const [, min, hour, dom, dow] = m as unknown as [
    string,
    string,
    string,
    string,
    string,
  ];
  const mm = min.padStart(2, "0");
  if (hour === "*" && dom === "*" && dow === "*")
    return `毎時 ${Number(min)} 分`;
  if (!/^\d{1,2}$/.test(hour)) return expr;
  const h = Number(hour);
  const time = `${h}:${mm}`;
  const period = h < 5 ? "深夜" : h < 11 ? "朝" : h < 18 ? "昼" : "夜";
  if (dom === "*" && dow === "*") return `毎日 ${period} ${time}`;
  if (dom === "*" && /^\d$/.test(dow))
    return `毎週 ${DOW[Number(dow)] ?? dow}曜 ${time}`;
  if (/^\d{1,2}$/.test(dom) && dow === "*")
    return `毎月 ${Number(dom)} 日 ${period} ${time}`;
  return expr;
}

/** next_run_at までの相対表示 (あと X 時間 Y 分 / あと X 日 Y 時間)。 */
function relUntil(iso: string): string {
  const diff = new Date(iso).getTime() - Date.now();
  if (diff <= 0) return "まもなく";
  const min = Math.floor(diff / 60000);
  if (min < 60) return `あと ${min} 分`;
  const hours = Math.floor(min / 60);
  if (hours < 24)
    return `あと ${hours} 時間 ${String(min % 60).padStart(2, "0")} 分`;
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
  info,
  lastRun,
  onToggle,
  onRunNow,
  onDelete,
}: {
  readonly job: CronJob;
  readonly info?: CronActionInfo;
  readonly lastRun?: CronRun;
  readonly onToggle: (id: string, enabled: boolean) => void;
  readonly onRunNow?: (id: string) => void;
  readonly onDelete?: (id: string) => void;
}) {
  const [confirming, setConfirming] = useState(false);
  const spec = ACTION_SPEC[job.targetAction ?? ""] ?? FALLBACK_SPEC;
  return (
    <li
      className={`grid grid-cols-[44px_1fr_auto] items-center gap-4 rounded-lg border border-border p-4 transition-colors hover:border-primary hover:shadow-sm sm:grid-cols-[44px_1fr_180px_auto_auto] ${
        // a11y: 停止中を opacity で dim すると文字コントラストが 4.5:1 を割る
        // (axe serious)。面色 (surface-variant) で無効状態を表現する。
        job.enabled ? "bg-white" : "bg-surface-variant/50"
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
        {info ? (
          <p className="mt-0.5 text-[12px] leading-[1.55] text-on-surface-variant">
            {info.description}
          </p>
        ) : null}
        <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
          <StatusPill enabled={job.enabled} />
          {info ? (
            <>
              <span
                title={info.costNote}
                className={cn(
                  "inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10.5px] font-semibold",
                  costTone(info.costLabel),
                )}
              >
                {info.costLabel}
              </span>
              {info.requiresBridge ? (
                <span
                  title="あなたの PC の Claude Code で実行します。未接続の間は保留され、接続後に自動で再試行します。"
                  className="inline-flex items-center gap-1 rounded-full bg-secondary-container px-2 py-0.5 text-[10.5px] font-semibold text-secondary-container-fg"
                >
                  PC 接続が必要
                </span>
              ) : null}
              <span className="inline-flex items-center gap-1 rounded-full bg-surface-variant px-2 py-0.5 text-[10.5px] font-semibold text-on-surface-variant">
                {info.staff}
              </span>
            </>
          ) : null}
          {lastRun ? (
            <span
              className={cn(
                "inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10.5px] font-semibold",
                lastRun.status === "success" &&
                  "bg-tertiary-container text-tertiary-container-fg",
                lastRun.status === "error" && "bg-[#FEE2E2] text-[#991B1B]",
                lastRun.status === "deferred" &&
                  "bg-secondary-container text-secondary-container-fg",
                lastRun.status === "running" &&
                  "bg-surface-variant text-on-surface-variant",
              )}
            >
              前回 {runStatusLabel(lastRun.status)}
            </span>
          ) : null}
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
          {job.enabled ? `次回 ${job.nextRunAt}` : "停止中のため次回なし"}
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

/** 法令・運用バックエンドの 1 行 (モック .schedule-row 準拠、read-only)。 */
function PlatformJobRow({ job }: { readonly job: PlatformJob }) {
  const lastLabel =
    job.lastRun == null ? "未実行" : runStatusLabel(job.lastRun.status);
  const lastStarted = job.lastRun ? new Date(job.lastRun.startedAt) : null;
  return (
    <li className="grid grid-cols-[44px_1fr] items-start gap-3 rounded-lg border border-border bg-white p-4 sm:grid-cols-[44px_1fr_auto]">
      <span
        className={cn(
          "flex h-11 w-11 items-center justify-center rounded-md",
          job.name === "purge-deleted-accounts"
            ? "bg-[#FEE2E2] text-[#991B1B]"
            : "bg-tertiary-container text-tertiary-container-fg",
        )}
      >
        {job.name === "purge-deleted-accounts" ? (
          <Trash2 size={18} />
        ) : (
          <ShieldCheck size={18} />
        )}
      </span>
      <div className="min-w-0">
        <div className="text-[13.5px] font-bold text-on-surface">
          {job.title}
        </div>
        <div className="mt-0.5 text-[11.5px] leading-relaxed text-on-surface-variant">
          {job.description}
        </div>
        <div className="mt-1.5 flex flex-wrap gap-1.5">
          {job.required ? (
            <span className="inline-flex items-center gap-1 rounded-full bg-[#FEE2E2] px-2 py-0.5 text-[10.5px] font-bold text-[#991B1B]">
              <Lock size={10} aria-hidden="true" />
              無効化不可
            </span>
          ) : null}
          <span className="inline-flex items-center gap-1 rounded-full bg-tertiary-container px-2 py-0.5 text-[10.5px] font-bold text-tertiary-container-fg">
            <Check size={10} aria-hidden="true" />
            コスト無料
          </span>
          <span className="inline-flex items-center gap-1 rounded-full bg-surface-variant px-2 py-0.5 text-[10.5px] font-bold text-on-surface-variant">
            <Database size={10} aria-hidden="true" />
            SQL のみ
          </span>
        </div>
      </div>
      <div className="col-span-2 text-left sm:col-span-1 sm:text-right">
        <div className="text-[12.5px] font-bold text-on-surface">
          {job.scheduleLabel}
        </div>
        <div
          className="font-mono text-[10.5px] text-on-surface-variant"
          title="cron 式 (UTC)"
        >
          {job.cron}
        </div>
        {job.nextRunAt ? (
          <div className="mt-0.5 text-[11px] tabular-nums text-on-surface-variant">
            次回 {fmtWhen(job.nextRunAt)}
          </div>
        ) : null}
        <div className="mt-0.5 text-[11px] text-on-surface-variant">
          最終実行{" "}
          <span
            className={cn(
              "font-bold",
              job.lastRun?.status === "success" && "text-tertiary",
              job.lastRun?.status === "error" && "text-error",
            )}
          >
            {lastLabel}
          </span>
          {lastStarted
            ? ` (${lastStarted.getMonth() + 1}/${lastStarted.getDate()} ${String(lastStarted.getHours()).padStart(2, "0")}:${String(lastStarted.getMinutes()).padStart(2, "0")})`
            : null}
        </div>
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
  runs,
  platformJobs,
  actions,
}: CronScheduleProps) {
  const infoByAction = new Map((actions ?? []).map((a) => [a.action, a]));
  // 行内に「前回どうなったか」を出すための索引 (runs は新しい順)。
  const lastRunBySchedule = new Map<string, CronRun>();
  for (const r of runs ?? []) {
    if (r.scheduleId && !lastRunBySchedule.has(r.scheduleId)) {
      lastRunBySchedule.set(r.scheduleId, r);
    }
  }
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
      (j) =>
        (ACTION_SPEC[j.targetAction ?? ""] ?? FALLBACK_SPEC).group === g.key,
    ),
  })).filter((g) => g.rows.length > 0);

  return (
    <section aria-label="自動スケジュール" className="flex flex-col gap-5">
      {/* GAP-183: 誰が発火の見張りをしているかを隠さない。 主は利用者の PC、クラウドは 15 分ごとの滑り止め。 */}
      <p className="rounded-lg border border-border bg-surface-variant px-4 py-3 text-[12px] leading-[1.7] text-on-surface-variant">
        自動実行の時刻は、
        <strong className="font-bold text-on-surface">
          お使いのパソコン（Bridge）が起動している間
        </strong>
        に見張っています。 パソコンがスリープ・停止していた間に過ぎた分は、
        <strong className="font-bold text-on-surface">
          次に起動したときにまとめて実行
        </strong>
        されます。
        パソコンが長期間落ちていても集計だけは止まらないよう、サーバー側でも 15
        分ごとに確認しています。
      </p>

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
              const info = infoByAction.get(j.targetAction ?? "");
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
                  <span
                    aria-hidden
                    className="hidden h-9 w-px bg-border sm:block"
                  />
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
                    {info ? (
                      <div className="mt-0.5 text-[11.5px] text-on-surface-variant">
                        {info.staff} · {info.costLabel}
                      </div>
                    ) : null}
                  </div>
                </li>
              );
            })}
          </ol>
        </div>
      ) : null}

      {/* 法令・運用バックエンド (GAP-014 — モック group 3a 準拠、read-only 実データ)。
          legal ジョブはコード定義で常時 ≥1 のため、空 = API 未到達。その場合は
          節ごと出さない (偽の稼働状況を出さない)。 */}
      {platformJobs !== undefined &&
      platformJobs.some((j) => j.category === "legal") ? (
        <section aria-label="法令・運用バックエンド">
          <div className="flex items-center gap-3 px-1 pb-2.5">
            <span className="flex h-[30px] w-[30px] items-center justify-center rounded-md bg-[#FEE2E2] text-[#991B1B]">
              <ShieldCheck size={16} />
            </span>
            <div>
              <div className="flex items-center gap-2 text-sm font-bold text-on-surface">
                法令・運用バックエンド
                <span className="rounded-full bg-[#FEE2E2] px-2 py-0.5 text-[10px] font-bold text-[#991B1B]">
                  必須
                </span>
              </div>
              <div className="text-[11.5px] text-on-surface-variant">
                法令対応とデータ整合性。Atelier 内部処理のみ・コスト無料
              </div>
            </div>
          </div>
          <ul className="grid gap-2">
            {platformJobs
              .filter((j) => j.category === "legal")
              .map((j) => (
                <PlatformJobRow key={j.name} job={j} />
              ))}
          </ul>
        </section>
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
                <div className="text-sm font-bold text-on-surface">
                  {g.name}
                </div>
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
                  info={infoByAction.get(job.targetAction ?? "")}
                  lastRun={lastRunBySchedule.get(job.id)}
                  onToggle={onToggle}
                  onRunNow={onRunNow}
                  onDelete={onDelete}
                />
              ))}
            </ul>
          </div>
        ))
      )}

      {/* 実行履歴 (GAP-013 — モック .history-card 準拠) */}
      {runs ? (
        <div className="rounded-lg border border-border bg-white">
          <div className="border-b border-border px-4 py-3">
            <h2 className="text-[13.5px] font-bold text-on-surface">
              実行履歴（直近 {runs.length} 件）
            </h2>
          </div>
          {runs.length === 0 ? (
            <p className="px-4 py-8 text-center text-[12.5px] text-on-surface-variant">
              実行履歴はまだありません。cron が発火すると自動で記録されます。
            </p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-[12.5px]">
                <caption className="sr-only">cron 実行履歴</caption>
                <thead>
                  <tr className="border-b border-border bg-surface-variant text-left text-[10.5px] uppercase tracking-[0.06em] text-on-surface-variant">
                    <th className="px-4 py-2 font-bold">スケジュール名</th>
                    <th className="px-4 py-2 font-bold">実行日時</th>
                    <th className="px-4 py-2 font-bold">所要時間</th>
                    <th className="px-4 py-2 font-bold">結果</th>
                  </tr>
                </thead>
                <tbody>
                  {runs.map((r) => {
                    const started = new Date(r.startedAt);
                    const dur =
                      r.finishedAt != null
                        ? `${Math.max(0, Math.round((new Date(r.finishedAt).getTime() - started.getTime()) / 1000))} 秒`
                        : "—";
                    const label = runStatusLabel(r.status);
                    return (
                      <tr
                        key={r.id}
                        className="border-b border-border last:border-b-0"
                      >
                        <td className="px-4 py-2 font-medium text-on-surface">
                          {r.name}
                        </td>
                        <td className="px-4 py-2 tabular-nums text-on-surface-variant">
                          {`${started.getMonth() + 1}/${started.getDate()} ${String(started.getHours()).padStart(2, "0")}:${String(started.getMinutes()).padStart(2, "0")}`}
                        </td>
                        <td className="px-4 py-2 tabular-nums text-on-surface-variant">
                          {dur}
                        </td>
                        <td className="px-4 py-2">
                          <span
                            className={cn(
                              "inline-flex items-center rounded-full px-2 py-0.5 text-[10.5px] font-bold",
                              r.status === "success" &&
                                "bg-tertiary-container text-tertiary-container-fg",
                              r.status === "error" &&
                                "bg-[#FEE2E2] text-[#991B1B]",
                              r.status === "deferred" &&
                                "bg-secondary-container text-secondary-container-fg",
                              r.status === "running" &&
                                "bg-surface-variant text-on-surface-variant",
                            )}
                          >
                            {label}
                          </span>
                          {/* GAP-193: PC を止めていた間に過ぎた定刻は実行されない。
                              何回分飛んだかを必ず出す (黙って消さない)。 */}
                          {r.skippedOccurrences ? (
                            <span
                              className="ml-1.5 inline-flex items-center rounded-full bg-surface-variant px-2 py-0.5 text-[10.5px] font-semibold text-on-surface-variant"
                              title="パソコンが止まっていた等で、この実行までに過ぎた定刻です。その分は実行されていません（遡っての作成は行いません）。"
                            >
                              {r.skippedOccurrences} 回分を未実行
                            </span>
                          ) : null}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>
      ) : null}
    </section>
  );
}
