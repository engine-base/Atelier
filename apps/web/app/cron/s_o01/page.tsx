/**
 * S-O01 自動スケジュール画面 — T-UC-25
 *
 * 実 cron-schedules API に配線。projectId は URL ?project=。
 */

"use client";

import * as React from "react";
import { Suspense } from "react";
import { useSearchParams } from "next/navigation";

import { QueryProvider } from "../../../providers/query-provider";
import { CronScheduleContainer } from "./_components/CronScheduleContainer";

function SO01Inner() {
  const params = useSearchParams();
  const projectId = params.get("project");

  return (
    <div className="mx-auto w-full max-w-5xl px-md py-lg">
      <h1 className="mb-md text-headline-md font-bold text-on-surface">
        自動スケジュール
      </h1>
      {projectId ? (
        <CronScheduleContainer projectId={projectId} />
      ) : (
        <p className="text-body-md text-on-surface-variant">
          プロジェクトを選択するとスケジュールを表示します。
        </p>
      )}
    </div>
  );
}

export default function SO01Page() {
  return (
    <QueryProvider>
      <Suspense
        fallback={
          <div className="p-lg text-body-md text-on-surface-variant">
            読み込み中…
          </div>
        }
      >
        <SO01Inner />
      </Suspense>
    </QueryProvider>
  );
}
