'use client';

import * as React from 'react';

import { QueryProvider } from '../../../providers/query-provider';
import { SkillManager } from './_components/SkillManager';

export default function ST02Page() {
  return (
    <div className="min-h-dvh bg-surface p-lg">
      <div className="mx-auto w-full max-w-[1200px]">
        <QueryProvider>
          <SkillManager />
        </QueryProvider>
      </div>
    </div>
  );
}
