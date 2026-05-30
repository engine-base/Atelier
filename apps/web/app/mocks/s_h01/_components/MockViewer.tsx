/**
 * S-H01 モックビューア — T-UC-13
 *
 * 06_mockups 配下の HTML mock を iframe で表示。
 * 320 / 768 / 1024 / 1440 のレスポンシブ切替 (web/testing.md)。
 */

'use client';

import * as React from 'react';
import { useState } from 'react';

import { cn } from '../../../../lib/cn';

export type ViewportPreset = '320' | '768' | '1024' | '1440';

const VIEWPORT_W: Record<ViewportPreset, number> = {
  '320': 320,
  '768': 768,
  '1024': 1024,
  '1440': 1440,
};

const VIEWPORT_LABEL: Record<ViewportPreset, string> = {
  '320': 'モバイル (320)',
  '768': 'タブレット (768)',
  '1024': 'デスクトップ (1024)',
  '1440': 'ワイド (1440)',
};

export interface MockViewerProps {
  readonly src: string;
  readonly title: string;
  readonly initialPreset?: ViewportPreset;
}

export function MockViewer({ src, title, initialPreset = '1024' }: MockViewerProps) {
  const [preset, setPreset] = useState<ViewportPreset>(initialPreset);

  return (
    <section aria-label="モックビューア" className="flex flex-col gap-md">
      <h1 className="text-headline-md font-bold text-on-surface">{title}</h1>
      <div role="group" aria-label="ビューポート切替" className="flex gap-xs">
        {(Object.keys(VIEWPORT_W) as ViewportPreset[]).map((p) => (
          <button
            key={p}
            type="button"
            onClick={() => setPreset(p)}
            aria-pressed={preset === p}
            className={cn(
              'inline-flex h-8 items-center rounded-sm px-sm text-label-md',
              preset === p
                ? 'bg-primary text-primary-fg'
                : 'bg-surface-variant text-on-surface hover:bg-surface-variant/70',
            )}
          >
            {VIEWPORT_LABEL[p]}
          </button>
        ))}
      </div>
      <div className="flex justify-center overflow-x-auto rounded-md bg-surface-variant/30 p-md">
        <iframe
          title={title}
          src={src}
          width={VIEWPORT_W[preset]}
          height={600}
          className="border border-surface-variant bg-surface"
        />
      </div>
    </section>
  );
}
