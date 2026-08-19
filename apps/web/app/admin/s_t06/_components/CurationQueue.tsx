/**
 * GAP-153 — ナレッジ自動キュレーション (運営承認キュー)。
 *
 * 経営者決定「運営として裏で AI を走らせて自動で分ける。セキュリティも担保」:
 *   - 「今すぐ走らせる」= POST /admin/knowledge/curation/run (運営 API キー費用)
 *   - pending 一覧: 匿名化済み提案 + 判定理由 + 出所 (運営監査用) を表示
 *   - 承認 → platform ナレッジとして全アカウント共有 / 却下 → 公開しない
 *   - rejected_security はリークスキャンの検出内容を honest に表示
 */

"use client";

import * as React from "react";
import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { ApiError, type ApiClient } from "@atelier/api-client";

import { createAuthedApiClient } from "../../../../lib/auth/connector";
import { cn } from "../../../../lib/cn";

interface ApiCuration {
  id: string;
  source_node_id: string;
  source_title?: string | null;
  source_workspace_name?: string | null;
  proposed_title: string;
  proposed_content_md: string;
  proposed_category: string;
  proposed_tags: string[];
  reason: string;
  security_notes?: string | null;
  status: string;
  created_at?: string;
}

interface ApiRunStats {
  scanned: number;
  proposed: number;
  skipped_not_useful: number;
  rejected_security: number;
}

export interface CurationQueueProps {
  readonly client?: ApiClient;
}

