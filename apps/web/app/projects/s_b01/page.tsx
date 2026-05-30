/**
 * S-B01 プロジェクト一覧画面 — T-UC-03
 */

'use client';

import * as React from 'react';
import { useState } from 'react';

import { ProjectList, type ProjectRow } from './_components/ProjectList';

const SAMPLE_ROWS: ProjectRow[] = [
  {
    id: 'p1',
    name: 'Sample Project',
    client_name: 'ACME',
    lifecycle: 'active',
    created_at: '2026-05-01T00:00:00Z',
  },
];

export default function SB01Page() {
  const [rows] = useState<ProjectRow[]>(SAMPLE_ROWS);
  return (
    <div className="mx-auto flex w-full max-w-5xl flex-col gap-lg px-md py-lg">
      <header className="flex items-center justify-between">
        <h1 className="text-headline-md font-bold text-on-surface">プロジェクト一覧</h1>
      </header>
      <ProjectList
        rows={rows}
        prevCursor={null}
        nextCursor={null}
        onPrev={() => undefined}
        onNext={() => undefined}
      />
    </div>
  );
}
