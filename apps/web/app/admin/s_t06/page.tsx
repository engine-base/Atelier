'use client';

import * as React from 'react';

import { QueryProvider } from '../../../providers/query-provider';
import { PlatformKnowledgeManager } from './_components/PlatformKnowledgeManager';

export default function ST06Page() {
  return (
    <div className="min-h-dvh bg-surface p-lg">
      <div className="mx-auto w-full max-w-[1200px]">
        <QueryProvider>
          <PlatformKnowledgeManager />
        </QueryProvider>
      </div>
    </div>
  );
}
