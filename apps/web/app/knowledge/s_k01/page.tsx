/**
 * S-K01 ナレッジエクスプローラ — T-UC-18
 *
 * workspaceId は URL ?workspace= を最優先し、無ければ WS 切替 (T-UC-38) が
 * localStorage (atelier_current_workspace) に永続化した現在 WS を使う。
 * 以前は KnowledgeExplorer へ workspaceId を渡しておらず、恒久的に
 * zero-UUID フォールバックで照会して常に空表示になる実バグがあった。
 */

"use client";

import * as React from "react";
import { Suspense } from "react";
import { useSearchParams } from "next/navigation";

import { QueryProvider } from "../../../providers/query-provider";
import { KnowledgeExplorer } from "./_components/KnowledgeExplorer";

/** T-UC-38 WorkspaceSwitcher と共有する現在 WS の localStorage キー。 */
const CURRENT_WS_KEY = "atelier_current_workspace";

function storedWorkspaceId(): string | undefined {
  if (typeof window === "undefined") return undefined;
  return window.localStorage.getItem(CURRENT_WS_KEY) ?? undefined;
}

function SK01Inner() {
  const params = useSearchParams();
  const workspaceId = params.get("workspace") ?? storedWorkspaceId();

  return workspaceId ? (
    <KnowledgeExplorer workspaceId={workspaceId} />
  ) : (
    <p className="text-body-md text-on-surface-variant">
      ワークスペースを選択するとナレッジを表示します（?workspace= または
      ワークスペース切替から選択）。
    </p>
  );
}

export default function SK01Page() {
  return (
    <div className="min-h-dvh bg-surface px-md py-lg">
      <h1 className="mb-md text-headline-md font-bold text-on-surface">
        ナレッジエクスプローラ
      </h1>
      <QueryProvider>
        <Suspense
          fallback={
            <p className="text-body-md text-on-surface-variant">読み込み中…</p>
          }
        >
          <SK01Inner />
        </Suspense>
      </QueryProvider>
    </div>
  );
}
