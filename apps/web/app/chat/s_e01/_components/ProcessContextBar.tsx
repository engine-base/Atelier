/**
 * S-E01 工程文脈バー — T-UC-09
 *
 * チャットの上部に現在の「工程 (phase)」を表示し、AI 社員が文脈を理解する。
 * phase change で AI に context を渡す callback も提供。
 */

'use client';

import * as React from 'react';

import { cn } from '../../../../lib/cn';

export interface ProcessContextBarProps {
  readonly phases: readonly string[];
  readonly currentPhaseId: string;
  readonly onChange: (phaseId: string) => void;
  readonly className?: string;
}

export function ProcessContextBar({
  phases,
  currentPhaseId,
  onChange,
  className,
}: ProcessContextBarProps) {
  return (
    <nav
      aria-label="工程文脈"
      className={cn(
        'flex items-center gap-xs overflow-x-auto rounded-md bg-surface-variant/40 px-sm py-xs',
        className,
      )}
    >
      <span className="shrink-0 text-label-md text-on-surface-variant">工程:</span>
      <ul role="list" className="flex gap-xs">
        {phases.map((p) => (
          <li key={p}>
            <button
              type="button"
              onClick={() => onChange(p)}
              aria-current={p === currentPhaseId ? 'true' : undefined}
              className={cn(
                'inline-flex h-7 items-center rounded-sm px-sm text-label-md',
                p === currentPhaseId
                  ? 'bg-primary text-primary-fg'
                  : 'bg-surface text-on-surface hover:bg-surface-variant',
              )}
            >
              {p}
            </button>
          </li>
        ))}
      </ul>
    </nav>
  );
}
