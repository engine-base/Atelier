/**
 * S-B01 プロジェクト一覧画面 — T-UC-03
 *
 * 実 API `GET /projects` (カーソルページング) を呼んで一覧を描画する。
 * 認証は connector が cookie の JWT を Bearer ヘッダに載せて行う。
 *
 * オンボーディング是正: 新規ユーザーは workspace を1つも持たない。その状態では
 * プロジェクトを作れないため、まず「最初のワークスペースを作成」導線を出す
 * (以前は WS 作成 UI がどこにも無く、登録直後のユーザーが入り口で詰んでいた)。
 */

'use client';

import * as React from 'react';
import { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';

import { ProjectList, type ProjectRow } from './_components/ProjectList';
import * as api from '../../../lib/auth/connector';

const CURRENT_WS_KEY = 'atelier_current_workspace';

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

interface WorkspaceLite {
  readonly id: string;
  readonly name: string;
}

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

  // オンボーディング: workspace の有無を確定するまで、または未所持なら作成導線を出す。
  const [wsChecked, setWsChecked] = useState(false);
  const [needsWorkspace, setNeedsWorkspace] = useState(false);
  const [wsName, setWsName] = useState('');
  const [creatingWs, setCreatingWs] = useState(false);

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

  // 初回: workspace を持っているか確認。無ければ作成導線、あれば current を確定して一覧へ。
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await api.getJson<readonly WorkspaceLite[]>('/workspaces');
        if (cancelled) return;
        if (res.data.length === 0) {
          setNeedsWorkspace(true);
          setLoading(false);
        } else {
          const current = window.localStorage.getItem(CURRENT_WS_KEY);
          const known = res.data.some((w) => w.id === current);
          if (!current || !known) {
            window.localStorage.setItem(CURRENT_WS_KEY, res.data[0]!.id);
          }
          setNeedsWorkspace(false);
          await load(null);
        }
      } catch (e) {
        if (cancelled) return;
        if (e instanceof api.ApiError && e.status === 401) {
          router.push('/signin?redirect=/projects');
          return;
        }
        setError('ワークスペースの取得に失敗しました。');
        setLoading(false);
      } finally {
        if (!cancelled) setWsChecked(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [load, router]);

  const createWorkspace = useCallback(async (): Promise<void> => {
    const name = wsName.trim();
    if (!name) return;
    setCreatingWs(true);
    setError(null);
    try {
      const created = await api.sendJson<WorkspaceLite>('POST', '/workspaces', { name });
      const id = (created as WorkspaceLite | undefined)?.id;
      if (id) window.localStorage.setItem(CURRENT_WS_KEY, id);
      setNeedsWorkspace(false);
      await load(null);
    } catch {
      setError('ワークスペースの作成に失敗しました。');
    } finally {
      setCreatingWs(false);
    }
  }, [wsName, load]);

  const handleNew = useCallback(async (): Promise<void> => {
    const workspaceId = window.localStorage.getItem(CURRENT_WS_KEY);
    if (!workspaceId) {
      setNeedsWorkspace(true);
      return;
    }
    const name = window.prompt('新規プロジェクト名');
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

  // 未 workspace: 最初のワークスペースを作成するオンボーディング。
  if (wsChecked && needsWorkspace) {
    return (
      <div className="mx-auto flex w-full max-w-lg flex-col gap-6 px-8 py-16">
        <div>
          <p className="text-[11px] font-bold uppercase tracking-[0.14em] text-on-surface-variant">
            Welcome to Atelier
          </p>
          <h1 className="mt-2 text-3xl font-bold tracking-tight text-on-surface">
            最初のワークスペースを作成
          </h1>
          <p className="mt-2 text-body-md text-on-surface-variant">
            プロジェクト・AI社員・クライアント招待は、すべてワークスペースの中で管理します。
            まずは個人 or 組織のワークスペースを1つ作りましょう。
          </p>
        </div>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void createWorkspace();
          }}
          className="flex flex-col gap-4 rounded-lg border border-border bg-white p-6"
        >
          <label className="flex flex-col gap-1.5">
            <span className="text-label-md font-medium text-on-surface-variant">
              ワークスペース名
            </span>
            <input
              type="text"
              value={wsName}
              onChange={(e) => setWsName(e.target.value)}
              placeholder="例：ENGINE BASE"
              autoFocus
              className="h-11 rounded-md border border-border bg-surface px-3 text-body-md text-on-surface placeholder:text-on-surface-variant focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary-container"
            />
          </label>
          {error ? (
            <p role="alert" className="text-body-sm text-error">
              {error}
            </p>
          ) : null}
          <button
            type="submit"
            disabled={!wsName.trim() || creatingWs}
            className="inline-flex h-11 items-center justify-center rounded-md bg-primary px-4 text-label-lg font-semibold text-on-primary transition-colors hover:bg-[#1E54D8] focus-visible:outline-2 focus-visible:outline-primary disabled:opacity-50"
          >
            {creatingWs ? '作成中…' : 'ワークスペースを作成'}
          </button>
        </form>
      </div>
    );
  }

  return (
    <div className="mx-auto w-full max-w-[1200px] px-8 py-8">
      <ProjectList
        rows={rows}
        loading={loading || !wsChecked}
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
