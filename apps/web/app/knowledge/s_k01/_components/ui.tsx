/**
 * S-K01 ローカル UI プリミティブ (T-UC-43)
 *
 * components/ui/button.tsx は `@/lib/cn` alias 依存で vitest 解決対象外のため、
 * ナレッジ画面ではトークン直書きの薄い button / 拒否状態を自己完結で持つ。
 */

"use client";

import * as React from "react";

type Variant = "primary" | "ghost" | "outlined";
type Size = "sm" | "md";

export interface KbButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  readonly variant?: Variant;
  readonly size?: Size;
}

const BASE =
  "inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-md font-semibold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary disabled:pointer-events-none disabled:opacity-50";

const VARIANTS: Record<Variant, string> = {
  primary: "bg-primary text-primary-fg hover:bg-[#1E54D8]",
  ghost: "text-on-surface hover:bg-surface-variant",
  outlined: "border border-primary text-primary hover:bg-primary-container",
};

const SIZES: Record<Size, string> = {
  sm: "h-9 px-3 text-label-md",
  md: "h-11 px-6 text-label-lg",
};

export function KbButton({
  variant = "primary",
  size = "md",
  className,
  type = "button",
  ...rest
}: KbButtonProps) {
  const cls = [BASE, VARIANTS[variant], SIZES[size], className]
    .filter(Boolean)
    .join(" ");
  // eslint-disable-next-line react/button-has-type
  return <button type={type} className={cls} {...rest} />;
}

/** 403（権限なし）時のフォールバック表示。 */
export function KbDenied() {
  return (
    <div
      role="alert"
      className="mx-auto mt-lg max-w-xl rounded-lg border border-error bg-surface p-lg text-center"
    >
      <h2 className="text-headline-md font-bold text-error">
        ナレッジを表示できません
      </h2>
      <p className="mt-sm text-body-md text-on-surface-variant">
        このワークスペースのナレッジにアクセスする権限がありません。
      </p>
    </div>
  );
}
