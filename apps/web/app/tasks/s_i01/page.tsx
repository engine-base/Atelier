"use client";

import * as React from "react";
import { Suspense } from "react";
import { useSearchParams } from "next/navigation";

import { QueryProvider } from "../../../providers/query-provider";
import { TaskBoardContainer } from "./_components/TaskBoardContainer";

function SI01Inner() {
  const params = useSearchParams();
  const projectId = params.get("project");

  return (
    <div className="mx-auto flex w-full max-w-7xl flex-col gap-lg px-md py-lg">
      <h1 className="text-headline-md font-bold text-on-surface">
        タスクボード
      </h1>
      {projectId ? (
        <TaskBoardContainer projectId={projectId} />
      ) : (
        <p className="text-body-md text-on-surface-variant">
          プロジェクトを選択するとタスクボードを表示します。
        </p>
      )}
    </div>
  );
}

export default function SI01Page() {
  return (
    <QueryProvider>
      <Suspense
        fallback={
          <div className="p-lg text-body-md text-on-surface-variant">
            読み込み中…
          </div>
        }
      >
        <SI01Inner />
      </Suspense>
    </QueryProvider>
  );
}
