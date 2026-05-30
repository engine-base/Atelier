'use client';

import * as React from 'react';

import { SkillManager } from './_components/SkillManager';

export default function ST02Page() {
  return (
    <div className="bg-on-surface min-h-dvh p-lg">
      <h1 className="mb-md text-headline-md font-bold text-surface">スキル管理</h1>
      <SkillManager initial={[{ id: 's1', name: 'TypeScript', category: 'language', level: 5 }]} />
    </div>
  );
}
