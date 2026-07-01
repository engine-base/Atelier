/**
 * AdminButton — 運営画面用の軽量ボタン (T-UC-42)
 *
 * components/ui/button.tsx は `@/lib/cn` alias 依存で vitest 解決対象外のため、
 * admin 画面ではトークン直書きの薄い button を使う。variant は primary / ghost。
 */

"use client";

import * as React from "react";

type Variant = "primary" | "ghost";
type Size = "sm" | "md";

export interface AdminButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  readonly variant?: Variant;
  readonly size?: Size;
}

const BASE =
  "inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-md font-semibold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary disabled:pointer-events-none disabled:opacity-50";

const VARIANTS: Record<Variant, string> = {
  primary: "bg-primary text-primary-fg hover:bg-primary/90",
  ghost: "text-on-surface hover:bg-surface-variant",
};

const SIZES: Record<Size, string> = {
  sm: "h-9 px-3 text-label-md",
  md: "h-11 px-6 text-label-lg",
};

export function AdminButton({
  variant = "primary",
  size = "md",
  className,
  type = "button",
  ...rest
}: AdminButtonProps) {
  const cls = [BASE, VARIANTS[variant], SIZES[size], className]
    .filter(Boolean)
    .join(" ");
  // eslint-disable-next-line react/button-has-type
  return <button type={type} className={cls} {...rest} />;
}
