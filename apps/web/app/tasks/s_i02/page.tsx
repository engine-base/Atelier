/**
 * S-I02 タスク詳細画面 — T-UC-15
 *
 * 実 tasks/comments API に配線。taskId は URL ?task=。
 */

"use client";

import * as React from "react";
import { Suspense } from "react";
import { useSearchParams } from "next/navigation";

import { QueryProvider } from "../../../providers/query-provider";
import { TaskDetailContainer } from "./_components/TaskDetailContainer";

function SI02Inner() {
  const params = useSearchParams();
  const taskId = params.get("task");

  return (
    <div className="mx-auto w-full max-w-[1200px] px-md py-lg">
      {taskId ? (
        <TaskDetailContainer taskId={taskId} />
      ) : (
        <p className="text-body-md text-on-surface-variant">
          タスクを選択すると詳細を表示します。
        </p>
      )}
    </div>
  );
}

export default function SI02Page() {
  return (
    <QueryProvider>
      <Suspense
        fallback={
          <div className="p-lg text-body-md text-on-surface-variant">
            読み込み中…
          </div>
        }
      >
        <SI02Inner />
      </Suspense>
    </QueryProvider>
  );
}
