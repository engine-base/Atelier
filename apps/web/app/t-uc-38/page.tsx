/**
 * 横断: ワークスペース切替画面 — T-UC-38
 *
 * 所属 WS 一覧表示 + 選択で切替 (実 API は workspaces API、本 PR は UI 配線のみ)。
 */

'use client';

import * as React from 'react';
import { useState } from 'react';

import { WorkspacePicker, type WorkspaceOption } from '../../components/WorkspacePicker';
import { t } from '../../lib/i18n';

const SAMPLE_OPTIONS: WorkspaceOption[] = [
  { id: 'w-self', name: '個人' },
  { id: 'w-org-1', name: '株式会社サンプル' },
];

export default function UC38Page() {
  const [value, setValue] = useState<string | undefined>(SAMPLE_OPTIONS[0]?.id);
  return (
    <div className="mx-auto flex w-full max-w-xl flex-col gap-md px-md py-lg">
      <h1 className="text-headline-md font-bold text-on-surface">ワークスペース切替</h1>
      <p className="text-body-md text-on-surface-variant">
        所属する {t('nav.projects')} を切り替えます。
      </p>
      <WorkspacePicker value={value} options={SAMPLE_OPTIONS} onChange={setValue} />
      <p className="text-label-md text-on-surface-variant">
        現在: <strong>{SAMPLE_OPTIONS.find((o) => o.id === value)?.name ?? '—'}</strong>
      </p>
    </div>
  );
}
