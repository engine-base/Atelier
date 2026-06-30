/**
 * S-F01 工程ワークフロー（司令塔）画面 — T-UC-10
 *
 * 実 workflow API (GET /workflow/phases) に配線。projectId は URL ?project=。
 */

"use client";

import * as React from "react";
import { Suspense } from "react";
import { useSearchParams } from "next/navigation";

import { QueryProvider } from "../../../providers/query-provider";
import { WorkflowGraphContainer } from "./_components/WorkflowGraphContainer";

function SF01Inner() {
  const params = useSearchParams();
  const projectId = params.get("project");

  return (
    <div className="mx-auto flex w-full max-w-6xl flex-col gap-lg px-md py-lg">
      <h1 className="text-headline-md font-bold text-on-surface">
        工程ワークフロー
      </h1>
      {projectId ? (
        <WorkflowGraphContainer projectId={projectId} />
      ) : (
        <p className="text-body-md text-on-surface-variant">
          プロジェクトを選択すると工程フローを表示します。
        </p>
      )}
    </div>
  );
}

export default function SF01Page() {
  return (
    <QueryProvider>
      <Suspense
        fallback={
          <div className="p-lg text-body-md text-on-surface-variant">
            読み込み中…
          </div>
        }
      >
        <SF01Inner />
      </Suspense>
    </QueryProvider>
  );
}
