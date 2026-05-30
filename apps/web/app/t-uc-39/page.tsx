/**
 * 横断: プロジェクト切替画面 — T-UC-39
 *
 * ProjectPicker を主役に、WS 内の project 一覧を切替可能にする。
 */

'use client';

import * as React from 'react';
import { useState } from 'react';

import { ProjectPicker, type ProjectOption } from '../../components/ProjectPicker';

const SAMPLE_OPTIONS: ProjectOption[] = [
  { id: 'p1', name: 'Sample Project Alpha' },
  { id: 'p2', name: 'Sample Project Beta' },
];

export default function UC39Page() {
  const [value, setValue] = useState<string | undefined>(SAMPLE_OPTIONS[0]?.id);
  return (
    <div className="mx-auto flex w-full max-w-xl flex-col gap-md px-md py-lg">
      <h1 className="text-headline-md font-bold text-on-surface">プロジェクト切替</h1>
      <p className="text-body-md text-on-surface-variant">
        ワークスペース内のプロジェクトを切り替えます。
      </p>
      <ProjectPicker value={value} options={SAMPLE_OPTIONS} onChange={setValue} />
      <p className="text-label-md text-on-surface-variant">
        現在: <strong>{SAMPLE_OPTIONS.find((o) => o.id === value)?.name ?? '—'}</strong>
      </p>
    </div>
  );
}
