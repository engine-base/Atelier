/**
 * S-B01 プロジェクト一覧画面 — T-UC-03
 *
 * 実 API `GET /projects` (カーソルページング) を呼んで一覧を描画する。
 * 認証は connector が cookie の JWT を Bearer ヘッダに載せて行う。
 */

'use client';

import * as React from 'react';
import { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';

import { ProjectList, type ProjectRow } from './_components/ProjectList';
import * as api from '../../../lib/auth/connector';

/** API ProjectResponse のうち本画面が使うフィールド。 */
interface ApiProject {
  id: string;
  name: string;
  status: 'in_progress' | 'draft' | 'paused' | 'archived';
  created_at: string;
}

interface ProjectsMeta {
  next_cursor: string | null;
}

/** API status → UI lifecycle にマッピング。 */
function toLifecycle(status: ApiProject['status']): ProjectRow['lifecycle'] {
  if (status === 'archived') return 'archived';
  if (status === 'paused') return 'paused';
  return 'active';
}

export default function SB01Page() {
  const router = useRouter();
  const [rows, setRows] = useState<ProjectRow[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(
    async (c: string | null): Promise<void> => {
      setLoading(true);
      setError(null);
      try {
        const qs = new URLSearchParams({ limit: '20' });
        if (c) qs.set('cursor', c);
        const res = await api.getJson<ApiProject[]>(`/projects?${qs.toString()}`);
        setRows(
          res.data.map((p) => ({
            id: p.id,
            name: p.name,
            client_name: null,
            lifecycle: toLifecycle(p.status),
            created_at: p.created_at,
          })),
        );
        setNextCursor((res.meta as ProjectsMeta | undefined)?.next_cursor ?? null);
      } catch (e) {
        if (e instanceof api.ApiError && e.status === 401) {
          router.push('/auth/s_a01?redirect=/projects/s_b01');
          return;
        }
        setError(e instanceof Error ? e.message : 'プロジェクトの取得に失敗しました');
      } finally {
        setLoading(false);
      }
    },
    [router],
  );

  useEffect(() => {
    void load(cursor);
  }, [cursor, load]);

  return (
    <div className="mx-auto flex w-full max-w-5xl flex-col gap-lg px-md py-lg">
      <header className="flex items-center justify-between">
        <h1 className="text-headline-md font-bold text-on-surface">プロジェクト一覧</h1>
      </header>
      {error ? (
        <div role="alert" className="rounded-md border border-error bg-surface p-md text-error">
          {error}
        </div>
      ) : loading ? (
        <p className="text-on-surface-variant">読み込み中…</p>
      ) : rows.length === 0 ? (
        <p className="text-on-surface-variant">プロジェクトがまだありません。</p>
      ) : (
        <ProjectList
          rows={rows}
          prevCursor={cursor}
          nextCursor={nextCursor}
          onPrev={() => setCursor(null)}
          onNext={() => setCursor(nextCursor)}
          onSelect={(id) => router.push(`/projects/s_b02?project=${id}`)}
        />
      )}
    </div>
  );
}
