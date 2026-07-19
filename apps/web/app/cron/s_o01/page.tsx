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
import { useProjectId } from "../../../lib/useProjectId";
import { CronScheduleContainer } from "./_components/CronScheduleContainer";
import { ScheduleRoleCard } from "./_components/ScheduleRoleCard";
import { ScheduleBuilderContainer } from "./_components/ScheduleBuilderContainer";

function SO01Inner() {
  const params = useSearchParams();
  // ?project= 優先、無ければ現在プロジェクト (localStorage) — 初回訪問の行き止まり防止
  const stored = useProjectId();
  const projectId = params.get("project") ?? stored;

  return (
    <div className="mx-auto w-full max-w-[1200px] px-md py-lg">
      <ScheduleRoleCard />
      {projectId ? (
        <div className="grid grid-cols-1 items-start gap-5 lg:grid-cols-[1fr_380px]">
          <div>
            <CronScheduleContainer projectId={projectId} />
          </div>
          <ScheduleBuilderContainer projectId={projectId} />
        </div>
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
