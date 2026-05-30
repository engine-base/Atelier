/**
 * Field — T-US-11 (label + control + error wired with aria)
 *
 * - <label for=id> で control と関連付け (placeholder のみでなく label 必須)
 * - error 時は aria-invalid + aria-describedby で SR にも error メッセージを伝える
 * - required 表記は aria/visual 両方
 *
 * React Hook Form と組み合わせる際は、children に `{...register('name')}` した
 * input/textarea を直接置く形 (Field は wrapper)。
 */

'use client';

import * as React from 'react';
import { type ReactNode, cloneElement, isValidElement, useId } from 'react';

import { t } from '../../lib/i18n';
import { cn } from '../../lib/cn';

export interface FieldProps {
  readonly label: string;
  readonly children: ReactNode;
  readonly error?: string | null;
  readonly required?: boolean;
  readonly description?: string;
  readonly className?: string;
}

export function Field({ label, children, error, required, description, className }: FieldProps) {
  const inputId = useId();
  const errorId = useId();
  const descId = useId();
  const hasError = Boolean(error);

  const enhancedChild = isValidElement(children)
    ? cloneElement(
        children as React.ReactElement<Record<string, unknown>>,
        {
          id: inputId,
          'aria-invalid': hasError || undefined,
          'aria-required': required || undefined,
          'aria-describedby':
            [hasError ? errorId : null, description ? descId : null]
              .filter(Boolean)
              .join(' ') || undefined,
        },
      )
    : children;

  return (
    <div className={cn('flex flex-col gap-xs', className)}>
      <label htmlFor={inputId} className="text-label-lg font-semibold text-on-surface">
        {label}
        {required ? (
          <span className="ml-xs text-error" aria-label={t('a11y.required')}>
            *
          </span>
        ) : null}
      </label>
      {description ? (
        <span id={descId} className="text-label-md text-on-surface-variant">
          {description}
        </span>
      ) : null}
      {enhancedChild}
      {hasError ? (
        <span id={errorId} role="alert" className="text-label-md text-error">
          {error}
        </span>
      ) : null}
    </div>
  );
}
