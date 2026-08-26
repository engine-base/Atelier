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

import Link from 'next/link';

import { OAuthButtons } from './_components/OAuthButtons';
import { RestoreForm, type RestoreValues } from './_components/RestoreForm';
import { SigninForm, type SigninValues } from './_components/SigninForm';
import { SignupForm, type SignupValues } from './_components/SignupForm';
import { t } from '../../../lib/i18n';
import { cn } from '../../../lib/cn';
import * as auth from '../../../lib/auth/connector';
import { BrandLockup } from '../../../components/brand/BrandLockup';

type Mode = 'signin' | 'signup' | 'restore';

function SA01Inner() {
  const [mode, setMode] = useState<Mode>('signin');
  const [serverError, setServerError] = useState<string | null>(null);
  const [magicSent, setMagicSent] = useState(false);
  const [restored, setRestored] = useState(false);
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
  // Magic Link (API は登録有無を秘匿して常に 202)
  const onMagicLink = async (email: string): Promise<void> => {
    setServerError(null);
    setMagicSent(false);
    try {
      await auth.sendJson('POST', '/auth/magic-link/request', { email });
      setMagicSent(true);
    } catch {
      setServerError('マジックリンクの送信に失敗しました。時間をおいて再度お試しください。');
    }
  };

  // GAP-233: 退会 (soft-delete) から 30 日以内の復元。
  // API は前からあったが UI からの導線が無く、受付表示の「キャンセル可能」が実行不能だった。
  const onRestore = async (v: RestoreValues): Promise<void> => {
    setServerError(null);
    try {
      await auth.sendJson('POST', '/auth/account/restore', {
        email: v.email,
        password: v.password,
      });
      setRestored(true);
      setMode('signin');
    } catch (e) {
      setServerError(e instanceof Error ? e.message : '復元に失敗しました');
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
        <div className="mb-lg flex items-center justify-center">
          {/* GAP-126/129: 公式ロックアップ (間隔は BrandLockup の gap で制御) */}
          <BrandLockup sizeClassName="h-11" gapClassName="gap-3" />
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

          {/* OAuth サインイン (GAP-020) — 有効プロバイダのみ描画、0 件なら divider ごと非表示 */}
          <OAuthButtons />

          {magicSent ? (
            <p
              role="status"
              className="mb-4 rounded-md border-l-[3px] border-primary bg-primary-container px-3 py-2 text-xs text-on-primary-container"
            >
              登録済みのメールアドレスであれば、サインイン用リンクを送信しました。メールをご確認ください。
            </p>
          ) : null}
          {restored && mode === 'signin' ? (
            <p
              role="status"
              className="mb-4 rounded-md border-l-[3px] border-primary bg-primary-container px-3 py-2 text-xs text-on-primary-container"
            >
              アカウントを復元しました。そのままサインインしてください。
            </p>
          ) : null}
          {mode === 'signin' ? (
            <SigninForm
              onSubmit={onSignin}
              onMagicLink={(email) => void onMagicLink(email)}
              serverError={serverError}
            />
          ) : mode === 'signup' ? (
            <SignupForm onSubmit={onSignup} serverError={serverError} />
          ) : (
            <RestoreForm onSubmit={onRestore} serverError={serverError} />
          )}
          <p className="mt-4 text-center text-xs text-on-surface-variant">
            {mode === 'restore' ? (
              <button
                type="button"
                onClick={() => {
                  setMode('signin');
                  setServerError(null);
                }}
                className="font-semibold text-primary hover:underline"
              >
                サインインに戻る
              </button>
            ) : (
              <button
                type="button"
                onClick={() => {
                  setMode('restore');
                  setServerError(null);
                }}
                className="font-semibold text-primary hover:underline"
              >
                退会済みアカウントの復元
              </button>
            )}
          </p>
        </div>

        {/* フッターノート */}
        <p className="mt-lg text-center text-xs text-on-surface-variant">
          アカウント作成で{' '}
          <Link href="/tokushoho" className="font-semibold text-primary hover:underline">
            特商法表記
          </Link>{' '}
          も同意したとみなされます
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
