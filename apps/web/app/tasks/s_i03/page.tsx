/**
 * S-I03 実行モニター画面 — T-UC-16
 *
 * 実 exec-logs SSE (GET /executions/{id}/logs/stream) に配線。executionId は URL ?execution=。
 */

"use client";

import * as React from "react";
import { Suspense } from "react";
import { useSearchParams } from "next/navigation";

import { ExecutionMonitorContainer } from "./_components/ExecutionMonitorContainer";

function SI03Inner() {
  const params = useSearchParams();
  const executionId = params.get("execution");

  return (
    <div className="mx-auto flex w-full max-w-6xl flex-col gap-lg px-md py-lg">
      <h1 className="text-headline-md font-bold text-on-surface">
        実行モニター
      </h1>
      {executionId ? (
        <ExecutionMonitorContainer executionId={executionId} />
      ) : (
        <p className="text-body-md text-on-surface-variant">
          実行を選択するとログをリアルタイム表示します。
        </p>
      )}
    </div>
  );
}

export default function SI03Page() {
  return (
    <Suspense
      fallback={
        <div className="p-lg text-body-md text-on-surface-variant">
          読み込み中…
        </div>
      }
    >
      <SI03Inner />
    </Suspense>
  );
}
