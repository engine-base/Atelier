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
  /** ai_employees.icon (ユーザーが S-C02 で選んだ lucide アイコン名)。指定時は頭文字の代わりに描画。 */
  readonly iconName?: string;
  readonly className?: string;
}

/** 既定ペルソナ外の id (実 API の任意の name 等) でも落ちないための安全なフォールバック。 */
const FALLBACK_BG = 'bg-primary-container text-primary-container-fg';

/** S-C02「Lucide から選ぶ」で選択できるアイコン (ai_employees.icon の許容値)。 */
export const EMPLOYEE_ICON_CHOICES = [
  'bot',
  'brain',
  'rocket',
  'star',
  'shield',
  'zap',
  'heart',
  'sparkles',
  'cpu',
  'crown',
  'flame',
  'glasses',
] as const;

const ICON_SIZE: Record<AvatarSize, string> = {
  sm: 'h-6 w-6',
  md: 'h-9 w-9',
  lg: 'h-12 w-12',
};

const ICON_GLYPH_SIZE: Record<AvatarSize, number> = { sm: 13, md: 18, lg: 24 };

/** lucide 名 → 動的 import なしで使う固定マップ (EMPLOYEE_ICON_CHOICES と 1:1)。 */
function iconGlyph(name: string, px: number): React.ReactNode | null {
  const common = {
    width: px,
    height: px,
    viewBox: '0 0 24 24',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 2,
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const,
    'aria-hidden': true,
  };
  switch (name) {
    case 'bot':
      return (
        <svg {...common}>
          <path d="M12 8V4H8" />
          <rect width="16" height="12" x="4" y="8" rx="2" />
          <path d="M2 14h2M20 14h2M15 13v2M9 13v2" />
        </svg>
      );
    case 'brain':
      return (
        <svg {...common}>
          <path d="M9.5 2A2.5 2.5 0 0 1 12 4.5v15a2.5 2.5 0 0 1-4.96.44 2.5 2.5 0 0 1-2.96-3.08 3 3 0 0 1-.34-5.58 2.5 2.5 0 0 1 1.32-4.24 2.5 2.5 0 0 1 4.44-1.04Z" />
          <path d="M14.5 2A2.5 2.5 0 0 0 12 4.5v15a2.5 2.5 0 0 0 4.96.44 2.5 2.5 0 0 0 2.96-3.08 3 3 0 0 0 .34-5.58 2.5 2.5 0 0 0-1.32-4.24 2.5 2.5 0 0 0-4.44-1.04Z" />
        </svg>
      );
    case 'rocket':
      return (
        <svg {...common}>
          <path d="M4.5 16.5c-1.5 1.26-2 5-2 5s3.74-.5 5-2c.71-.84.7-2.13-.09-2.91a2.18 2.18 0 0 0-2.91-.09z" />
          <path d="m12 15-3-3a22 22 0 0 1 2-3.95A12.88 12.88 0 0 1 22 2c0 2.72-.78 7.5-6 11a22.35 22.35 0 0 1-4 2z" />
          <path d="M9 12H4s.55-3.03 2-4c1.62-1.08 5 0 5 0M12 15v5s3.03-.55 4-2c1.08-1.62 0-5 0-5" />
        </svg>
      );
    case 'star':
      return (
        <svg {...common}>
          <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2" />
        </svg>
      );
    case 'shield':
      return (
        <svg {...common}>
          <path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z" />
        </svg>
      );
    case 'zap':
      return (
        <svg {...common}>
          <polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2" />
        </svg>
      );
    case 'heart':
      return (
        <svg {...common}>
          <path d="M19 14c1.49-1.46 3-3.21 3-5.5A5.5 5.5 0 0 0 16.5 3c-1.76 0-3 .5-4.5 2-1.5-1.5-2.74-2-4.5-2A5.5 5.5 0 0 0 2 8.5c0 2.3 1.5 4.05 3 5.5l7 7Z" />
        </svg>
      );
    case 'sparkles':
      return (
        <svg {...common}>
          <path d="m12 3-1.9 5.8a2 2 0 0 1-1.287 1.288L3 12l5.8 1.9a2 2 0 0 1 1.288 1.287L12 21l1.9-5.8a2 2 0 0 1 1.287-1.288L21 12l-5.8-1.9a2 2 0 0 1-1.288-1.287Z" />
        </svg>
      );
    case 'cpu':
      return (
        <svg {...common}>
          <rect width="16" height="16" x="4" y="4" rx="2" />
          <rect width="6" height="6" x="9" y="9" rx="1" />
          <path d="M15 2v2M15 20v2M2 15h2M2 9h2M20 15h2M20 9h2M9 2v2M9 20v2" />
        </svg>
      );
    case 'crown':
      return (
        <svg {...common}>
          <path d="M11.562 3.266a.5.5 0 0 1 .876 0L15.39 8.87a1 1 0 0 0 1.516.294L21.183 5.5a.5.5 0 0 1 .798.519l-2.834 10.246a1 1 0 0 1-.956.735H5.81a1 1 0 0 1-.957-.735L2.02 6.02a.5.5 0 0 1 .798-.519l4.276 3.664a1 1 0 0 0 1.516-.294z" />
        </svg>
      );
    case 'flame':
      return (
        <svg {...common}>
          <path d="M8.5 14.5A2.5 2.5 0 0 0 11 12c0-1.38-.5-2-1-3-1.072-2.143-.224-4.054 2-6 .5 2.5 2 4.9 4 6.5 2 1.6 3 3.5 3 5.5a7 7 0 1 1-14 0c0-1.153.433-2.294 1-3a2.5 2.5 0 0 0 2.5 2.5z" />
        </svg>
      );
    case 'glasses':
      return (
        <svg {...common}>
          <circle cx="6" cy="15" r="4" />
          <circle cx="18" cy="15" r="4" />
          <path d="M14 15a2 2 0 0 0-2-2 2 2 0 0 0-2 2M2.5 13 5 7c.7-1.3 1.4-2 3-2M21.5 13 19 7c-.7-1.3-1.5-2-3-2" />
        </svg>
      );
    default:
      return null;
  }
}

export function EmployeeIcon({
  employeeId,
  size = 'md',
  src,
  iconName,
  className,
}: EmployeeIconProps) {
  // 実データの社員 name は固定ペルソナキーとは限らない。未知キーでも
  // Avatar に undefined を渡して落とさないよう、id 文字列自体をラベルにフォールバック。
  const label = EMPLOYEE_LABEL[employeeId] ?? (employeeId ? String(employeeId) : 'AI');
  const bg = EMPLOYEE_BG[employeeId] ?? FALLBACK_BG;
  const glyph = iconName ? iconGlyph(iconName, ICON_GLYPH_SIZE[size]) : null;
  if (glyph) {
    return (
      <span
        role="img"
        aria-label={`AI 社員 ${label}`}
        className={cn(
          'inline-flex shrink-0 items-center justify-center rounded-full',
          ICON_SIZE[size],
          bg,
          className,
        )}
      >
        {glyph}
      </span>
    );
  }
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
