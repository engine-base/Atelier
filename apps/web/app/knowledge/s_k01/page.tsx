'use client';

import * as React from 'react';

import { KnowledgeExplorer, type KnowledgeItem } from './_components/KnowledgeExplorer';

const ITEMS: KnowledgeItem[] = [
  {
    id: 'k1',
    scope: 'common',
    category: '設計原則',
    title: 'タスクは縦割り',
    preview: 'タスクは縦割りで実装する...',
  },
  {
    id: 'k2',
    scope: 'common',
    category: '設計原則',
    title: 'R-T08 越境分離',
    preview: 'クライアント JWT は project_id 限定...',
  },
];

export default function SK01Page() {
  return (
    <div className="mx-auto w-full max-w-6xl px-md py-lg">
      <h1 className="mb-md text-headline-md font-bold text-on-surface">ナレッジエクスプローラ</h1>
      <KnowledgeExplorer items={ITEMS} />
    </div>
  );
}
