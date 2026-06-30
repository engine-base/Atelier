/**
 * S-L02 クライアントサインイン画面 — T-UC-21 (R-T08)
 *
 * 招待 URL (例: /client/s_l02?token=...) でアクセスし、自動 fill。
 * 実 /client/auth/signin に配線し、成功で /client/s_l03 へ遷移する。
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

  return (
    <div className="w-full max-w-md rounded-lg border border-surface-variant bg-surface p-lg shadow-[var(--shadow-e2)]">
      <ClientSigninContainer defaultToken={tokenFromUrl} />
    </div>
  );
}

export default function SL02Page() {
  return (
    <div className="flex min-h-dvh w-full items-center justify-center bg-surface px-md py-lg">
      <Suspense fallback={null}>
        <SL02Inner />
      </Suspense>
    </div>
  );
}
