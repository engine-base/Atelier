/**
 * S-L02 クライアントサインイン画面 — T-UC-21 (R-T08)
 *
 * 招待 URL (例: /portal/signin?token=...) でアクセスし、自動 fill。
 * 実 /client/auth/signin に配線し、成功で /portal へ遷移する。
 *
 * 見た目は 06_mockups/client/S-L02-signin.html に忠実:
 *   ベア・中央寄せ / ブランド → 招待グリーティングカード → 白いサインインカード
 *   (実フォーム) → フッター注記。
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

        {/* 招待グリーティングカード */}
        <div className="mb-4 rounded-lg bg-[linear-gradient(135deg,var(--color-primary-container)_0%,var(--color-tertiary-container)_100%)] px-8 py-7 text-center">
          <div className="mb-2 text-[11px] font-bold uppercase tracking-[0.14em] text-on-primary-container opacity-[0.85]">
            Client Portal
          </div>
          <h1 className="mb-2.5 text-[22px] font-bold tracking-[-0.02em] text-on-primary-container">
            ご招待ありがとうございます
          </h1>
          <p className="text-[13px] text-on-primary-container opacity-90">
            高本まさと さんから以下のプロジェクトへ招待されました。
          </p>

          {/* プロジェクトカード */}
          <div className="mt-4 rounded-md bg-[rgba(255,255,255,0.7)] px-[18px] py-3.5 text-left">
            <div className="text-[13px] text-on-surface-variant">プロジェクト</div>
            <div className="mb-2 text-[15px] font-bold text-on-surface">
              小松様 EC モール統合
            </div>
            <div className="flex items-center gap-2 text-[13px] text-on-surface">
              <span className="inline-flex h-6 w-6 items-center justify-center rounded-full bg-primary text-[11px] font-bold text-primary-fg">
                M
              </span>
              <span>高本まさと · ENGINE BASE</span>
            </div>
          </div>
        </div>

        {/* サインインカード (実フォーム) */}
        <Suspense fallback={null}>
          <SL02Inner />
        </Suspense>

        {/* フッター注記 */}
        <p className="mt-4 text-center text-[12px] text-on-surface-variant">
          招待リンクに問題がある場合は、招待元へお問い合わせください
          <br />
          <a
            href="mailto:masato@engine-base.com"
            className="text-primary hover:underline"
          >
            masato@engine-base.com
          </a>
        </p>
      </div>
    </main>
  );
}
