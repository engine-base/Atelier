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
  description: string | null;
  type: 'client_project' | 'self_product' | 'personal';
  status: 'in_progress' | 'draft' | 'paused' | 'archived';
  current_phase: string;
  created_at: string;
  updated_at: string;
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
            client_name: p.description,
            type: p.type,
            lifecycle: toLifecycle(p.status),
            currentPhase: p.current_phase,
            created_at: p.created_at,
            updated_at: p.updated_at,
          })),
        );
        setNextCursor((res.meta as ProjectsMeta | undefined)?.next_cursor ?? null);
      } catch (e) {
        if (e instanceof api.ApiError && e.status === 401) {
          router.push('/signin?redirect=/projects');
          return;
        }
        // e.message 直出しは API の生 detail (例 "forbidden") がそのまま画面に出る
        // 実バグが E2E で出たため、ユーザー向け固定文言に変換する。
        setError(
          e instanceof api.ApiError && e.status === 403
            ? 'プロジェクト一覧を表示する権限がありません。'
            : 'プロジェクトの取得に失敗しました。',
        );
      } finally {
        setLoading(false);
      }
    },
    [router],
  );

  useEffect(() => {
    void load(cursor);
  }, [cursor, load]);

  const handleNew = useCallback(async (): Promise<void> => {
    const workspaceId =
      typeof window !== 'undefined'
        ? window.localStorage.getItem('atelier_current_workspace')
        : null;
    if (!workspaceId) {
      setError('ワークスペースが選択されていません。');
      return;
    }
    const name = typeof window !== 'undefined' ? window.prompt('新規プロジェクト名') : null;
    if (!name || !name.trim()) return;
    try {
      await api.sendJson('POST', '/projects', {
        workspace_id: workspaceId,
        name: name.trim(),
        type: 'client_project',
      });
      await load(null);
    } catch {
      setError('プロジェクトの作成に失敗しました。');
    }
  }, [load]);

  return (
    <div className="mx-auto w-full max-w-[1200px] px-8 py-8">
      <ProjectList
        rows={rows}
        loading={loading}
        error={error}
        prevCursor={cursor}
        nextCursor={nextCursor}
        onPrev={() => setCursor(null)}
        onNext={() => setCursor(nextCursor)}
        onSelect={(id) => router.push(`/projects/dashboard?project=${id}`)}
        onNew={handleNew}
      />
    </div>
  );
}
