/**
 * 横断: グローバル検索画面 — T-UC-40
 *
 * 全 entity (project / task / knowledge / employee / user) を横断検索。
 * 簡易実装: ローカル sample dataset で前方一致。
 */

'use client';

import * as React from 'react';
import { useState } from 'react';

import { cn } from '../../lib/cn';

type Kind = 'project' | 'task' | 'knowledge' | 'employee';

interface Hit {
  readonly id: string;
  readonly kind: Kind;
  readonly title: string;
  readonly snippet: string;
}

const KIND_LABEL: Record<Kind, string> = {
  project: 'プロジェクト',
  task: 'タスク',
  knowledge: 'ナレッジ',
  employee: 'AI 社員',
};

const SAMPLE: Hit[] = [
  { id: 'p1', kind: 'project', title: 'Atelier 改善', snippet: '...サンプル...' },
  { id: 't1', kind: 'task', title: 'API 設計レビュー', snippet: '...サンプル...' },
  {
    id: 'k1',
    kind: 'knowledge',
    title: 'タスク縦割りの原則',
    snippet: 'タスクは縦割り...',
  },
];

export default function UC40Page() {
  const [query, setQuery] = useState('');
  const [kind, setKind] = useState<'all' | Kind>('all');
  const filtered = SAMPLE.filter(
    (h) =>
      (kind === 'all' || h.kind === kind) &&
      (query === '' || h.title.includes(query) || h.snippet.includes(query)),
  );

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-md px-md py-lg">
      <h1 className="text-headline-md font-bold text-on-surface">検索</h1>
      <label className="flex flex-col gap-xs">
        <span className="sr-only">キーワード</span>
        <input
          type="search"
          autoFocus
          placeholder="キーワード"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          className="h-12 rounded-md border border-surface-variant bg-surface px-sm text-body-lg text-on-surface"
        />
      </label>
      <div role="group" aria-label="種別" className="flex gap-xs">
        {(['all', 'project', 'task', 'knowledge', 'employee'] as const).map((k) => (
          <button
            key={k}
            type="button"
            onClick={() => setKind(k)}
            aria-pressed={kind === k}
            className={cn(
              'inline-flex h-8 items-center rounded-sm px-sm text-label-md',
              kind === k
                ? 'bg-primary text-primary-fg'
                : 'bg-surface-variant text-on-surface',
            )}
          >
            {k === 'all' ? 'すべて' : KIND_LABEL[k]}
          </button>
        ))}
      </div>
      <ul role="list" className="flex flex-col gap-sm">
        {filtered.length === 0 ? (
          <li className="text-body-md text-on-surface-variant">ヒットなし</li>
        ) : (
          filtered.map((h) => (
            <li
              key={h.id}
              className="rounded-md border border-surface-variant bg-surface px-md py-sm"
            >
              <span className="text-label-sm text-on-surface-variant">{KIND_LABEL[h.kind]}</span>
              <p className="text-label-lg font-semibold text-on-surface">{h.title}</p>
              <p className="text-body-sm text-on-surface-variant">{h.snippet}</p>
            </li>
          ))
        )}
      </ul>
    </div>
  );
}
