'use client';

import * as React from 'react';

import { CronSchedule, type CronJob } from './_components/CronSchedule';

const JOBS: CronJob[] = [
  {
    id: 'j1',
    name: 'ナレッジ昇格レビュー集約',
    schedule: '0 9 * * *',
    enabled: true,
    nextRunAt: '明日 09:00',
  },
  {
    id: 'j2',
    name: 'メトリクス集計',
    schedule: '*/15 * * * *',
    enabled: false,
    nextRunAt: '—',
  },
];

export default function SO01Page() {
  return (
    <div className="mx-auto w-full max-w-5xl px-md py-lg">
      <h1 className="mb-md text-headline-md font-bold text-on-surface">自動スケジュール</h1>
      <CronSchedule jobs={JOBS} onToggle={() => undefined} onRunNow={() => undefined} />
    </div>
  );
}
