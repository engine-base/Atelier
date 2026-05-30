'use client';

import * as React from 'react';

import { KanbanBoard, type TaskCard } from './_components/KanbanBoard';

const SAMPLE: TaskCard[] = [
  { id: 't1', title: '要件 hearing', stage: 'done', assignee: 'tony' },
  { id: 't2', title: 'API 設計', stage: 'in_progress', assignee: 'thor' },
  { id: 't3', title: 'UI 実装', stage: 'ready' },
  { id: 't4', title: 'デプロイ', stage: 'blocked' },
];

export default function SI01Page() {
  return (
    <div className="mx-auto flex w-full max-w-7xl flex-col gap-lg px-md py-lg">
      <h1 className="text-headline-md font-bold text-on-surface">タスクボード</h1>
      <KanbanBoard tasks={SAMPLE} onPlay={() => undefined} />
    </div>
  );
}
