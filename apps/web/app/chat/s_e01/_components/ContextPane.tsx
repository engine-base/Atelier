/**
 * S-E01 右コンテキストペイン — モック .context-pane 準拠
 *
 * タブ: 主力決定 (実 /decisions) / コンテキスト (実データの F-CTX01 層) / 参照 (実 /knowledge)。
 * モックにある mem0 / 言及エンティティ等、実 API が値を返さない層は表示しない (偽装しない)。
 */

"use client";

import * as React from "react";
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Brain, Check, LayoutDashboard, Link2, Zap } from "lucide-react";

import * as api from "../../../../lib/auth/connector";
import { cn } from "../../../../lib/cn";
import { fmtTime } from "../../../../lib/format";

interface DecisionLite {
  readonly id: string;
  readonly status: string;
  readonly body: string;
  readonly reflected_to?: string | null;
  readonly created_at?: string;
  readonly phase_id?: string | null;
}

interface KnowledgeLite {
  readonly id: string;
  readonly title?: string;
  readonly category?: string | null;
  readonly content?: string | null;
}

export interface ContextPaneProps {
  readonly projectId?: string | null;
  readonly phaseId?: string | null;
  readonly phaseLabel?: string;
  readonly phaseIndex?: number;
  readonly phaseTotal?: number;
  readonly threadTitle?: string | null;
  readonly messageCount: number;
  /** SSE context chunk の実測値 (F-CTX01)。null = まだ応答していない。 */
  readonly ctxHistoryCount?: number | null;
  readonly ctxRagHitCount?: number | null;
}

type CtxTab = "decisions" | "context" | "refs";

