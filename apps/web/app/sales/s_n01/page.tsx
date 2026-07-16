/**
 * S-N01 商談ドラフト画面 — T-UC-24
 *
 * 実 sales-docs API に配線。projectId は URL ?project=。
 */

"use client";

import * as React from "react";
import { Suspense } from "react";
import { useSearchParams } from "next/navigation";

import { SalesDocDraftContainer } from "./_components/SalesDocDraftContainer";

function SN01Inner() {
  const params = useSearchParams();
  const projectId = params.get("project");

  return (
    <div className="mx-auto w-full max-w-[1200px] px-8 py-8">
      {projectId ? (
        <SalesDocDraftContainer projectId={projectId} />
      ) : (
        <p className="text-body-md text-on-surface-variant">
          プロジェクトを選択すると商談ドラフトを作成できます。
        </p>
      )}
    </div>
  );
}

export default function SN01Page() {
  return (
    <Suspense
      fallback={
        <div className="p-lg text-body-md text-on-surface-variant">
          読み込み中…
        </div>
      }
    >
      <SN01Inner />
    </Suspense>
  );
}
