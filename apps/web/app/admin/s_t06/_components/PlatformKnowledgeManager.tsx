/**
 * S-T06 運営デフォルト・ナレッジ管理 — T-UC-42 (F-023 platform knowledge)
 *
 * 運営(admin)が platform(運営デフォルト)ナレッジを CRUD し、visible_in_tree トグルで
 * 「テナント側ツリー表示 / 参照のみ」を切り替える。運営ナレッジ管理 API (T-A-50 / F-023)
 * に TanStack Query で配線。platform 書込は RLS 上 service_role のみのため、通常の
 * /knowledge ではなく admin 専用の /admin/knowledge を使う。
 *
 *   - 一覧: GET /admin/knowledge
 *   - 作成: POST /admin/knowledge (account_type/account_id は server が固定)
 *   - トグル: PATCH /admin/knowledge/{id} { visible_in_tree }
 *
 * admin gate: API が 403 を返したら AdminDenied を表示する。
 * api client は prop 注入可能 (テスト時に fake を渡せる)。
 */

"use client";

import * as React from "react";
import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { ApiError, type ApiClient } from "@atelier/api-client";

import { createAuthedApiClient } from "../../../../lib/auth/connector";
import { AdminButton } from "../../_components/AdminButton";
import { Dialog } from "../../../../components/ui/dialog";
import { Field } from "../../../../components/forms/Field";
import { AdminDenied } from "../../_components/AdminDenied";

interface KnowledgeNode {
  id: string;
  title: string;
  category: string;
  content_md: string;
  visible_in_tree?: boolean;
  updated_at?: string;
}

const KEY = ["admin-knowledge", "platform"] as const;

export interface PlatformKnowledgeManagerProps {
  readonly client?: ApiClient;
}

function isForbidden(error: unknown): boolean {
  return error instanceof ApiError && error.status === 403;
}

export function PlatformKnowledgeManager({
  client: injected,
}: PlatformKnowledgeManagerProps) {
  const client = useMemo(() => injected ?? createAuthedApiClient(), [injected]);
  const queryClient = useQueryClient();

  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState("");
  const [category, setCategory] = useState("");
  const [content, setContent] = useState("");

  const list = useQuery({
    queryKey: KEY,
    queryFn: async () => {
      const res = await client.get("/admin/knowledge");
      return (res as { data?: KnowledgeNode[] }).data ?? [];
    },
    retry: false,
  });

  const invalidate = () => queryClient.invalidateQueries({ queryKey: KEY });

  const createMut = useMutation({
    mutationFn: () =>
      client.post("/admin/knowledge", {
        // 運営デフォルトは既定でツリー非表示（RAG 横断参照のみ）。account_type/account_id は server 側で固定。
        body: {
          category,
          title,
          content_md: content,
          visible_in_tree: false,
          confidence_score: 0.5,
        },
      }),
    onSuccess: () => {
      setOpen(false);
      setTitle("");
      setCategory("");
      setContent("");
      void invalidate();
    },
  });

  const toggleMut = useMutation({
    mutationFn: (node: KnowledgeNode) =>
      client.patch("/admin/knowledge/{knowledge_id}", {
        params: { path: { knowledge_id: node.id } },
        body: { visible_in_tree: !(node.visible_in_tree ?? false) },
      }),
    // 楽観更新: visible_in_tree を即座に反転。失敗時は元に戻す。
    onMutate: async (node) => {
      await queryClient.cancelQueries({ queryKey: KEY });
      const prev = queryClient.getQueryData<KnowledgeNode[]>(KEY);
      queryClient.setQueryData<KnowledgeNode[]>(KEY, (old) =>
        (old ?? []).map((k) =>
          k.id === node.id
            ? { ...k, visible_in_tree: !(k.visible_in_tree ?? false) }
            : k,
        ),
      );
      return { prev };
    },
    onError: (_e, _node, ctx) => {
      if (ctx?.prev) queryClient.setQueryData(KEY, ctx.prev);
    },
    onSettled: () => void invalidate(),
  });

  if (isForbidden(list.error)) return <AdminDenied />;

  const rows = list.data ?? [];

  return (
    <section className="flex flex-col gap-md">
      <div className="rounded-lg border border-tertiary/40 bg-tertiary-container/30 p-md text-body-md text-on-surface">
        これは運営(プラットフォーム)層のナレッジです。account_type=
        <code>platform</code> / <code>visible_in_tree=false</code>{" "}
        で保存され、各テナントの AI 社員が 参照(読み取り)のみ可能です。
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
        <p className="text-body-md text-on-surface-variant">
          ナレッジがありません
        </p>
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
                  <td className="py-sm font-semibold text-on-surface">
                    {k.title}
                  </td>
                  <td className="py-sm text-label-md">{k.category}</td>
                  <td className="py-sm">
                    <button
                      type="button"
                      role="switch"
                      aria-checked={visible}
                      aria-label={`${k.title} のツリー表示を${visible ? "OFF" : "ON"}にする`}
                      disabled={toggleMut.isPending}
                      onClick={() => toggleMut.mutate(k)}
                      className={
                        "inline-flex h-5 w-10 items-center rounded-full px-0.5 transition-colors " +
                        (visible ? "bg-primary" : "bg-surface-variant")
                      }
                    >
                      <span
                        className={
                          "h-4 w-4 rounded-full bg-surface transition-transform " +
                          (visible ? "translate-x-5" : "translate-x-0")
                        }
                      />
                    </button>
                  </td>
                  <td className="py-sm text-label-md text-on-surface-variant">
                    {k.updated_at?.slice(0, 10) ?? "—"}
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
