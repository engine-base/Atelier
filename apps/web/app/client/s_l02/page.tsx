/**
 * S-L02 クライアントサインイン画面 — T-UC-21 (R-T08)
 *
 * 招待 URL (例: /portal/signin?token=...) でアクセスし、自動 fill。
 * 実 /client/auth/signin に配線し、成功で /portal へ遷移する。
 *
 * 見た目は 06_mockups/client/S-L02-signin.html に忠実:
 *   ベア・中央寄せ / ブランド → 招待グリーティングカード → 白いサインインカード
 *   (実フォーム) → フッター注記。
 * グリーティングカードは GAP-028 の署名前プレビュー対応のため
 * ClientSigninContainer 側で描画する (URL トークン有効時は実招待元/
 * プロジェクト名、無効/未取得時は汎用文言)。
 *
 * `useSearchParams()` は Next 15 で Suspense 境界が必須 (prerender error 回避)。
 */

"use client";

import * as React from "react";
import { Suspense } from "react";
import { useSearchParams } from "next/navigation";

import { ClientSigninContainer } from "./_components/ClientSigninContainer";

function SL02Inner() {
  const params = useSearchParams();
  const tokenFromUrl = params.get("token") ?? undefined;

  return <ClientSigninContainer defaultToken={tokenFromUrl} />;
}

export default function SL02Page() {
  return (
    <main className="flex min-h-dvh w-full items-center justify-center bg-[linear-gradient(180deg,var(--color-surface)_0%,var(--color-surface-variant)_100%)] px-5 py-8">
      <div className="w-full max-w-[480px]">
        {/* ブランド */}
        <div className="mb-6 flex items-center justify-center gap-2.5">
          <div className="flex h-9 w-9 items-center justify-center rounded-md bg-primary text-[17px] font-bold text-primary-fg">
            A
          </div>
          <div className="text-[22px] font-extrabold tracking-[-0.02em] text-on-surface">
            Atelier
          </div>
        </div>

        {/* 招待グリーティングカード + サインインカード (実フォーム) —
            グリーティングは Container が preview 対応で描画 (GAP-028) */}
        <Suspense fallback={null}>
          <SL02Inner />
        </Suspense>

        {/* フッター注記 */}
        <p className="mt-4 text-center text-[12px] text-on-surface-variant">
          招待リンクに問題がある場合は、招待元（担当者）へお問い合わせください。
        </p>
      </div>
    </main>
  );
}
