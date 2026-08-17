/**
 * 公開ページ共通ヘッダー — S-PUB01〜04 (design-audit v2)
 *
 * モック 06_mockups/public/*.html の pub-header に準拠:
 *   ブランド (→ サインイン) + 法令ページナビ (利用規約 / プライバシー / 特商法)。
 * backHref 指定時はナビの代わりに戻りリンク 1 本を出す (S-PUB04 の形)。
 */

import * as React from "react";
import Link from "next/link";

import { BrandLockup } from "../../../components/brand/BrandLockup";

const NAV = [
  { href: "/terms", label: "利用規約" },
  { href: "/privacy", label: "プライバシーポリシー" },
  { href: "/tokushoho", label: "特商法表記" },
] as const;

export function PublicHeader({
  backHref,
  backLabel,
}: {
  readonly backHref?: string;
  readonly backLabel?: string;
}) {
  return (
    <header className="border-b border-border bg-white px-6 py-3.5">
      <div className="mx-auto flex max-w-[920px] items-center justify-between">
        <Link href="/signin" className="flex items-center">
          {/* GAP-126/129: 公式ロックアップ (間隔は BrandLockup の gap で制御) */}
          <BrandLockup sizeClassName="h-7" gapClassName="gap-2" />
        </Link>
        {backHref ? (
          <Link
            href={backHref}
            className="text-sm text-on-surface-variant transition hover:text-primary"
          >
            ← {backLabel ?? "戻る"}
          </Link>
        ) : (
          <nav aria-label="法令ページ" className="flex gap-4 text-[13px]">
            {NAV.map((n) => (
              <Link
                key={n.href}
                href={n.href}
                className="text-on-surface-variant transition hover:text-primary"
              >
                {n.label}
              </Link>
            ))}
          </nav>
        )}
      </div>
    </header>
  );
}
