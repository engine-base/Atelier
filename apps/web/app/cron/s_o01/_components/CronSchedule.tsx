/**
 * S-O01 自動スケジュール — T-UC-25
 *
 * cron job の一覧 + 次回実行時刻 + enable/disable トグル + 即時実行ボタン。
 */

"use client";

import * as React from "react";

import {
  DataTable,
  type ColumnDef,
} from "../../../../components/data-table/DataTable";

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
  /** 即時実行。未指定なら「即時実行」列を出さない（バックエンド未対応時など）。 */
  readonly onRunNow?: (id: string) => void;
}

export function CronSchedule({ jobs, onToggle, onRunNow }: CronScheduleProps) {
  const cols: ColumnDef<CronJob>[] = [
    { id: "name", header: "ジョブ名", cell: (r) => r.name },
    { id: "schedule", header: "スケジュール", cell: (r) => r.schedule },
    { id: "next", header: "次回実行", cell: (r) => r.nextRunAt },
    {
      id: "enabled",
      header: "有効",
      cell: (r) => (
        <label className="inline-flex items-center gap-xs">
          <input
            type="checkbox"
            checked={r.enabled}
            onChange={(e) => onToggle(r.id, e.target.checked)}
            aria-label={`${r.name} を ${r.enabled ? "無効" : "有効"} 化`}
          />
        </label>
      ),
    },
    ...(onRunNow
      ? [
          {
            id: "run",
            header: "即時実行",
            cell: (r: CronJob) => (
              <button
                type="button"
                onClick={() => onRunNow(r.id)}
                aria-label={`${r.name} を今すぐ実行`}
                className="inline-flex h-8 items-center rounded-sm bg-primary px-sm text-label-sm text-primary-fg"
              >
                ▶
              </button>
            ),
            align: "right" as const,
          },
        ]
      : []),
  ];

  return (
    <DataTable
      caption="自動スケジュール"
      columns={cols}
      rows={jobs}
      rowKey={(r) => r.id}
      emptyMessage="スケジュールされたジョブはありません"
    />
  );
}