export function CurationQueue({ client: injected }: CurationQueueProps) {
  const client = useMemo(() => injected ?? createAuthedApiClient(), [injected]);
  const queryClient = useQueryClient();
  const [tab, setTab] = useState<"pending" | "rejected_security" | "approved">(
    "pending",
  );
  const [notice, setNotice] = useState<{
    kind: "ok" | "error";
    text: string;
  } | null>(null);

  const list = useQuery({
    queryKey: ["admin-curation", tab],
    queryFn: async () => {
      const res = await client.get("/admin/knowledge/curation", {
        params: { query: { status: tab } },
      });
      const d = (res as { data?: unknown }).data;
      return Array.isArray(d) ? (d as ApiCuration[]) : [];
    },
    retry: false,
  });

  const run = useMutation({
    retry: false,
    mutationFn: async () => {
      const res = await client.post("/admin/knowledge/curation/run", {
        body: { limit: 20 },
      });
      return (res as { data?: ApiRunStats }).data ?? null;
    },
    onSuccess: (stats) => {
      void queryClient.invalidateQueries({ queryKey: ["admin-curation"] });
      setNotice(
        stats
          ? {
              kind: "ok",
              text: `走査 ${stats.scanned} 件 → 提案 ${stats.proposed} / 対象外 ${stats.skipped_not_useful} / セキュリティ除外 ${stats.rejected_security}`,
            }
          : { kind: "ok", text: "実行しました。" },
      );
    },
    onError: (e) =>
      setNotice({
        kind: "error",
        text:
          e instanceof ApiError && e.status === 503
            ? "運営側の ANTHROPIC_API_KEY が未設定のため実行できません。"
            : "キュレーションの実行に失敗しました。",
      }),
  });

  const act = useMutation({
    retry: false,
    mutationFn: async (args: { id: string; action: "approve" | "reject" }) => {
      const path =
        args.action === "approve"
          ? "/admin/knowledge/curation/{curation_id}/approve"
          : "/admin/knowledge/curation/{curation_id}/reject";
      return client.post(path, { params: { path: { curation_id: args.id } } });
    },
    onSuccess: (_r, args) => {
      void queryClient.invalidateQueries({ queryKey: ["admin-curation"] });
      void queryClient.invalidateQueries({ queryKey: ["admin-knowledge"] });
      setNotice(
        args.action === "approve"
          ? {
              kind: "ok",
              text: "承認しました — platform ナレッジとして全アカウントに共有されます。",
            }
          : { kind: "ok", text: "却下しました (公開されません)。" },
      );
    },
    onError: (e) =>
      setNotice({
        kind: "error",
        text:
          e instanceof ApiError && e.status === 409
            ? e.message
            : "操作に失敗しました。",
      }),
  });

  const TABS = [
    { key: "pending", label: "承認待ち" },
    { key: "rejected_security", label: "セキュリティ除外" },
    { key: "approved", label: "公開済み" },
  ] as const;

  return (
    <section
      aria-label="ナレッジ自動キュレーション"
      className="mt-xl rounded-lg border border-border bg-surface p-md"
    >
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="text-title-md font-bold text-on-surface">
          自動キュレーション（全テナント横断）
        </h2>
        <button
          type="button"
          onClick={() => run.mutate()}
          disabled={run.isPending}
          className="ml-auto rounded-md bg-primary px-3 py-1.5 text-[12.5px] font-semibold text-on-primary hover:bg-primary-hover disabled:opacity-50"
        >
          {run.isPending ? "AI が走査中…" : "今すぐ走らせる"}
        </button>
      </div>
      <p className="mt-1 text-body-sm text-on-surface-variant">
        運営側で AI が全テナントの良質ナレッジを走査し、固有情報を除去 (匿名化)
        した提案を作ります。機械のリークスキャンを通過した提案だけがここに並び、
        <strong>承認して初めて</strong>全アカウント共有 (platform) になります。
        費用は運営の API キー (テナントのサブスクは使いません)。
      </p>

      {notice ? (
        <p
          role={notice.kind === "error" ? "alert" : "status"}
          className={cn(
            "mt-2 rounded-md px-sm py-1.5 text-[12px]",
            notice.kind === "error"
              ? "bg-error/10 text-error"
              : "bg-tertiary-container text-tertiary-container-fg",
          )}
        >
          {notice.text}
        </p>
      ) : null}

      <div role="tablist" aria-label="キュレーション状態" className="mt-3 flex gap-1">
        {TABS.map((t) => (
          <button
            key={t.key}
            type="button"
            role="tab"
            aria-selected={tab === t.key}
            onClick={() => setTab(t.key)}
            className={cn(
              "rounded-md px-3 py-1 text-[12px] font-semibold",
              tab === t.key
                ? "bg-primary text-on-primary"
                : "text-on-surface-variant hover:bg-surface-variant",
            )}
          >
            {t.label}
          </button>
        ))}
      </div>

      <div className="mt-2">
        {list.isLoading ? (
          <p className="py-md text-body-sm text-on-surface-variant">読み込み中…</p>
        ) : (list.data ?? []).length === 0 ? (
          <p className="py-md text-center text-body-sm text-on-surface-variant">
            {tab === "pending"
              ? "承認待ちの提案はありません。「今すぐ走らせる」で走査できます。"
              : "該当はありません。"}
          </p>
        ) : (
          <ul role="list" className="flex flex-col gap-2">
            {(list.data ?? []).map((c) => (
              <li
                key={c.id}
                className="rounded-md border border-border bg-surface-variant/30 p-3"
              >
                <div className="flex flex-wrap items-center gap-2">
                  <strong className="text-[13.5px] text-on-surface">
                    {c.proposed_title}
                  </strong>
                  <span className="rounded-sm bg-secondary-container px-1.5 py-0.5 text-[10.5px] font-semibold text-secondary-container-fg">
                    {c.proposed_category || "ノウハウ"}
                  </span>
                  <span className="ml-auto text-[11px] text-on-surface-variant">
                    出所: {c.source_workspace_name ?? "個人アカウント"} /「
                    {c.source_title ?? "-"}」
                  </span>
                </div>
                <p className="mt-1 text-[12px] text-on-surface-variant">
                  判定理由: {c.reason}
                </p>
                {c.security_notes ? (
                  <p
                    className={cn(
                      "mt-1 rounded-sm px-2 py-1 text-[11.5px]",
                      c.status === "rejected_security"
                        ? "bg-error/10 text-error"
                        : "bg-surface-variant text-on-surface-variant",
                    )}
                  >
                    {c.status === "rejected_security"
                      ? `リークスキャン: ${c.security_notes}`
                      : c.security_notes}
                  </p>
                ) : null}
                {c.proposed_content_md ? (
                  <details className="mt-1.5">
                    <summary className="cursor-pointer text-[11.5px] font-semibold text-primary">
                      匿名化済み本文を確認
                    </summary>
                    <pre className="mt-1 max-h-[280px] overflow-auto whitespace-pre-wrap rounded-md border border-border bg-surface p-2 text-[12px] leading-relaxed text-on-surface">
                      {c.proposed_content_md}
                    </pre>
                  </details>
                ) : null}
                {c.status === "pending" ? (
                  <div className="mt-2 flex justify-end gap-2">
                    <button
                      type="button"
                      onClick={() => act.mutate({ id: c.id, action: "reject" })}
                      disabled={act.isPending}
                      className="rounded-md px-3 py-1 text-[11.5px] font-semibold text-on-surface-variant hover:bg-surface-variant disabled:opacity-50"
                    >
                      却下
                    </button>
                    <button
                      type="button"
                      onClick={() => act.mutate({ id: c.id, action: "approve" })}
                      disabled={act.isPending}
                      className="rounded-md bg-primary px-3 py-1 text-[11.5px] font-semibold text-on-primary hover:bg-primary-hover disabled:opacity-50"
                    >
                      承認して全アカウント共有
                    </button>
                  </div>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}
