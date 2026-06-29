'use client';

import * as React from 'react';

import { QueryProvider } from '../../../providers/query-provider';
import { PlatformKnowledgeManager } from './_components/PlatformKnowledgeManager';

export default function ST06Page() {
  return (
    <div className="bg-on-surface min-h-dvh p-lg">
      <h1 className="mb-md text-headline-md font-bold text-surface">運営デフォルト・ナレッジ</h1>
      <QueryProvider>
        <PlatformKnowledgeManager />
      </QueryProvider>
    </div>
  );
}
