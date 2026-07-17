/**
 * S-O01 自動スケジュール — T-UC-25
 *
 * cron job の一覧 + cron 式 + 次回実行時刻 + enable/disable トグル + 即時実行ボタン。
 * 見た目は 06_mockups/cron/S-O01-schedule.html の .group / .schedule-row に忠実。
 * データ配線・props・export・aria-label は不変（vitest / e2e が参照）。
 */

"use client";

import * as React from "react";
import { useState } from "react";
import { Clock, PlayCircle, Trash2 } from "lucide-react";

export interface CronJob {
  readonly id: string;
  readonly name: string;
  readonly schedule: string;
  readonly enabled: boolean;
  readonly nextRunAt: string;
}

export interface CronScheduleProps {
  readonly jobs: readonly CronJob[];
  readonly onToggle: (id: string, enabled: boolean) => void;
  /** 即時実行。未指定なら「即時実行」ボタンを出さない（バックエンド未対応時など）。 */
  readonly onRunNow?: (id: string) => void;
  /** 削除。未指定なら削除ボタンを出さない。 */
  readonly onDelete?: (id: string) => void;
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
      <span
        aria-hidden
        className="h-1.5 w-1.5 rounded-full bg-current"
      />
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
  return (
    <li
      className={`grid grid-cols-[44px_1fr_auto] items-center gap-4 rounded-lg border border-border bg-white p-4 transition-colors hover:border-primary hover:shadow-sm sm:grid-cols-[44px_1fr_180px_auto_auto] ${
        job.enabled ? "" : "opacity-60"
      }`}
    >
      {/* アイコン */}
      <span className="flex h-11 w-11 items-center justify-center rounded-md bg-primary-container text-on-primary-container">
        <Clock size={18} />
      </span>

      {/* 名前 + 状態 pill */}
      <div className="min-w-0">
        <div className="truncate text-sm font-bold text-on-surface">
          {job.name}
        </div>
        <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
          <StatusPill enabled={job.enabled} />
        </div>
      </div>

      {/* cron 式 + 次回実行 */}
      <div className="col-span-3 text-left sm:col-span-1 sm:text-right">
        <code className="font-mono text-[11px] tabular-nums text-on-surface-variant">
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
}: CronScheduleProps) {
  return (
    <section aria-label="自動スケジュール">
      {/* グループ見出し */}
      <div className="flex items-center gap-3 px-1 pb-2.5">
        <span className="flex h-[30px] w-[30px] items-center justify-center rounded-md bg-primary-container text-on-primary-container">
          <Clock size={16} />
        </span>
        <div>
          <div className="text-sm font-bold text-on-surface">
            登録済みスケジュール
          </div>
          <div className="text-[11.5px] text-on-surface-variant">
            有効なものが次回実行予定に入ります
          </div>
        </div>
      </div>

      {jobs.length === 0 ? (
        <p className="py-12 text-center text-on-surface-variant">
          スケジュールされたジョブはありません
        </p>
      ) : (
        <ul className="grid gap-2">
          {jobs.map((job) => (
            <ScheduleRow
              key={job.id}
              job={job}
              onToggle={onToggle}
              onRunNow={onRunNow}
              onDelete={onDelete}
            />
          ))}
        </ul>
      )}
    </section>
  );
}
