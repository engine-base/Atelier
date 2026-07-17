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
    <main className="flex min-h-dvh w-full items-center justify-center bg-gradient-to-b from-surface to-surface-variant px-md py-xl">
      <div className="w-full max-w-[440px]">
        {/* ブランドロゴ + マーク */}
        <div className="mb-lg flex items-center justify-center gap-2.5">
          <span
            aria-hidden="true"
            className="flex h-9 w-9 items-center justify-center rounded-md bg-primary text-[17px] font-bold text-on-primary"
          >
            A
          </span>
          <span className="text-[22px] font-extrabold tracking-tight text-on-surface">
            Atelier
          </span>
        </div>

        {/* 中央カード */}
        <div className="rounded-lg border border-border bg-white px-8 py-9 shadow-sm">
          <h1 className="mb-1.5 text-2xl font-bold tracking-tight text-on-surface">
            Atelier へようこそ
          </h1>
          <p className="mb-lg text-sm text-on-surface-variant">
            AI 社員と一緒に、複数案件を並行運用する作業環境へ。
          </p>

          {/* サインイン ⇄ サインアップ 切替タブ (セグメント) */}
          <div
            role="tablist"
            aria-label={t('auth.signin')}
            className="mb-lg flex gap-1 rounded-md bg-surface-variant p-1"
          >
            {(['signin', 'signup'] as const).map((m) => (
              <button
                key={m}
                type="button"
                role="tab"
                aria-selected={mode === m}
                onClick={() => setMode(m)}
                className={cn(
                  'flex-1 rounded-md py-2 text-center text-[13px] font-semibold transition-colors',
                  mode === m
                    ? 'bg-white text-on-surface shadow-sm'
                    : 'text-on-surface-variant hover:text-on-surface',
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

        {/* フッターノート */}
        <p className="mt-lg text-center text-xs text-on-surface-variant">
          アカウント作成で特商法表記も同意したとみなされます
        </p>
      </div>
    </main>
  );
}

export default function SA01Page() {
  return (
    <Suspense fallback={null}>
      <SA01Inner />
    </Suspense>
  );
}
