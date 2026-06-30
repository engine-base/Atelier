/**
 * S-C02 AI 社員詳細・編集画面 — T-UC-07
 *
 * 実 ai-employees API (GET/PATCH /ai-employees/{id}) に配線。employeeId は URL ?employee=。
 */

"use client";

import * as React from "react";
import { Suspense } from "react";
import { useSearchParams } from "next/navigation";

import { QueryProvider } from "../../../providers/query-provider";
import { EmployeeEditorContainer } from "./_components/EmployeeEditorContainer";

function SC02Inner() {
  const params = useSearchParams();
  const employeeId = params.get("employee");

  return (
    <div className="mx-auto w-full max-w-3xl px-md py-lg">
      {employeeId ? (
        <EmployeeEditorContainer employeeId={employeeId} />
      ) : (
        <p className="text-body-md text-on-surface-variant">
          AI 社員を選択すると詳細・編集を表示します。
        </p>
      )}
    </div>
  );
}

export default function SC02Page() {
  return (
    <QueryProvider>
      <Suspense
        fallback={
          <div className="p-lg text-body-md text-on-surface-variant">
            読み込み中…
          </div>
        }
      >
        <SC02Inner />
      </Suspense>
    </QueryProvider>
  );
}
