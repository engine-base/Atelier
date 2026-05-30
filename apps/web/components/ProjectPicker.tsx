/**
 * ProjectPicker — T-US-02 (TopBar 中央用)
 *
 * WorkspacePicker と同じ pattern。型のみ ProjectOption に差し替え。
 */

'use client';

import * as React from 'react';
import { ChevronDown } from 'lucide-react';
import { useId, useState } from 'react';

import { t } from '../lib/i18n';
import { cn } from '../lib/cn';

export interface ProjectOption {
  readonly id: string;
  readonly name: string;
}

export interface ProjectPickerProps {
  readonly value: string | undefined;
  readonly options: readonly ProjectOption[];
  readonly onChange: (id: string) => void;
  readonly className?: string;
}

export function ProjectPicker({ value, options, onChange, className }: ProjectPickerProps) {
  const [open, setOpen] = useState(false);
  const buttonId = useId();
  const listId = useId();
  const current = options.find((o) => o.id === value);

  return (
    <div className={cn('relative', className)}>
      <button
        id={buttonId}
        type="button"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={listId}
        onClick={() => setOpen((o) => !o)}
        className="inline-flex h-9 items-center gap-xs rounded-md border border-surface-variant bg-surface px-sm text-label-lg text-on-surface hover:bg-surface-variant"
      >
        <span className="text-label-md text-on-surface-variant">{t('nav.projects')}:</span>
        <span className="font-semibold">{current?.name ?? t('common.loading')}</span>
        <ChevronDown size={16} aria-hidden="true" />
      </button>
      {open ? (
        <ul
          id={listId}
          role="listbox"
          aria-labelledby={buttonId}
          className="absolute left-0 top-full z-overlay mt-xs min-w-48 rounded-md border border-surface-variant bg-surface shadow-[var(--shadow-e2)]"
        >
          {options.map((o) => {
            const selected = o.id === value;
            return (
              <li
                key={o.id}
                role="option"
                aria-selected={selected}
                onClick={() => {
                  onChange(o.id);
                  setOpen(false);
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    onChange(o.id);
                    setOpen(false);
                  }
                }}
                tabIndex={0}
                className={cn(
                  'cursor-pointer px-sm py-xs text-label-lg text-on-surface hover:bg-surface-variant',
                  selected && 'bg-primary-container text-primary-container-fg font-semibold',
                )}
              >
                {o.name}
              </li>
            );
          })}
        </ul>
      ) : null}
    </div>
  );
}
