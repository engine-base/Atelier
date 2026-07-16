/**
 * NodeDetail — S-K01 右パネルのメタ情報 (T-UC-43)
 *
 * 選択中ノードの scope / カテゴリ / 参照回数 / 信頼度 / タグ を表示する。
 * モックの meta-pane に対応 (バックリンク・RAG 関連は別チケットのため最小)。
 */

"use client";

import * as React from "react";
import { ExternalLink, Sparkles } from "lucide-react";

import { KbButton } from "./ui";
import type { KnowledgeNode, KnowledgeScope } from "./types";

const SCOPE_LABEL: Record<KnowledgeScope, string> = {
  common: "共通",
  employee_specific: "AI社員別",
  project: "プロジェクト別",
};

/** confidence の定量値を定性ラベルに変換 (モック "高/中/低")。 */
function confidenceLabel(score: number): string {
  if (score >= 0.8) return "高 · 業界傾向に昇格候補";
  if (score >= 0.5) return "中";
  return "低";
}

export interface NodeDetailProps {
  readonly node: KnowledgeNode | null;
}

/** メタ・タイトル (uppercase の小見出し)。 */
function MetaTitle({ children }: { readonly children: React.ReactNode }) {
  return (
    <h3 className="mb-2 text-[11px] font-bold uppercase tracking-[0.06em] text-on-surface-variant">
      {children}
    </h3>
  );
}

export function NodeDetail({ node }: NodeDetailProps) {
  if (!node) {
    return (
      <p className="text-body-md text-on-surface-variant">
        ノードを選択すると詳細が表示されます
      </p>
    );
  }

  const score = node.confidence_score ?? 0;
  const confidence = Math.round(score * 100);

  return (
    <div className="flex flex-col gap-5">
      {/* メタ情報 */}
      <section>
        <MetaTitle>メタ情報</MetaTitle>
        <dl className="flex flex-col gap-2 text-[13px]">
          <div className="flex items-center justify-between gap-2">
            <dt className="text-on-surface-variant">スコープ</dt>
            <dd>
              <span className="inline-flex items-center rounded-sm bg-primary-container px-2 py-0.5 text-[10.5px] font-semibold text-primary-container-fg">
                {SCOPE_LABEL[node.scope]}
              </span>
            </dd>
          </div>
          {node.owner_employee_id ? (
            <div className="flex items-center justify-between gap-2">
              <dt className="text-on-surface-variant">オーナー</dt>
              <dd className="truncate font-semibold text-on-surface">
                {node.owner_employee_id}
              </dd>
            </div>
          ) : null}
          <div className="flex items-center justify-between gap-2">
            <dt className="text-on-surface-variant">カテゴリ</dt>
            <dd className="text-on-surface">{node.category}</dd>
          </div>
          <div className="flex items-center justify-between gap-2">
            <dt className="text-on-surface-variant">参照回数</dt>
            <dd className="font-bold tabular-nums text-on-surface">
              {node.usage_count ?? 0}
            </dd>
          </div>
        </dl>
      </section>

      {/* 信頼度 */}
      <section>
        <MetaTitle>信頼度（confidence）</MetaTitle>
        <div className="flex items-center gap-2">
          <strong className="text-[18px] font-bold tabular-nums text-tertiary">
            {score.toFixed(2)}
          </strong>
          <span className="text-[13px] text-on-surface-variant">
            {confidenceLabel(score)}
          </span>
        </div>
        <div className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-surface-variant">
          <div
            className="h-full rounded-full bg-tertiary"
            style={{ width: `${confidence}%` }}
            aria-hidden="true"
          />
        </div>
      </section>

      {/* タグ */}
      {node.tags.length > 0 ? (
        <section>
          <MetaTitle>タグ</MetaTitle>
          <ul className="flex flex-wrap gap-1.5">
            {node.tags.map((tag) => (
              <li
                key={tag}
                className="inline-flex items-center rounded-full bg-primary-container px-2.5 py-0.5 text-[11px] font-semibold text-primary-container-fg"
              >
                {tag}
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {/* アクション */}
      <section>
        <MetaTitle>アクション</MetaTitle>
        <div className="flex flex-col gap-2">
          <KbButton variant="outlined" size="sm" className="w-full">
            <Sparkles className="h-3.5 w-3.5" aria-hidden="true" />
            共通ナレッジに昇格
          </KbButton>
          <KbButton variant="ghost" size="sm" className="w-full">
            <ExternalLink className="h-3.5 w-3.5" aria-hidden="true" />
            Obsidian Vault に書出
          </KbButton>
        </div>
      </section>
    </div>
  );
}
