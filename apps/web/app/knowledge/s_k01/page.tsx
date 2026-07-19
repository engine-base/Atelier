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
import { Suspense, useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";

import { getJson } from "../../../lib/auth/connector";
import { readCurrentWorkspace } from "../../../lib/currentWorkspace";
import { QueryProvider } from "../../../providers/query-provider";
import { KnowledgeExplorer } from "./_components/KnowledgeExplorer";

function SK01Inner() {
  const params = useSearchParams();
  const explicit = params.get("workspace") ?? readCurrentWorkspace();
  // 未選択でも所属 WS の先頭に自動フォールバックする (シェルの現在 WS 解決と同じ)。
  // 以前は選択が無いと恒久的に空表示で、初回訪問者が必ず行き止まりになっていた。
  const [fallback, setFallback] = useState<string | undefined>();
  const [checked, setChecked] = useState(false);
  useEffect(() => {
    if (explicit) return;
    let cancelled = false;
    getJson<readonly { id: string }[]>("/workspaces")
      .then((res) => {
        if (!cancelled) setFallback(res.data[0]?.id);
      })
      .catch(() => {})
      .finally(() => {
        if (!cancelled) setChecked(true);
      });
    return () => {
      cancelled = true;
    };
  }, [explicit]);

  const workspaceId = explicit ?? fallback;
  if (workspaceId) return <KnowledgeExplorer workspaceId={workspaceId} />;
  return (
    <p className="text-body-md text-on-surface-variant">
      {explicit === undefined && !checked
        ? "読み込み中…"
        : "所属ワークスペースがありません。まずワークスペースを作成してください。"}
    </p>
  );
}

export default function SK01Page() {
  return (
    <div className="mx-auto flex w-full max-w-[1400px] flex-col gap-md">
      <h1 className="text-headline-md font-bold text-on-surface">
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
