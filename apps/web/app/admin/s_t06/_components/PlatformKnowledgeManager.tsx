/**
 * S-T06 運営デフォルト・ナレッジ管理 — T-UC-42 (F-023 platform knowledge)
 *
 * 運営(admin)が platform-scope のデフォルトナレッジ (account_type=platform) を CRUD し、
 * visible_in_tree トグルで「テナント側ツリー表示 / 参照のみ」を切り替える。
 * 実 knowledge API (/knowledge) に TanStack Query で配線。
 *
 *   - 一覧: GET /knowledge?account_type=platform
 *   - 作成: POST /knowledge (account_type=platform, visible_in_tree 既定 false)
 *   - トグル: 既定では PATCH に visible_in_tree が無い (KnowledgeUpdate) ため、
 *     UI のトグルは作成時 / 再作成 ではなく PATCH で title 等と共に送る。
 *     ※ KnowledgeUpdate に visible_in_tree が無い場合は再作成 fallback を使わず、
 *       本マネージャは PATCH(title) で楽観反映し list を再取得する。
 *
 * admin gate: knowledge API が 403 を返したら AdminDenied を表示する。
 * api client は prop 注入可能 (テスト時に fake を渡せる)。
 */

'use client';

import * as React from 'react';
import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { ApiError, type ApiClient, type Paths } from '@atelier/api-client';

import { createAuthedApiClient } from '../../../../lib/auth/connector';
import { AdminButton } from '../../_components/AdminButton';
import { Dialog } from '../../../../components/ui/dialog';
import { Field } from '../../../../components/forms/Field';
import { AdminDenied } from '../../_components/AdminDenied';

/** PATCH /knowledge/{id} の request body 型 (生成 KnowledgeUpdate)。toggle 用 cast に使う */
type KnowledgeUpdateBody = NonNullable<
  Paths['/knowledge/{knowledge_id}']['patch']['requestBody']
>['content']['application/json'];

interface KnowledgeNode {
  id: string;
  title: string;
  category: string;
  content_md: string;
  visible_in_tree?: boolean;
  updated_at?: string;
}

/** platform account のフォールバック UUID (全テナント横断の運営層 account_id) */
const DEFAULT_PLATFORM_ACCOUNT_ID = '00000000-0000-0000-0000-000000000000';
const KEY = ['knowledge', 'platform'] as const;

export interface PlatformKnowledgeManagerProps {
  readonly client?: ApiClient;
  /** platform-scope の account_id。未指定なら運営層フォールバック UUID */
  readonly platformAccountId?: string;
}

function isForbidden(error: unknown): boolean {
  return error instanceof ApiError && error.status === 403;
}

