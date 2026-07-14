'use client';

import * as React from 'react';

import { QueryProvider } from '../../../providers/query-provider';
import { SkillManager } from './_components/SkillManager';

export default function ST02Page() {
  return (
    <div className="bg-surface-fg min-h-dvh p-lg">
      <h1 className="mb-md text-headline-md font-bold text-surface">スキル管理</h1>
      <QueryProvider>
        <SkillManager />
      </QueryProvider>
    </div>
  );
}
