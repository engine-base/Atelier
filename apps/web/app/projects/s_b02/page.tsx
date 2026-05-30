/**
 * S-B02 プロジェクトダッシュボード — T-UC-04
 */

'use client';

import * as React from 'react';

import { ProjectDashboard, type DashboardKpi } from './_components/ProjectDashboard';

const SAMPLE_KPIS: DashboardKpi[] = [
  { id: 'tasks', label: 'タスク (進行中)', value: 12, tone: 'info' },
  { id: 'awaiting', label: '承認待ち', value: 3, tone: 'success' },
  { id: 'blocked', label: 'ブロック', value: 1, tone: 'error' },
  { id: 'completed', label: '完了 (今週)', value: 24, tone: 'success' },
];

export default function SB02Page() {
  return (
    <div className="mx-auto w-full max-w-6xl px-md py-lg">
      <ProjectDashboard projectName="Sample Project" kpis={SAMPLE_KPIS} />
    </div>
  );
}
