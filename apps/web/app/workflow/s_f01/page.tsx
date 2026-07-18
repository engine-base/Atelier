/**
 * S-F01 工程ワークフロー（司令塔）画面 — T-UC-10
 *
 * モック 06_mockups/workflow/S-F01-flow.html 準拠のフルブリード構成:
 * 上部フローバー + 工程ヘッダー + タブ/右レール。projectId は URL ?project=
 * (無ければ localStorage の最後に開いたプロジェクト)。
 */

"use client";

import * as React from "react";
import { Suspense } from "react";
import { useProjectId } from "../../../lib/useProjectId";

import { QueryProvider } from "../../../providers/query-provider";
import { WorkflowGraphContainer } from "./_components/WorkflowGraphContainer";

function SF01Inner() {
  const projectId = useProjectId();

  return (
    <div className="flex w-full flex-col">
      <h1 className="sr-only">工程ワークフロー</h1>
      {projectId ? (
        <WorkflowGraphContainer projectId={projectId} />
      ) : (
        <p className="px-md py-lg text-body-md text-on-surface-variant sm:px-[32px]">
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