export function ContextPane({
  projectId,
  phaseId,
  phaseLabel,
  phaseIndex,
  phaseTotal,
  threadTitle,
  messageCount,
  ctxHistoryCount,
  ctxRagHitCount,
}: ContextPaneProps) {
  const [tab, setTab] = useState<CtxTab>("decisions");

  const decisionsQuery = useQuery({
    queryKey: ["ctx-decisions", projectId ?? "none"],
    enabled: !!projectId,
    queryFn: async () =>
      (
        await api.getJson<DecisionLite[]>(
          `/decisions?project_id=${projectId}&status=decided`,
        )
      ).data,
    retry: false,
  });
  const knowledgeQuery = useQuery({
    queryKey: ["ctx-knowledge", projectId ?? "none"],
    enabled: !!projectId,
    queryFn: async () =>
      (
        await api.getJson<KnowledgeLite[]>(
          `/knowledge?source_project_id=${projectId}`,
        )
      ).data,
    retry: false,
  });

  const allDecisions = decisionsQuery.data ?? [];
  // スレッドの工程の決定を優先表示、無ければプロジェクト全体
  const decisions = phaseId
    ? allDecisions.filter((d) => !d.phase_id || d.phase_id === phaseId)
    : allDecisions;
  const knowledge = knowledgeQuery.data ?? [];

  const tabs: readonly {
    key: CtxTab;
    label: string;
    icon: React.ReactNode;
    count?: number;
  }[] = [
    { key: "decisions", label: "主力決定", icon: <Zap size={11} aria-hidden="true" />, count: decisions.length },
    { key: "context", label: "コンテキスト", icon: <Brain size={11} aria-hidden="true" /> },
    { key: "refs", label: "参照", icon: <Link2 size={11} aria-hidden="true" />, count: knowledge.length },
  ];

  const layerRows: readonly { name: string; value: string }[] = [
    { name: "直近メッセージ", value: `${messageCount} 件` },
    { name: "プロジェクト状態（DB）", value: "最新" },
    ...(typeof ctxHistoryCount === "number"
      ? [{ name: "セマンティック関連メッセージ", value: `${ctxHistoryCount} 件` }]
      : []),
    ...(typeof ctxRagHitCount === "number"
      ? [{ name: "RAG ナレッジ", value: `${ctxRagHitCount} 件` }]
      : [{ name: "RAG ナレッジ候補", value: `${knowledge.length} 件` }]),
  ];

  return (
    <aside
      aria-label="コンテキストパネル"
      className="flex h-full min-h-0 flex-col overflow-hidden bg-white"
    >
      <div role="tablist" aria-label="コンテキスト" className="flex shrink-0 gap-[2px] border-b border-border px-3 py-[10px]">
        {tabs.map((t) => {
          const active = tab === t.key;
          return (
            <button
              key={t.key}
              type="button"
              role="tab"
              aria-selected={active}
              onClick={() => setTab(t.key)}
              className={cn(
                "flex flex-1 items-center justify-center gap-[5px] rounded-sm px-2 py-[6px] text-[11.5px] font-semibold",
                active
                  ? "bg-primary-container text-on-primary-container"
                  : "text-on-surface-variant hover:text-on-surface",
              )}
            >
              {t.icon}
              {t.label}
              {typeof t.count === "number" ? (
                <span
                  className={cn(
                    "rounded-full px-[5px] py-[1px] text-[9.5px] tabular-nums",
                    active ? "bg-white/50" : "bg-black/[0.08]",
                  )}
                >
                  {t.count}
                </span>
              ) : null}
            </button>
          );
        })}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-[14px]">
        {/* ─── 主力決定 ─── */}
        {tab === "decisions" ? (
          <>
            <div className="mb-[22px]">
              <div className="mb-2 flex items-center gap-[6px] text-[10.5px] font-bold uppercase tracking-[0.1em] text-on-surface-variant">
                この会話で確定したこと
                <span className="ml-auto rounded-full bg-surface-variant px-[7px] py-[1px] text-[10px] tabular-nums">
                  {decisions.length}
                </span>
              </div>
              {decisions.length === 0 ? (
                <p className="text-[12px] leading-[1.6] text-on-surface-variant">
                  確定事項はまだありません。AI 社員との議論で決まった事項が
                  ここにピン留めされます。
                </p>
              ) : (
                decisions.slice(0, 8).map((d) => (
                  <div
                    key={d.id}
                    className="mb-[6px] rounded-md border border-secondary bg-gradient-to-br from-secondary-container to-white px-3 py-[10px]"
                  >
                    <div className="mb-1 flex items-center gap-1 text-[9.5px] font-bold uppercase tracking-[0.08em] text-secondary">
                      <Check size={10} aria-hidden="true" />
                      確定{d.created_at ? ` · ${fmtTime(d.created_at)}` : ""}
                    </div>
                    <div className="text-[12.5px] font-semibold leading-[1.5] text-on-surface">
                      {d.body}
                    </div>
                    {d.reflected_to ? (
                      <div className="mt-1 text-[10.5px] leading-[1.4] tabular-nums text-on-surface-variant">
                        → {d.reflected_to}
                      </div>
                    ) : null}
                  </div>
                ))
              )}
            </div>

            {phaseLabel ? (
              <div className="mb-[22px]">
                <div className="mb-2 text-[10.5px] font-bold uppercase tracking-[0.1em] text-on-surface-variant">
                  現在のトピック
                </div>
                <div className="rounded-md border border-primary bg-primary-container px-3 py-[10px]">
                  <div className="mb-1 flex items-center gap-1 text-[9.5px] font-bold uppercase tracking-[0.08em] text-on-primary-container">
                    <LayoutDashboard size={10} aria-hidden="true" />
                    {phaseLabel} 工程
                  </div>
                  <div className="text-[12.5px] font-semibold leading-[1.5] text-on-surface">
                    {threadTitle ?? "スレッド未選択"}
                  </div>
                  {typeof phaseIndex === "number" && phaseTotal ? (
                    <div className="mt-1 text-[10.5px] tabular-nums text-on-surface-variant">
                      工程 {phaseIndex + 1} / {phaseTotal}
                    </div>
                  ) : null}
                </div>
              </div>
            ) : null}
          </>
        ) : null}

        {/* ─── コンテキスト (F-CTX01) ─── */}
        {tab === "context" ? (
          <div className="mb-[22px]">
            <div className="mb-2 text-[10.5px] font-bold uppercase tracking-[0.1em] text-on-surface-variant">
              F-CTX01 コンテキスト構築
            </div>
            {layerRows.map((row, i) => (
              <div
                key={row.name}
                className="flex items-center gap-2 border-b border-border py-[6px] text-[11.5px] last:border-b-0"
              >
                <span className="flex h-[18px] w-[18px] shrink-0 items-center justify-center rounded-full bg-primary-container text-[10px] font-bold text-on-primary-container">
                  {i + 1}
                </span>
                <span className="flex-1 text-on-surface">{row.name}</span>
                <span className="text-[10.5px] tabular-nums text-on-surface-variant">
                  {row.value}
                </span>
              </div>
            ))}
            <p className="mt-3 text-[11px] leading-[1.6] text-on-surface-variant">
              送信時に F-CTX01 が履歴・プロジェクト状態・関連ナレッジを合成して
              AI 社員に渡します。実測値は応答ごとに更新されます。
            </p>
          </div>
        ) : null}

        {/* ─── 参照 ─── */}
        {tab === "refs" ? (
          <div className="mb-[22px]">
            <div className="mb-2 flex items-center gap-[6px] text-[10.5px] font-bold uppercase tracking-[0.1em] text-on-surface-variant">
              参照ソース
              <span className="ml-auto rounded-full bg-surface-variant px-[7px] py-[1px] text-[10px] tabular-nums">
                {knowledge.length}
              </span>
            </div>
            {knowledge.length === 0 ? (
              <p className="text-[12px] leading-[1.6] text-on-surface-variant">
                このプロジェクトから昇格したナレッジはまだありません。
              </p>
            ) : (
              knowledge.slice(0, 10).map((k) => (
                <div
                  key={k.id}
                  className="mb-1 rounded-sm bg-surface-variant px-[10px] py-2 text-[11.5px] transition-colors hover:bg-primary-container"
                >
                  <div className="flex items-center gap-1 font-semibold text-primary">
                    <Brain size={11} aria-hidden="true" />
                    {k.title ?? "ナレッジ"}
                  </div>
                  {k.content ? (
                    <div className="mt-[3px] line-clamp-2 text-[11px] leading-[1.5] text-on-surface-variant">
                      {k.content}
                    </div>
                  ) : null}
                </div>
              ))
            )}
          </div>
        ) : null}
      </div>
    </aside>
  );
}