export function PlatformKnowledgeManager({
  client: injected,
  platformAccountId,
}: PlatformKnowledgeManagerProps) {
  const client = useMemo(() => injected ?? createAuthedApiClient(), [injected]);
  const accountId = platformAccountId ?? DEFAULT_PLATFORM_ACCOUNT_ID;
  const queryClient = useQueryClient();

  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState('');
  const [category, setCategory] = useState('');
  const [content, setContent] = useState('');

  const list = useQuery({
    queryKey: KEY,
    queryFn: async () => {
      const res = await client.get('/knowledge', {
        params: { query: { account_type: 'platform' } },
      });
      return (res as { data?: KnowledgeNode[] }).data ?? [];
    },
    retry: false,
  });

  const invalidate = () => queryClient.invalidateQueries({ queryKey: KEY });

  const createMut = useMutation({
    mutationFn: () =>
      client.post('/knowledge', {
        body: {
          account_id: accountId,
          account_type: 'platform',
          scope: 'common',
          visible_in_tree: false,
          category,
          title,
          content_md: content,
          source_type: 'manual',
          confidence_score: 0.5,
          is_anonymized: false,
        },
      }),
    onSuccess: () => {
      setOpen(false);
      setTitle('');
      setCategory('');
      setContent('');
      void invalidate();
    },
  });

  const toggleMut = useMutation({
    mutationFn: (node: KnowledgeNode) =>
      client.patch('/knowledge/{knowledge_id}', {
        params: { path: { knowledge_id: node.id } },
        // backend Pydantic KnowledgeUpdate は visible_in_tree を受理するが、生成
        // openapi.ts の KnowledgeUpdate 型が stale で同フィールドを欠く (drift)。
        // generated 型を手編集せず、ここでのみ body を緩める。詳細は PR description 参照。
        body: { visible_in_tree: !(node.visible_in_tree ?? false) } as unknown as KnowledgeUpdateBody,
      }),
    onSuccess: () => void invalidate(),
  });

  if (isForbidden(list.error)) return <AdminDenied />;

  const rows = list.data ?? [];

  return (
    <section className="flex flex-col gap-md">
      <div className="rounded-lg border border-tertiary/40 bg-tertiary-container/30 p-md text-body-md text-on-surface">
        これは運営(プラットフォーム)層のナレッジです。account_type=
        <code>platform</code> / <code>visible_in_tree=false</code> で保存され、各テナントの AI 社員が
        参照(読み取り)のみ可能です。
      </div>

      <div className="flex items-center justify-between">
        <p className="text-body-md text-on-surface-variant">
          全テナント横断で AI 社員が参照するデフォルトナレッジ。
        </p>
        <AdminButton variant="primary" onClick={() => setOpen(true)}>
          新規追加
        </AdminButton>
      </div>

      {list.isLoading ? (
        <p className="text-body-md text-on-surface-variant">読み込み中…</p>
      ) : rows.length === 0 ? (
        <p className="text-body-md text-on-surface-variant">ナレッジがありません</p>
      ) : (
        <table className="w-full border-collapse">
          <caption className="sr-only">運営デフォルト・ナレッジ一覧</caption>
          <thead>
            <tr className="border-b border-surface-variant text-left text-label-md text-on-surface-variant">
              <th className="py-sm">タイトル</th>
              <th className="py-sm">カテゴリ</th>
              <th className="py-sm">ツリー表示</th>
              <th className="py-sm">更新日</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((k) => {
              const visible = k.visible_in_tree ?? false;
              return (
                <tr key={k.id} className="border-b border-surface-variant/60">
                  <td className="py-sm font-semibold text-on-surface">{k.title}</td>
                  <td className="py-sm text-label-md">{k.category}</td>
                  <td className="py-sm">
                    <button
                      type="button"
                      role="switch"
                      aria-checked={visible}
                      aria-label={`${k.title} のツリー表示を${visible ? 'OFF' : 'ON'}にする`}
                      disabled={toggleMut.isPending}
                      onClick={() => toggleMut.mutate(k)}
                      className={
                        'inline-flex h-5 w-10 items-center rounded-full px-0.5 transition-colors ' +
                        (visible ? 'bg-primary' : 'bg-surface-variant')
                      }
                    >
                      <span
                        className={
                          'h-4 w-4 rounded-full bg-surface transition-transform ' +
                          (visible ? 'translate-x-5' : 'translate-x-0')
                        }
                      />
                    </button>
                  </td>
                  <td className="py-sm text-label-md text-on-surface-variant">
                    {k.updated_at?.slice(0, 10) ?? '—'}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}

      <Dialog
        open={open}
        onClose={() => setOpen(false)}
        title="運営デフォルト・ナレッジを追加"
        className="max-w-2xl"
        footer={
          <>
            <AdminButton variant="ghost" onClick={() => setOpen(false)}>
              キャンセル
            </AdminButton>
            <AdminButton
              variant="primary"
              disabled={!title || !category || !content || createMut.isPending}
              onClick={() => createMut.mutate()}
            >
              追加する
            </AdminButton>
          </>
        }
      >
        <div className="flex flex-col gap-md">
          <Field label="タイトル" required>
            <input
              type="text"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              className="h-10 rounded-md border border-surface-variant bg-surface px-sm text-body-md text-on-surface"
            />
          </Field>
          <Field label="カテゴリ" required>
            <input
              type="text"
              value={category}
              onChange={(e) => setCategory(e.target.value)}
              className="h-10 rounded-md border border-surface-variant bg-surface px-sm text-body-md text-on-surface"
            />
          </Field>
          <Field label="本文 (Markdown)" required>
            <textarea
              rows={8}
              value={content}
              onChange={(e) => setContent(e.target.value)}
              className="rounded-md border border-surface-variant bg-surface px-sm py-sm font-mono text-body-md text-on-surface"
            />
          </Field>
        </div>
      </Dialog>
    </section>
  );
}
