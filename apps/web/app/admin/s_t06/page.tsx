'use client';

import * as React from 'react';

import { QueryProvider } from '../../../providers/query-provider';
import { CurationQueue } from './_components/CurationQueue';
import { PlatformKnowledgeManager } from './_components/PlatformKnowledgeManager';

export default function ST06Page() {
  return (
    <div className="min-h-dvh bg-surface p-lg">
      <div className="mx-auto w-full max-w-[1200px]">
        <QueryProvider>
          <PlatformKnowledgeManager />
          {/* GAP-153: 運営 AI 裏走キュレーションの承認キュー */}
          <CurationQueue />
        </QueryProvider>
      </div>
    </div>
  );
}
