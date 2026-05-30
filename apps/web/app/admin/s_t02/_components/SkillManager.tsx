/**
 * S-T02 スキル管理 — T-UC-31
 *
 * AI 社員のスキル定義 (key/value/level) を CRUD。
 */

'use client';

import * as React from 'react';
import { useState } from 'react';

import { DataTable, type ColumnDef } from '../../../../components/data-table/DataTable';

export interface Skill {
  readonly id: string;
  readonly name: string;
  readonly category: string;
  readonly level: number;
}

export interface SkillManagerProps {
  readonly initial: readonly Skill[];
}

export function SkillManager({ initial }: SkillManagerProps) {
  const [rows, setRows] = useState<Skill[]>([...initial]);
  const [name, setName] = useState('');
  const [category, setCategory] = useState('');
  const [level, setLevel] = useState(3);

  const add = () => {
    if (!name) return;
    setRows((r) => [...r, { id: `s-${Date.now()}`, name, category, level }]);
    setName('');
    setCategory('');
    setLevel(3);
  };

  const remove = (id: string) => setRows((r) => r.filter((x) => x.id !== id));

  const cols: ColumnDef<Skill>[] = [
    { id: 'name', header: '名前', cell: (r) => r.name },
    { id: 'category', header: 'カテゴリ', cell: (r) => r.category },
    { id: 'level', header: 'レベル', cell: (r) => String(r.level), align: 'right' },
    {
      id: 'rm',
      header: '削除',
      cell: (r) => (
        <button
          type="button"
          onClick={() => remove(r.id)}
          aria-label={`${r.name} を削除`}
          className="inline-flex h-8 items-center rounded-sm border border-error px-sm text-label-md text-error"
        >
          ×
        </button>
      ),
      align: 'right',
    },
  ];

  return (
    <section className="flex flex-col gap-md">
      <DataTable
        caption="スキル一覧"
        columns={cols}
        rows={rows}
        rowKey={(r) => r.id}
        emptyMessage="スキルがありません"
      />
      <form
        onSubmit={(e) => {
          e.preventDefault();
          add();
        }}
        className="flex gap-sm rounded-md border border-surface-variant/30 p-md"
      >
        <label className="flex flex-1 flex-col gap-xs">
          <span className="text-label-md text-surface-variant">名前</span>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            className="h-9 rounded-md border border-surface-variant/40 bg-surface/10 px-sm text-body-md text-surface"
          />
        </label>
        <label className="flex flex-1 flex-col gap-xs">
          <span className="text-label-md text-surface-variant">カテゴリ</span>
          <input
            value={category}
            onChange={(e) => setCategory(e.target.value)}
            className="h-9 rounded-md border border-surface-variant/40 bg-surface/10 px-sm text-body-md text-surface"
          />
        </label>
        <label className="flex w-24 flex-col gap-xs">
          <span className="text-label-md text-surface-variant">レベル</span>
          <input
            type="number"
            min={1}
            max={5}
            value={level}
            onChange={(e) => setLevel(Number(e.target.value))}
            className="h-9 rounded-md border border-surface-variant/40 bg-surface/10 px-sm text-body-md text-surface"
          />
        </label>
        <button
          type="submit"
          disabled={!name}
          className="self-end inline-flex h-9 items-center rounded-md bg-primary px-md text-label-md text-primary-fg disabled:opacity-50"
        >
          追加
        </button>
      </form>
    </section>
  );
}
