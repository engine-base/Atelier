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
 * SKILL.md 取込 (GAP-031⑦): .md ファイルを選択 → YAML frontmatter
 * (name / description) を解析して追加ダイアログへプレフィル → 人間が確認して
 * 実 POST /admin/knowledge で登録する (パース結果を無確認で書き込まない)。
 *
 * admin gate: API が 403 を返したら AdminDenied を表示する。
 * api client は prop 注入可能 (テスト時に fake を渡せる)。
 */

"use client";

import * as React from "react";
import { Loading } from "../../../../components/Loading";
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

/**
 * SKILL.md の YAML frontmatter (--- ... ---) を素朴に解析する (GAP-031⑦)。
 * API 側 services/skills.parse_skill_md と同じ最小仕様 (同一行 key: value のみ)。
 */
export function parseSkillMd(raw: string): {
  meta: Record<string, string>;
  body: string;
} {
  if (!raw.startsWith("---")) return { meta: {}, body: raw };
  const lines = raw.split("\n");
  const end = lines.findIndex((l, i) => i > 0 && l.trim() === "---");
  if (end < 0) return { meta: {}, body: raw };
  const meta: Record<string, string> = {};
  for (const line of lines.slice(1, end)) {
    if (!line.includes(":") || /^[\s#]/.test(line)) continue;
    const idx = line.indexOf(":");
    meta[line.slice(0, idx).trim()] = line
      .slice(idx + 1)
      .trim()
      .replace(/^['"]|['"]$/g, "");
  }
  return { meta, body: lines.slice(end + 1).join("\n").replace(/^\n+/, "") };
}

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
  // GAP-031⑦: SKILL.md 取込 (file input → frontmatter 解析 → ダイアログにプレフィル)
  const fileRef = React.useRef<HTMLInputElement | null>(null);
  const [importNote, setImportNote] = useState<string | null>(null);
  const onSkillMdFile = async (file: File): Promise<void> => {
    const raw = await file.text();
    const { meta, body } = parseSkillMd(raw);
    setTitle(meta.name ?? file.name.replace(/\.md$/i, ""));
    setCategory("skill");
    setContent(body || raw);
    setImportNote(
      meta.name
        ? `SKILL.md「${meta.name}」を解析しました${meta.description ? ` — ${meta.description}` : ""}。内容を確認して追加してください。`
        : `${file.name} を読み込みました (frontmatter 無し — 全文を本文に設定)。内容を確認して追加してください。`,
    );
    setOpen(true);
  };

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
      setImportNote(null);
      void invalidate();
    },
  });

  const [confirming, setConfirming] = React.useState<string | null>(null);
  const deleteMut = useMutation({
    mutationFn: (id: string) =>
      client.delete("/admin/knowledge/{knowledge_id}", {
        params: { path: { knowledge_id: id } },
      }),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: KEY }),
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
    <section className="flex flex-col gap-6">
      {/* ページヘッダー: eyebrow + タイトル + サブタイトル + アクション */}
      <div className="flex items-start justify-between gap-4">
        <div>
          <p className="text-[11px] font-bold uppercase tracking-[0.14em] text-on-surface-variant">
            Platform Knowledge
          </p>
          <h1 className="mt-1 text-3xl font-bold tracking-tight text-on-surface">
            運営デフォルト・ナレッジ
          </h1>
          <p className="mt-2 max-w-2xl text-body-md text-on-surface-variant">
            全テナント横断で AI 社員が参照するデフォルトナレッジ。テナント側のナレッジツリーには表示されず、RAG
            検索でのみ参照されます。
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <input
            ref={fileRef}
            type="file"
            accept=".md,text/markdown"
            className="hidden"
            aria-label="SKILL.md ファイルを選択"
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) void onSkillMdFile(f);
              e.target.value = "";
            }}
          />
          <AdminButton
            variant="outlined"
            onClick={() => fileRef.current?.click()}
          >
            SKILL.md 取込
          </AdminButton>
          <AdminButton variant="primary" onClick={() => setOpen(true)}>
            新規追加
          </AdminButton>
        </div>
      </div>

      {/* 運営層ナレッジの注意書き (left-border notice) */}
      <div className="flex items-start gap-2.5 rounded-lg border border-tertiary/40 border-l-[3px] border-l-tertiary bg-tertiary-container/30 p-4 text-body-md text-on-surface">
        <div>
          <strong className="font-bold">
            これは運営(プラットフォーム)層のナレッジです。
          </strong>{" "}
          account_type=<code>platform</code> /{" "}
          <code>visible_in_tree=false</code> で保存され、各テナントの AI 社員が{" "}
          <strong className="font-bold">参照(読み取り)のみ</strong>
          可能。テナント側からは編集・削除できず、ツリーにも出ません。書込は運営(service_role)のみ。
        </div>
      </div>

      {/* ナレッジ一覧テーブル */}
      {list.isLoading ? (
        <Loading className="py-md" />
      ) : rows.length === 0 ? (
        <p className="py-12 text-center text-body-md text-on-surface-variant">
          ナレッジがありません
        </p>
      ) : (
        <div className="overflow-hidden rounded-lg border border-border bg-white">
          <table className="w-full border-collapse">
            <caption className="sr-only">運営デフォルト・ナレッジ一覧</caption>
            <thead>
              <tr className="border-b border-border bg-surface-variant text-left text-[11px] font-bold uppercase tracking-wider text-on-surface-variant">
                <th className="px-3.5 py-3 font-bold">タイトル</th>
                <th className="px-3.5 py-3 font-bold">カテゴリ</th>
                <th className="px-3.5 py-3 font-bold">参照テナント</th>
                <th className="px-3.5 py-3 font-bold">ツリー表示</th>
                <th className="px-3.5 py-3 font-bold">更新日</th>
                <th className="px-3.5 py-3 text-right font-bold">操作</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((k) => {
                const visible = k.visible_in_tree ?? false;
                return (
                  <tr
                    key={k.id}
                    className="border-b border-border last:border-b-0 transition-colors hover:bg-surface-variant/50"
                  >
                    <td className="px-3.5 py-3.5 font-semibold text-on-surface">
                      {k.title}
                    </td>
                    <td className="px-3.5 py-3.5">
                      <span className="inline-block rounded-full bg-primary-container px-2 py-0.5 text-[11px] font-semibold text-on-primary-container">
                        {k.category}
                      </span>
                    </td>
                    <td className="px-3.5 py-3.5 text-body-sm text-on-surface-variant">
                      全テナント
                    </td>
                    <td className="px-3.5 py-3.5">
                      <div className="flex items-center gap-2">
                        <button
                          type="button"
                          role="switch"
                          aria-checked={visible}
                          aria-label={`${k.title} のツリー表示を${visible ? "OFF" : "ON"}にする`}
                          disabled={toggleMut.isPending}
                          onClick={() => toggleMut.mutate(k)}
                          className={
                            "inline-flex h-5 w-10 shrink-0 items-center rounded-full px-0.5 transition-colors " +
                            (visible ? "bg-primary" : "bg-surface-variant")
                          }
                        >
                          <span
                            className={
                              "h-4 w-4 rounded-full bg-white shadow-sm transition-transform " +
                              (visible ? "translate-x-5" : "translate-x-0")
                            }
                          />
                        </button>
                        <span className="text-[11px] text-on-surface-variant">
                          {visible ? "表示" : "非表示（参照のみ）"}
                        </span>
                      </div>
                    </td>
                    <td className="px-3.5 py-3.5 text-body-sm text-on-surface-variant">
                      {k.updated_at?.slice(0, 10) ?? "—"}
                    </td>
                    <td className="whitespace-nowrap px-3.5 py-3.5 text-right">
                      {confirming === k.id ? (
                        <span className="inline-flex items-center gap-1">
                          <button
                            type="button"
                            onClick={() => {
                              setConfirming(null);
                              deleteMut.mutate(k.id);
                            }}
                            className="rounded-sm px-2 py-1 text-[12px] font-semibold text-error hover:bg-surface-variant"
                          >
                            削除する
                          </button>
                          <button
                            type="button"
                            onClick={() => setConfirming(null)}
                            className="rounded-sm px-2 py-1 text-[12px] text-on-surface-variant hover:bg-surface-variant"
                          >
                            取消
                          </button>
                        </span>
                      ) : (
                        <button
                          type="button"
                          aria-label={`${k.title} を削除`}
                          onClick={() => setConfirming(k.id)}
                          className="rounded-sm px-2 py-1 text-[12px] font-semibold text-error hover:bg-surface-variant"
                        >
                          削除
                        </button>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {/* 補足: ツリー表示トグルの挙動 */}
      <p className="text-body-sm text-on-surface-variant">
        「ツリー表示」を ON
        にすると、テナント側のナレッジツリーにも表示されます（既定は非表示・参照のみ）。
      </p>

      <Dialog
        open={open}
        onClose={() => {
          setOpen(false);
          setImportNote(null);
        }}
        title="運営デフォルト・ナレッジを追加"
        className="max-w-2xl"
        footer={
          <>
            <AdminButton
              variant="ghost"
              onClick={() => {
                setOpen(false);
                setImportNote(null);
              }}
            >
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
          {importNote ? (
            <p
              role="status"
              className="rounded-md border-l-[3px] border-tertiary bg-tertiary-container/40 px-3 py-2 text-body-sm text-on-surface"
            >
              {importNote}
            </p>
          ) : null}
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
