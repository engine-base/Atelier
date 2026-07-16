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
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-lg px-md py-lg">
      <header>
        <h1 className="text-headline-md font-bold text-on-surface">プロジェクト・シークレット</h1>
        <p className="mt-xs text-body-sm text-on-surface-variant">
          顧客・案件の機密情報（API キー / パスワード / トークン）を暗号化して保管します。
        </p>
      </header>

      <CredentialForm onSubmit={onCreate} />

      {error ? (
        <div role="alert" className="rounded-md border border-error bg-surface p-md text-error">
          {error}
        </div>
      ) : loading ? (
        <p className="text-on-surface-variant">読み込み中…</p>
      ) : (
        <CredentialList rows={rows} onReveal={onReveal} onDelete={onDelete} />
      )}
    </div>
  );
}

export default function SB04Page() {
  return (
    <Suspense fallback={null}>
      <SB04Inner />
    </Suspense>
  );
}
