/**
 * S-K01 ナレッジエクスプローラ — T-UC-18
 *
 * scope (workspace common / employee_specific) × category ツリー + 検索 + 詳細プレビュー。
 * 簡易実装: scope tab + category list + 選択時 detail。
 */

'use client';

import * as React from 'react';
import { useState } from 'react';

import { cn } from '../../../../lib/cn';

export type KnowledgeScope = 'common' | 'employee_specific';

export interface KnowledgeItem {
  readonly id: string;
  readonly scope: KnowledgeScope;
  readonly category: string;
  readonly title: string;
  readonly preview: string;
}

export interface KnowledgeExplorerProps {
  readonly items: readonly KnowledgeItem[];
}

export function KnowledgeExplorer({ items }: KnowledgeExplorerProps) {
  const [scope, setScope] = useState<KnowledgeScope>('common');
  const [query, setQuery] = useState('');
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const filtered = items.filter(
    (i) =>
      i.scope === scope &&
      (query === '' || i.title.includes(query) || i.preview.includes(query)),
  );
  const selected = items.find((i) => i.id === selectedId) ?? null;

  return (
    <section aria-label="ナレッジエクスプローラ" className="grid grid-cols-1 gap-md md:grid-cols-[1fr_2fr]">
      <aside className="flex flex-col gap-md">
        <div role="tablist" aria-label="スコープ" className="flex border-b border-surface-variant">
          {(['common', 'employee_specific'] as const).map((s) => (
            <button
              key={s}
              role="tab"
              aria-selected={scope === s}
              onClick={() => setScope(s)}
              className={cn(
                'flex-1 py-xs text-label-md',
                scope === s
                  ? 'border-b-2 border-primary font-semibold text-primary'
                  : 'text-on-surface-variant',
              )}
            >
              {s === 'common' ? '共通' : '社員専用'}
            </button>
          ))}
        </div>
        <label className="flex flex-col gap-xs">
          <span className="sr-only">検索</span>
          <input
            type="search"
            placeholder="検索"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            className="h-9 rounded-md border border-surface-variant bg-surface px-sm text-body-md text-on-surface"
          />
        </label>
        <ul role="list" className="flex flex-col gap-xs">
          {filtered.length === 0 ? (
            <li className="text-label-md text-on-surface-variant">該当なし</li>
          ) : (
            filtered.map((i) => (
              <li key={i.id}>
                <button
                  type="button"
                  onClick={() => setSelectedId(i.id)}
                  className={cn(
                    'w-full rounded-md px-sm py-xs text-left text-body-sm',
                    selectedId === i.id
                      ? 'bg-primary-container text-primary-container-fg font-semibold'
                      : 'hover:bg-surface-variant',
                  )}
                >
                  <span className="block text-label-sm text-on-surface-variant">{i.category}</span>
                  <span>{i.title}</span>
                </button>
              </li>
            ))
          )}
        </ul>
      </aside>
      <article aria-label="詳細プレビュー" className="rounded-md bg-surface-variant/20 p-md">
        {selected ? (
          <>
            <h2 className="text-label-lg font-semibold text-on-surface">{selected.title}</h2>
            <p className="mt-sm whitespace-pre-wrap text-body-md text-on-surface">
              {selected.preview}
            </p>
          </>
        ) : (
          <p className="text-body-md text-on-surface-variant">左の一覧から選択してください</p>
        )}
      </article>
    </section>
  );
}
