/**
 * S-F02 フェーズ管理画面 — T-UC-11
 *
 * 実 workflow API (GET/PATCH /workflow/phases) に配線。projectId は URL ?project=。
 */

"use client";

import * as React from "react";
import { Suspense } from "react";
import { useSearchParams } from "next/navigation";

import { QueryProvider } from "../../../providers/query-provider";
import { PhaseListContainer } from "./_components/PhaseListContainer";

function SF02Inner() {
  const params = useSearchParams();
  const projectId = params.get("project");

  return (
    <div className="mx-auto flex w-full max-w-5xl flex-col gap-lg px-md py-lg">
      <h1 className="text-headline-md font-bold text-on-surface">
        フェーズ管理
      </h1>
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
