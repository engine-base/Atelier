/**
 * /auth/oauth-complete — OAuth コールバックの着地ページ (GAP-020)
 *
 * API の GET /auth/oauth/{provider}/callback が
 *   - 成功: #access_token=…&expires_at=…&user_id=…&email=…&display_name=…
 *     (フラグメント = サーバーログ / Referer に漏れない) で 302
 *   - 失敗: ?error=access_denied|exchange_failed|account_inactive で 302
 * してくる。成功時は既存 signin (lib/auth/connector.setAccessCookie) と同一書式で
 * atelier_access cookie に格納し /projects へ遷移。失敗時は誠実にエラーを表示して
 * サインイン (/auth/s_a01) へ戻す。偽の成功表示はしない。
 */

'use client';

import * as React from 'react';
import { Suspense } from 'react';
import { useSearchParams } from 'next/navigation';

import Link from 'next/link';

import { COOKIE_NAMES } from '../../../lib/auth/cookie';

/** ?error= コードの誠実な文言化 (不明コードもコードごと表示して隠さない) */
function describeError(code: string): string {
  switch (code) {
    case 'access_denied':
      return 'プロバイダでの認可がキャンセルされました。もう一度お試しいただくか、メールアドレスでサインインしてください。';
    case 'exchange_failed':
      return 'プロバイダとの通信に失敗しました。時間をおいて再度お試しください。';
    case 'account_inactive':
      return 'このアカウントは退会済みのため利用できません。復活をご希望の場合はサインイン画面からお手続きください。';
    default:
      return `OAuth サインインに失敗しました (${code})。`;
  }
}

type Status = 'working' | 'error';

function OAuthCompleteInner() {
  const params = useSearchParams();
  const errorParam = params.get('error');
  const [status, setStatus] = React.useState<Status>('working');
  const [message, setMessage] = React.useState<string | null>(null);

  React.useEffect(() => {
    if (errorParam) {
      setStatus('error');
      setMessage(describeError(errorParam));
      return;
    }
    // フラグメント (#access_token=…) からトークンを受領
    const hash = window.location.hash.replace(/^#/, '');
    const frag = new URLSearchParams(hash);
    const token = frag.get('access_token');
    const expiresAt = frag.get('expires_at');
    if (!token || !expiresAt) {
      setStatus('error');
      setMessage(
        'サインイントークンを受け取れませんでした。お手数ですが、もう一度サインインをお試しください。',
      );
      return;
    }
    // 既存 signin 成功時と同じ格納方式 (connector.setAccessCookie と同一書式)
    const expires = new Date(expiresAt).toUTCString();
    document.cookie = `${COOKIE_NAMES.access}=${token}; path=/; expires=${expires}; SameSite=Lax`;
    // location.replace = 完全遷移。①現在の履歴エントリごと置換するため
    // トークン付き URL が履歴に残らない ②ログイン直後は middleware /
    // server component に新 cookie を見せる full load が必要 ③手動
    // history.replaceState + router.replace の組合せは App Router の内部
    // 状態を壊して遷移が静かに失敗する (Mac 実機で「サインインしています…」
    // 固着として発現 — 実ブラウザ再現で特定した実バグ)。
    window.location.replace('/projects');
  }, [errorParam]);

  return (
    <main className="flex min-h-dvh w-full items-center justify-center bg-gradient-to-b from-surface to-surface-variant px-md py-xl">
      <div className="w-full max-w-[440px]">
        {/* ブランドロゴ + マーク (S-A01 と同一) */}
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

        <div className="rounded-lg border border-border bg-white px-8 py-9 shadow-sm">
          {status === 'error' ? (
            <>
              <h1 className="mb-1.5 text-2xl font-bold tracking-tight text-on-surface">
                サインインできませんでした
              </h1>
              <p
                role="alert"
                className="mb-6 rounded-md border-l-[3px] border-error bg-[#FEE2E2] px-3 py-2 text-sm text-[#991B1B]"
              >
                {message}
              </p>
              <Link
                href="/auth/s_a01"
                className="inline-flex w-full items-center justify-center rounded-md bg-primary px-6 py-3 text-sm font-semibold text-on-primary transition-colors hover:bg-[#1E54D8] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-container"
              >
                サインインへ戻る
              </Link>
            </>
          ) : (
            <p role="status" className="text-sm text-on-surface-variant">
              サインインしています…
            </p>
          )}
        </div>
      </div>
    </main>
  );
}

export { OAuthCompleteInner };

export default function OAuthCompletePage() {
  return (
    <Suspense fallback={null}>
      <OAuthCompleteInner />
    </Suspense>
  );
}
