/**
 * S-G01 成果物ビューア画面 — T-UC-12
 *
 * 実 outputs / comments API に配線（署名付き閲覧 URL を iframe 表示）。
 * outputId は URL ?output=。
 */

"use client";

import * as React from "react";
import { Suspense } from "react";
import { useSearchParams } from "next/navigation";

import { QueryProvider } from "../../../providers/query-provider";
import { OutputPicker } from "./_components/OutputPicker";
import { OutputViewerContainer } from "./_components/OutputViewerContainer";

function SG01Inner() {
  const params = useSearchParams();
  const outputId = params.get("output");

  return (
    <div className="mx-auto w-full max-w-[1200px] px-md py-lg">
      {outputId ? (
        <OutputViewerContainer outputId={outputId} />
      ) : (
        // GAP-302 (通し J46-19): 成果物を選ぶ一覧が無く、0 件のときも案内が出なかった
        <OutputPicker />
      )}
    </div>
  );
}

export default function SG01Page() {
  return (
    <QueryProvider>
      <Suspense
        fallback={
          <div className="p-lg text-body-md text-on-surface-variant">
            読み込み中…
          </div>
        }
      >
        <SG01Inner />
      </Suspense>
    </QueryProvider>
  );
}
