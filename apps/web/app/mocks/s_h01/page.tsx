/**
 * S-H01 モックビューア画面 — T-UC-13
 *
 * 実 mocks API に配線（署名付き閲覧 URL を iframe 表示）。mockId は URL ?mock=。
 */

"use client";

import * as React from "react";
import { Suspense } from "react";
import { useSearchParams } from "next/navigation";

import { QueryProvider } from "../../../providers/query-provider";
import { MockViewerContainer } from "./_components/MockViewerContainer";

function SH01Inner() {
  const params = useSearchParams();
  const mockId = params.get("mock");

  return (
    <div className="mx-auto w-full max-w-[1200px] px-md py-lg">
      {mockId ? (
        <MockViewerContainer mockId={mockId} />
      ) : (
        <p className="rounded-lg border border-dashed border-border py-2xl text-center text-body-md text-on-surface-variant">
          モックを選択すると表示します。
        </p>
      )}
    </div>
  );
}

export default function SH01Page() {
  return (
    <QueryProvider>
      <Suspense
        fallback={
          <div className="p-lg text-body-md text-on-surface-variant">
            読み込み中…
          </div>
        }
      >
        <SH01Inner />
      </Suspense>
    </QueryProvider>
  );
}
