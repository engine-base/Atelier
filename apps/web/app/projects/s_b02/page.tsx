/**
 * S-B02 プロジェクトダッシュボード — T-UC-04
 *
 * 実 projects API (GET /projects/{id}/dashboard) に配線。projectId は URL ?project=。
 */

"use client";

import * as React from "react";
import { Suspense } from "react";
import { useSearchParams } from "next/navigation";

import { QueryProvider } from "../../../providers/query-provider";
import { ProjectDashboardContainer } from "./_components/ProjectDashboardContainer";

function SB02Inner() {
  const params = useSearchParams();
  const projectId = params.get("project");

  return (
    <div className="mx-auto w-full max-w-[1200px] px-md py-lg">
      {projectId ? (
        <ProjectDashboardContainer projectId={projectId} />
      ) : (
        <p className="text-body-md text-on-surface-variant">
          プロジェクトを選択するとダッシュボードを表示します。
        </p>
      )}
    </div>
  );
}

export default function SB02Page() {
  return (
    <QueryProvider>
      <Suspense
        fallback={
          <div className="p-lg text-body-md text-on-surface-variant">
            読み込み中…
          </div>
        }
      >
        <SB02Inner />
      </Suspense>
    </QueryProvider>
  );
}
