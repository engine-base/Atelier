'use client';

import * as React from 'react';

import { PhaseList, type PhaseRow } from './_components/PhaseList';

const ROWS: PhaseRow[] = [
  { id: 'p1', name: '要件定義', status: 'done', order: 1 },
  { id: 'p2', name: '設計', status: 'in_progress', order: 2 },
  { id: 'p3', name: '実装', status: 'pending', order: 3 },
];

export default function SF02Page() {
  return (
    <div className="mx-auto flex w-full max-w-5xl flex-col gap-lg px-md py-lg">
      <h1 className="text-headline-md font-bold text-on-surface">フェーズ管理</h1>
      <PhaseList initial={ROWS} />
    </div>
  );
}
