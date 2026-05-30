/**
 * Skeleton — T-US-17 (ローディング placeholder)
 *
 * - 単発の rectangular/circle/text 形状を提供
 * - design tokens: surface-variant、pulse animation (motion-reduce 配慮)
 * - aria-busy="true" + role="status" で SR に「読み込み中」と伝える
 */

'use client';

import * as React from 'react';

import { cn } from '../lib/cn';
import { t } from '../lib/i18n';

export type SkeletonShape = 'rect' | 'circle' | 'text';

export interface SkeletonProps {
  readonly shape?: SkeletonShape;
  readonly width?: string | number;
  readonly height?: string | number;
  readonly className?: string;
  /** SR 用ラベル (省略時は loading) */
  readonly label?: string;
}

const SHAPE_CLASS: Record<SkeletonShape, string> = {
  rect: 'rounded-md',
  circle: 'rounded-full',
  text: 'rounded-sm',
};

export function Skeleton({
  shape = 'rect',
  width,
  height,
  className,
  label,
}: SkeletonProps) {
  return (
    <span
      role="status"
      aria-busy="true"
      aria-label={label ?? t('a11y.loading')}
      style={{ width, height }}
      className={cn(
        'inline-block animate-pulse bg-surface-variant',
        SHAPE_CLASS[shape],
        shape === 'text' && 'h-4',
        className,
      )}
    />
  );
}
