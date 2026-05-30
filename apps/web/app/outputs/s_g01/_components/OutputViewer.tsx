/**
 * S-G01 成果物ビューア (コメントピン) — T-UC-12
 *
 * 成果物 (markdown / 画像) を表示し、任意の位置にコメントピンを刺せる。
 * 簡易実装: コメントは項目 list として表示、ピン座標 (x, y%) を持つ。
 */

'use client';

import * as React from 'react';
import { useState } from 'react';

import { cn } from '../../../../lib/cn';

export interface CommentPin {
  readonly id: string;
  readonly x: number;
  readonly y: number;
  readonly text: string;
  readonly author: string;
}

export interface OutputViewerProps {
  readonly title: string;
  readonly contentHtml: string;
  readonly pins: readonly CommentPin[];
  readonly onAddPin?: (x: number, y: number) => void;
  readonly className?: string;
}

export function OutputViewer({
  title,
  contentHtml,
  pins,
  onAddPin,
  className,
}: OutputViewerProps) {
  const [active, setActive] = useState<string | null>(null);

  return (
    <article className={cn('flex flex-col gap-md', className)}>
      <h1 className="text-headline-md font-bold text-on-surface">{title}</h1>
      <div
        className="relative rounded-md bg-surface p-md shadow-[var(--shadow-e1)]"
        onClick={(e) => {
          if (!onAddPin) return;
          const r = (e.currentTarget as HTMLDivElement).getBoundingClientRect();
          const x = ((e.clientX - r.left) / r.width) * 100;
          const y = ((e.clientY - r.top) / r.height) * 100;
          onAddPin(x, y);
        }}
      >
        <div dangerouslySetInnerHTML={{ __html: contentHtml }} className="prose max-w-none" />
        {pins.map((p) => (
          <button
            key={p.id}
            type="button"
            aria-label={`コメント by ${p.author}`}
            onClick={(e) => {
              e.stopPropagation();
              setActive(p.id === active ? null : p.id);
            }}
            style={{ left: `${p.x}%`, top: `${p.y}%` }}
            className="absolute inline-flex h-6 w-6 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full bg-error text-label-sm font-bold text-error-fg shadow-[var(--shadow-e2)]"
          >
            !
          </button>
        ))}
      </div>
      <ul role="list" aria-label="コメント一覧" className="flex flex-col gap-sm">
        {pins.map((p) => (
          <li
            key={p.id}
            className={cn(
              'rounded-md border border-surface-variant px-md py-sm',
              active === p.id && 'border-primary bg-primary-container/30',
            )}
          >
            <p className="text-label-md font-semibold text-on-surface">{p.author}</p>
            <p className="text-body-sm text-on-surface">{p.text}</p>
          </li>
        ))}
      </ul>
    </article>
  );
}
