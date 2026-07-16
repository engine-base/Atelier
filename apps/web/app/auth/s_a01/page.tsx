/**
 * S-A01 サインイン/サインアップ画面 — T-UC-01
 *
 * - 上部に signin / signup 切替タブ
 * - 各 form は別 client component で render
 * - 実 API は middleware で /signin にアクセスした未認証ユーザー向け
 *
 * 本 page は Next.js 15 client component (タブ state を持つため)。
 * 実際の API 呼び出しは onSubmit から `@atelier/api-client` に委譲する想定だが、
 * 本 PR では UI 配線まで(ハンドラの実 API 連携は T-A-01/02 で既に API 完成済なので
 * 別 PR で connector 配線)。
 */

'use client';

import * as React from 'react';
import { Suspense, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';

import { SigninForm, type SigninValues } from './_components/SigninForm';
import { SignupForm, type SignupValues } from './_components/SignupForm';
import { t } from '../../../lib/i18n';
import { cn } from '../../../lib/cn';
import * as auth from '../../../lib/auth/connector';

type Mode = 'signin' | 'signup';

function SA01Inner() {
  const [mode, setMode] = useState<Mode>('signin');
  const [serverError, setServerError] = useState<string | null>(null);
  const router = useRouter();
  const params = useSearchParams();
  const redirectTo = params.get('redirect') || '/projects';

  const onSignin = async (v: SigninValues): Promise<void> => {
    setServerError(null);
    try {
      await auth.signin(v.email, v.password);
      router.push(redirectTo);
      router.refresh();
    } catch (e) {
      setServerError(e instanceof Error ? e.message : 'サインインに失敗しました');
    }
  };
  const onSignup = async (v: SignupValues): Promise<void> => {
    setServerError(null);
    try {
      await auth.signup(v.email, v.password);
      router.push(redirectTo);
      router.refresh();
    } catch (e) {
      setServerError(e instanceof Error ? e.message : 'サインアップに失敗しました');
    }
  };

  return (
    <div className="flex min-h-dvh w-full items-center justify-center bg-surface px-md py-lg">
      <div className="w-full max-w-md rounded-lg border border-surface-variant bg-surface p-lg shadow-[var(--shadow-e2)]">
        <div role="tablist" aria-label={t('auth.signin')} className="mb-md flex border-b border-surface-variant">
          {(['signin', 'signup'] as const).map((m) => (
            <button
              key={m}
              role="tab"
              aria-selected={mode === m}
              onClick={() => setMode(m)}
              className={cn(
                'flex-1 py-xs text-label-lg',
                mode === m
                  ? 'border-b-2 border-primary font-semibold text-primary'
                  : 'text-on-surface-variant',
              )}
            >
              {t(`auth.${m}`)}
            </button>
          ))}
        </div>
        {mode === 'signin' ? (
          <SigninForm onSubmit={onSignin} serverError={serverError} />
        ) : (
          <SignupForm onSubmit={onSignup} serverError={serverError} />
        )}
      </div>
    </div>
  );
}

export default function SA01Page() {
  return (
    <Suspense fallback={null}>
      <SA01Inner />
    </Suspense>
  );
}
