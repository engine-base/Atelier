/**
 * S-F02 フェーズ管理画面 — T-UC-11
 *
 * 実 workflow API (GET/PATCH /workflow/phases) に配線。projectId は URL ?project=。
 */

"use client";

import * as React from "react";
import { Suspense } from "react";
import { useProjectId } from "../../../lib/useProjectId";

import { QueryProvider } from "../../../providers/query-provider";
import { PhaseListContainer } from "./_components/PhaseListContainer";

function SF02Inner() {
  const projectId = useProjectId();

  return (
    <div className="mx-auto w-full max-w-[1200px] px-md py-lg">
      <header className="mb-7">
        <p className="mb-2 text-[11px] font-bold uppercase tracking-[0.14em] text-on-surface-variant">
          Phase Management
        </p>
        <h1 className="text-3xl font-bold tracking-tight text-on-surface">
          フェーズ管理
        </h1>
        <p className="mt-2 text-body-md text-on-surface-variant">
          AI 提案を承認してフェーズを確定。タスク移動時は F-IMP01 が影響範囲を解析します。
        </p>
      </header>
      {projectId ? (
        <PhaseListContainer projectId={projectId} />
      ) : (
        <p className="text-body-md text-on-surface-variant">
          プロジェクトを選択すると工程を表示します。
        </p>
      )}
    </div>
  );
}

export default function SF02Page() {
  return (
    <QueryProvider>
      <Suspense
        fallback={
          <div className="p-lg text-body-md text-on-surface-variant">
            読み込み中…
          </div>
        }
      >
        <SF02Inner />
      </Suspense>
    </QueryProvider>
  );
}
