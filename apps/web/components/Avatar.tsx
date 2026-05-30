/**
 * Avatar — T-US-09 (人物アバター)
 *
 * - src あれば img、無ければ initials (name から最大2文字)
 * - decorative の場合は aria-hidden + alt=''、それ以外は alt 必須 (a11y)
 * - design tokens: surface-variant background、rounded-full
 */

'use client';

import * as React from 'react';
import { useState } from 'react';

import { cn } from '../lib/cn';

export type AvatarSize = 'sm' | 'md' | 'lg';

export interface AvatarProps {
  /** 表示名(initials の元、img の alt 既定) */
  readonly name: string;
  /** 画像 URL (省略で initials fallback) */
  readonly src?: string;
  /** 画像読み込み失敗時のフォールバック (initials) */
  readonly size?: AvatarSize;
  /** 装飾用なら true (aria-hidden) */
  readonly decorative?: boolean;
  /** カスタム alt (省略時は name) */
  readonly alt?: string;
  readonly className?: string;
}

const SIZE_CLASS: Record<AvatarSize, string> = {
  sm: 'h-6 w-6 text-label-sm',
  md: 'h-9 w-9 text-label-md',
  lg: 'h-12 w-12 text-label-lg',
};

/** name から initials を最大 2 文字抽出 (日本語は先頭 2 文字、ASCII は単語頭文字) */
export function deriveInitials(name: string): string {
  const trimmed = name.trim();
  if (!trimmed) return '?';
  // ASCII (空白で分割して各単語の頭文字)
  if (/^[\x20-\x7E]+$/.test(trimmed)) {
    const parts = trimmed.split(/\s+/).filter(Boolean);
    if (parts.length === 1) return parts[0]!.slice(0, 2).toUpperCase();
    return (parts[0]![0]! + parts[1]![0]!).toUpperCase();
  }
  // 日本語など — 先頭 2 文字
  return Array.from(trimmed).slice(0, 2).join('');
}

export function Avatar({ name, src, size = 'md', decorative, alt, className }: AvatarProps) {
  const [errored, setErrored] = useState(false);
  const showImage = Boolean(src) && !errored;
  const initials = deriveInitials(name);
  const a11yProps = decorative
    ? { 'aria-hidden': true as const, alt: '' }
    : { alt: alt ?? name };

  // src 無しの場合 wrapper 自体に aria-label を付けて SR にも識別を渡す
  const wrapperA11y = decorative
    ? { 'aria-hidden': true as const }
    : !showImage
      ? { 'aria-label': alt ?? name, role: 'img' as const }
      : {};

  return (
    <span
      {...wrapperA11y}
      className={cn(
        'inline-flex shrink-0 items-center justify-center overflow-hidden rounded-full bg-surface-variant text-on-surface-variant font-semibold',
        SIZE_CLASS[size],
        className,
      )}
      data-testid="avatar"
    >
      {showImage ? (
        // Avatar は外部 URL も多く、next/image の domain 設定強要を避けるため
        // 明示的に <img> を採用。alt は decorative 判定に応じて a11yProps で渡す。
        // eslint-disable-next-line @next/next/no-img-element, jsx-a11y/alt-text
        <img
          src={src}
          alt={a11yProps.alt}
          aria-hidden={a11yProps['aria-hidden']}
          onError={() => setErrored(true)}
          className="h-full w-full object-cover"
        />
      ) : (
        <span aria-hidden="true">{initials}</span>
      )}
    </span>
  );
}
