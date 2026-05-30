'use client';

import * as React from 'react';

import { ApprovalsList, type ApprovalRow } from './_components/ApprovalsList';

const ROWS: ApprovalRow[] = [
  {
    id: 'a1',
    kind: 'task',
    title: 'API 設計を承認してください',
    requester: 'thor',
    created_at: '5 分前',
  },
  {
    id: 'a2',
    kind: 'output',
    title: 'PRD を確認してください',
    requester: 'tony',
    created_at: '1 時間前',
  },
];

export default function SJ01Page() {
  return (
    <div className="mx-auto flex w-full max-w-5xl flex-col gap-lg px-md py-lg">
      <h1 className="text-headline-md font-bold text-on-surface">承認待ち</h1>
      <ApprovalsList rows={ROWS} onApprove={() => undefined} onReject={() => undefined} />
    </div>
  );
}
