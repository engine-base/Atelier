/**
 * GAP-167 — AI が会話から拾った「ナレッジ候補」の採用 / 却下。
 *
 * 経営者指摘 (2026-08-19):
 *   「この形式とか、しかも全て溜めるのはノイズになるし、ちゃんとどれを入れるか
 *    などもできる状態になっているのか？？」
 *
 * → 全部は溜めません。候補として出し、**人が採用したものだけ**がナレッジになります。
 *   その場で題名・本文を直して採用もできます。却下したものは再提案しません。
 */

"use client";

import * as React from "react";
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Sparkles } from "lucide-react";

import type { ApiClient } from "@atelier/api-client";

import { cn } from "../../../../lib/cn";

export interface KnowledgeCandidateItem {
  readonly id: string;
  readonly title: string;
  readonly content_md: string;
  readonly category: string;
  readonly tags: readonly string[];
  readonly status: string;
}

export interface KnowledgeCandidatesProps {
  readonly client: ApiClient;
  /** 採用でナレッジが増えたとき (一覧の再取得用)。 */
  readonly onApproved?: () => void;
}

export function KnowledgeCandidates({ client, onApproved }: KnowledgeCandidatesProps) {
  const queryClient = useQueryClient();
  const KEY = ["knowledge-candidates"] as const;
  const [editing, setEditing] = useState<Record<string, { title: string; body: string }>>(
    {},
  );
  const [notice, setNotice] = useState<string | null>(null);

  const candidates = useQuery({
    queryKey: KEY,
    retry: false,
    queryFn: async () => {
      const res = await client.get("/knowledge/candidates", {
        params: { query: { status: "pending" } },
      });
      const d = (res as { data?: unknown }).data;
      if (!Array.isArray(d)) return [];
      // 想定外の応答 (候補の形をしていないもの) は出さない — ノイズにしない
      return (d as KnowledgeCandidateItem[]).filter(
        (c) => typeof c?.id === "string" && typeof c?.title === "string" && c?.status === "pending",
      );
    },
  });

  const approve = useMutation({
    retry: false,
    mutationFn: async (c: KnowledgeCandidateItem) => {
      const edit = editing[c.id];
      await client.post("/knowledge/candidates/{candidate_id}/approve", {
        params: { path: { candidate_id: c.id } },
        body: edit ? { title: edit.title, content_md: edit.body } : {},
      });
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: KEY });
      setNotice("ナレッジに追加しました。");
      onApproved?.();
    },
    onError: () => setNotice("採用に失敗しました。"),
  });

  const reject = useMutation({
    retry: false,
    mutationFn: (id: string) =>
      client.post("/knowledge/candidates/{candidate_id}/reject", {
        params: { path: { candidate_id: id } },
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: KEY });
      setNotice("却下しました。同じ内容は今後提案されません。");
    },
    onError: () => setNotice("却下に失敗しました。"),
  });

  const items = candidates.data ?? [];
  if (candidates.isLoading || items.length === 0) return null;

  return (
    <section
      aria-label="AI が会話から拾ったナレッジ候補"
      className="mb-md rounded-lg border border-secondary bg-secondary-container/30 p-md"
    >
      <h2 className="flex items-center gap-1.5 text-[13px] font-bold text-on-surface">
        <Sparkles className="h-3.5 w-3.5" aria-hidden="true" />
        AI が会話から拾った候補（{items.length}）
      </h2>
      <p className="mt-0.5 text-[11.5px] text-on-surface-variant">
        全部は溜めません。<strong>採用したものだけ</strong>がナレッジになります
        （その場で直して採用もできます）。却下したものは今後提案されません。
      </p>
      {notice ? (
        <p role="status" className="mt-1.5 text-[11.5px] text-on-surface">
          {notice}
        </p>
      ) : null}

      <ul role="list" className="mt-2 flex flex-col gap-2">
        {items.map((c) => {
          const edit = editing[c.id];
          return (
            <li key={c.id} className="rounded-md border border-border bg-white p-2.5">
              <input
                aria-label={`候補の題名: ${c.title}`}
                value={edit?.title ?? c.title}
                onChange={(e) =>
                  setEditing((prev) => ({
                    ...prev,
                    [c.id]: { title: e.target.value, body: prev[c.id]?.body ?? c.content_md },
                  }))
                }
                className="w-full rounded-sm border border-transparent bg-transparent px-1 py-0.5 text-[12.5px] font-bold text-on-surface hover:border-border focus-visible:border-primary focus-visible:outline-none"
              />
              <textarea
                aria-label={`候補の本文: ${c.title}`}
                value={edit?.body ?? c.content_md}
                rows={3}
                onChange={(e) =>
                  setEditing((prev) => ({
                    ...prev,
                    [c.id]: { title: prev[c.id]?.title ?? c.title, body: e.target.value },
                  }))
                }
                className="mt-1 w-full resize-y rounded-sm border border-transparent bg-transparent px-1 py-0.5 text-[11.5px] text-on-surface-variant hover:border-border focus-visible:border-primary focus-visible:outline-none"
              />
              <div className="mt-1.5 flex items-center gap-1.5">
                <span className="text-[10.5px] text-on-surface-variant">{c.category}</span>
                <button
                  type="button"
                  disabled={approve.isPending}
                  onClick={() => {
                    setNotice(null);
                    approve.mutate(c);
                  }}
                  className={cn(
                    "ml-auto rounded-md bg-primary px-3 py-1 text-[11.5px] font-semibold text-on-primary",
                    "hover:bg-primary-hover disabled:opacity-50",
                  )}
                >
                  {edit ? "編集して採用" : "採用"}
                </button>
                <button
                  type="button"
                  disabled={reject.isPending}
                  onClick={() => {
                    setNotice(null);
                    reject.mutate(c.id);
                  }}
                  className="rounded-md border border-border px-3 py-1 text-[11.5px] font-semibold text-on-surface-variant hover:bg-surface-variant hover:text-on-surface disabled:opacity-50"
                >
                  却下
                </button>
              </div>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
