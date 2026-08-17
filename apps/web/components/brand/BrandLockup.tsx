/**
 * 公式ブランドロックアップ (GAP-129 — 経営者指摘「マークと文字の間が狭い」)。
 *
 * 経営者支給の公式横ロゴ (logo-horizontal.svg) は 1 枚画像で、マークと
 * 「Atelier」文字の間隔が画像内に固定されている (実測: 高さの約 11%)。
 * そこで公式素材を **無改変のまま viewBox でマーク部/文字部に分割** した
 * 派生 2 枚 (logo-lockup-mark.svg / logo-lockup-word.svg — 両者は同一の
 * 縦レンジを共有し、同じ高さで並べると元のベースラインが再現される) を
 * 並べ、間隔だけ CSS gap で制御する。文字をアプリ側でタイプはしない。
 */

import * as React from "react";

import { cn } from "../../lib/cn";

export interface BrandLockupProps {
  /** 両画像に適用する高さクラス (例: "h-6")。 */
  readonly sizeClassName?: string;
  /** マークと文字の間隔 (例: "gap-2")。経営者調整ポイント。 */
  readonly gapClassName?: string;
  readonly className?: string;
}

export function BrandLockup({
  sizeClassName = "h-6",
  gapClassName = "gap-2",
  className,
}: BrandLockupProps) {
  return (
    <span className={cn("inline-flex items-center", gapClassName, className)}>
      {/* eslint-disable-next-line @next/next/no-img-element -- 静的 SVG のためサイズ最適化不要 */}
      <img
        src="/brand/logo-lockup-mark.svg"
        alt=""
        aria-hidden="true"
        className={cn(sizeClassName, "w-auto shrink-0 object-contain")}
      />
      {/* eslint-disable-next-line @next/next/no-img-element -- 静的 SVG のためサイズ最適化不要 */}
      <img
        src="/brand/logo-lockup-word.svg"
        alt="Atelier"
        className={cn(sizeClassName, "w-auto shrink-0 object-contain")}
      />
    </span>
  );
}
