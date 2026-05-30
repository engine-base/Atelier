/**
 * S-L02 クライアントサインイン画面 — T-UC-21 (R-T08)
 *
 * 招待 URL (例: /client/s_l02?token=...) でアクセスし、自動 fill。
 * 成功時は /client/projects/{id} に redirect する想定 (実 API 連携は別 PR)。
 *
 * `useSearchParams()` は Next 15 で Suspense 境界が必須 (prerender error 回避)。
 */

'use client';

import * as React from 'react';
import { Suspense } from 'react';
import { useSearchParams } from 'next/navigation';

import { ClientSigninForm, type ClientSigninValues } from './_components/ClientSigninForm';

function SL02Inner() {
  const params = useSearchParams();
  const tokenFromUrl = params.get('token') ?? undefined;

  const onSubmit = async (_v: ClientSigninValues): Promise<void> => {
    // TODO (T-A-35 連携 PR): apiClient.post('/client/auth/signin') →
    // 成功時 client_portal JWT cookie 設定 → /client/projects/{id} 遷移
  };

  return (
    <div className="w-full max-w-md rounded-lg border border-surface-variant bg-surface p-lg shadow-[var(--shadow-e2)]">
      <ClientSigninForm defaultToken={tokenFromUrl} onSubmit={onSubmit} />
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
