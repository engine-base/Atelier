/**
 * EmployeeIcon — T-US-09 (AI 社員専用アイコン)
 *
 * Atelier の AI 社員(tony / strange / thor / wanda / vision / tchalla / steve)を
 * 視覚的に識別する。各社員は色 + 頭文字で表現(画像 asset が無い場合のデフォルト)。
 * Avatar との差異: 名前リスト固定、色マップ固定、AI である旨を aria-label に含める。
 */

'use client';

import * as React from 'react';

import { Avatar, type AvatarSize } from './Avatar';
import { cn } from '../lib/cn';

export type EmployeeId =
  | 'tony'
  | 'strange'
  | 'thor'
  | 'wanda'
  | 'vision'
  | 'tchalla'
  | 'steve';

const EMPLOYEE_LABEL: Record<EmployeeId, string> = {
  tony: 'Tony',
  strange: 'Strange',
  thor: 'Thor',
  wanda: 'Wanda',
  vision: 'Vision',
  tchalla: 'T’Challa',
  steve: 'Steve',
};

const EMPLOYEE_BG: Record<EmployeeId, string> = {
  tony: 'bg-error text-error-fg',
  strange: 'bg-secondary-container text-secondary-container-fg',
  thor: 'bg-primary text-primary-fg',
  wanda: 'bg-primary-container text-primary-container-fg',
  vision: 'bg-tertiary text-tertiary-fg',
  tchalla: 'bg-tertiary-container text-tertiary-container-fg',
  steve: 'bg-secondary text-secondary-fg',
};

export const EMPLOYEE_IDS: readonly EmployeeId[] = [
  'tony',
  'strange',
  'thor',
  'wanda',
  'vision',
  'tchalla',
  'steve',
];

export interface EmployeeIconProps {
  readonly employeeId: EmployeeId;
  readonly size?: AvatarSize;
  readonly src?: string;
  readonly className?: string;
}

/** 既定ペルソナ外の id (実 API の任意の name 等) でも落ちないための安全なフォールバック。 */
const FALLBACK_BG = 'bg-primary-container text-primary-container-fg';

export function EmployeeIcon({ employeeId, size = 'md', src, className }: EmployeeIconProps) {
  // 実データの社員 name は固定ペルソナキーとは限らない。未知キーでも
  // Avatar に undefined を渡して落とさないよう、id 文字列自体をラベルにフォールバック。
  const label = EMPLOYEE_LABEL[employeeId] ?? (employeeId ? String(employeeId) : 'AI');
  const bg = EMPLOYEE_BG[employeeId] ?? FALLBACK_BG;
  if (src) {
    return (
      <Avatar
        name={label}
        src={src}
        size={size}
        alt={`AI 社員 ${label}`}
        className={className}
      />
    );
  }
  return (
    <Avatar
      name={label}
      size={size}
      alt={`AI 社員 ${label}`}
      className={cn(bg, className)}
    />
  );
}
