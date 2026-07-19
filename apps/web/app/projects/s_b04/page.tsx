/**
 * S-B04 プロジェクト・シークレットタブ — T-UC-41
 *
 * 各プロジェクトの機密クレデンシャル (顧客/案件の API キー・パスワード・トークン) を
 * 暗号化保管するシークレット。一覧は値マスク、登録は暗号化、表示は reveal API + 監査。
 *
 * project_id は ?project=<uuid> で受け取る (プロジェクト配下のタブから遷移)。
 */

'use client';

import * as React from 'react';
import { Suspense, useCallback, useEffect, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';

import { CredentialList, type CredentialRow } from './_components/CredentialList';
import { CredentialForm, type CredentialInput } from './_components/CredentialForm';
import * as api from '../../../lib/auth/connector';

function SB04Inner() {
  const router = useRouter();
  const params = useSearchParams();
  const projectId = params.get('project') ?? '';

  const [rows, setRows] = useState<CredentialRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const base = `/projects/${projectId}/credentials`;

  const load = useCallback(async (): Promise<void> => {
    if (!projectId) {
      setError('プロジェクトが指定されていません。');
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const res = await api.getJson<CredentialRow[]>(base);
      setRows(res.data);
    } catch (e) {
      if (e instanceof api.ApiError && e.status === 401) {
        router.push('/signin?redirect=/projects/vault');
        return;
      }
      setError(e instanceof Error ? e.message : 'シークレットの取得に失敗しました');
    } finally {
      setLoading(false);
    }
  }, [base, projectId, router]);

  useEffect(() => {
    void load();
  }, [load]);

  const onCreate = async (input: CredentialInput): Promise<void> => {
    await api.sendJson('POST', base, input);
    await load();
  };

  const onReveal = async (id: string): Promise<string> => {
    const data = await api.sendJson<{ value: string }>('POST', `${base}/${id}/reveal`);
    return data?.value ?? '';
  };

  const onDelete = (id: string): void => {
    void (async () => {
      await api.sendJson('DELETE', `${base}/${id}`);
      await load();
    })();
  };

  return (
    <div className="mx-auto w-full max-w-[880px] px-6 py-8">
      <header className="mb-6">
        <h1 className="text-3xl font-bold tracking-tight text-on-surface">
          プロジェクト・シークレット
        </h1>
        <p className="mt-2 text-on-surface-variant">
          顧客・案件の機密クレデンシャル（APIキー・パスワード・トークン・接続文字列）を暗号化して保管します。
        </p>
      </header>

      <div className="mb-6 flex items-start gap-2.5 rounded-lg border border-[#FDE68A] bg-[#FFFBEB] p-4 text-[#78350F]">
        <ShieldCheckIcon className="mt-0.5 h-4 w-4 shrink-0" />
        <p className="text-sm">
          <strong className="font-bold">平文は保存・表示しません。</strong>{' '}
          値は Fernet で暗号化して保存され、暗号鍵は DB の外（環境変数）にあります。
          表示（reveal）と全変更操作は監査ログに記録され、ワークスペースメンバーのみアクセスできます（越境=0）。AI
          学習には利用しません。
        </p>
      </div>

      <div className="mb-6">
        <CredentialForm onSubmit={onCreate} />
      </div>

      <section className="rounded-lg border border-border bg-white p-5 shadow-sm">
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-base font-bold text-on-surface">クレデンシャル一覧</h2>
          <span className="text-sm text-on-surface-variant">{rows.length} 件</span>
        </div>

        {error ? (
          <div
            role="alert"
            className="rounded-md border-l-[3px] border-l-error bg-error/10 p-3 text-sm text-error"
          >
            {error}
          </div>
        ) : loading ? (
          <p className="py-12 text-center text-on-surface-variant">読み込み中…</p>
        ) : (
          <CredentialList rows={rows} onReveal={onReveal} onDelete={onDelete} />
        )}

        <p className="mt-4 flex items-center gap-1.5 text-sm text-on-surface-variant">
          <ShieldCheckIcon className="h-3.5 w-3.5 shrink-0" />
          「表示」は復号して一時的に平文を見せ、クリップボードへコピーできます。表示操作は監査ログに記録されます。
        </p>
      </section>
    </div>
  );
}

function ShieldCheckIcon({ className }: { readonly className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10Z" />
      <path d="m9 12 2 2 4-4" />
    </svg>
  );
}

export default function SB04Page() {
  return (
    <Suspense fallback={null}>
      <SB04Inner />
    </Suspense>
  );
}
