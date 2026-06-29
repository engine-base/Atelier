/**
 * NodeDetail — S-K01 右パネルのメタ情報 (T-UC-43)
 *
 * 選択中ノードの scope / カテゴリ / 参照回数 / 信頼度 / タグ を表示する。
 * モックの meta-pane に対応 (バックリンク・RAG 関連は別チケットのため最小)。
 */

"use client";

import * as React from "react";

import type { KnowledgeNode, KnowledgeScope } from "./types";

const SCOPE_LABEL: Record<KnowledgeScope, string> = {
  common: "共通",
  employee_specific: "AI社員別",
  project: "プロジェクト別",
};

export interface NodeDetailProps {
  readonly node: KnowledgeNode | null;
}

export function NodeDetail({ node }: NodeDetailProps) {
  if (!node) {
    return (
      <p className="text-body-md text-on-surface-variant">
        ノードを選択すると詳細が表示されます
      </p>
    );
  }

  const confidence = Math.round((node.confidence_score ?? 0) * 100);

  return (
    <div className="flex flex-col gap-lg">
      <section>
        <h3 className="mb-sm text-label-sm font-bold uppercase tracking-wide text-on-surface-variant">
          メタ情報
        </h3>
        <dl className="flex flex-col gap-xs text-body-sm">
          <div className="flex justify-between">
            <dt className="text-on-surface-variant">スコープ</dt>
            <dd className="font-semibold text-on-surface">
              {SCOPE_LABEL[node.scope]}
            </dd>
          </div>
          <div className="flex justify-between">
            <dt className="text-on-surface-variant">カテゴリ</dt>
            <dd className="text-on-surface">{node.category}</dd>
          </div>
          <div className="flex justify-between">
            <dt className="text-on-surface-variant">参照回数</dt>
            <dd className="font-bold tabular-nums text-on-surface">
              {node.usage_count ?? 0}
            </dd>
          </div>
        </dl>
      </section>

      <section>
        <h3 className="mb-sm text-label-sm font-bold uppercase tracking-wide text-on-surface-variant">
          信頼度（confidence）
        </h3>
        <p className="text-body-sm font-bold text-on-surface">
          {(confidence / 100).toFixed(2)}
        </p>
        <div className="mt-xs h-1.5 overflow-hidden rounded-full bg-surface-variant">
          <div
            className="h-full rounded-full bg-tertiary"
            style={{ width: `${confidence}%` }}
            aria-hidden="true"
          />
        </div>
      </section>

      {node.tags.length > 0 ? (
        <section>
          <h3 className="mb-sm text-label-sm font-bold uppercase tracking-wide text-on-surface-variant">
            タグ
          </h3>
          <ul className="flex flex-wrap gap-xs">
            {node.tags.map((tag) => (
              <li
                key={tag}
                className="rounded-full bg-primary-container px-sm py-px text-label-sm font-semibold text-primary-container-fg"
              >
                {tag}
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  );
}
