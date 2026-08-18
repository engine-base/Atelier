/**
 * S-H01 モックビューア画面 — T-UC-13
 *
 * 実 mocks API に配線（署名付き閲覧 URL を iframe 表示）。mockId は URL ?mock=。
 * ?mock= 無しでは現在プロジェクトのモック一覧ピッカーを出す (到達不能是正)。
 */

"use client";

import * as React from "react";
import { Suspense } from "react";
import { useSearchParams } from "next/navigation";

import { QueryProvider } from "../../../providers/query-provider";
import { MockListContainer } from "./_components/MockListContainer";
import { MockViewerContainer } from "./_components/MockViewerContainer";

function SH01Inner() {
  const params = useSearchParams();
  const mockId = params.get("mock");

  // GAP-146: スタジオ (?mock=) はフルスクリーン overlay — 一覧のみ通常レイアウト
  if (mockId) return <MockViewerContainer mockId={mockId} />;
  return (
    <div className="mx-auto w-full max-w-[1200px] px-md py-lg">
      <MockListContainer />
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
