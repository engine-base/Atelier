/**
 * S-L03 クライアントプロジェクトビュー画面 — T-UC-22 (R-T08)
 *
 * client_portal JWT で GET /client/projects/{id} を取得。projectId は URL ?project=。
 */

"use client";

import * as React from "react";
import { Suspense } from "react";
import { useSearchParams } from "next/navigation";

import { QueryProvider } from "../../../providers/query-provider";
import { ClientProjectViewContainer } from "./_components/ClientProjectViewContainer";

function SL03Inner() {
  const params = useSearchParams();
  const projectId = params.get("project");

  return (
    <div className="min-h-screen w-full bg-surface">
      {projectId ? (
        <ClientProjectViewContainer projectId={projectId} />
      ) : (
        <div className="mx-auto w-full max-w-[1100px] px-6 py-8">
          <p className="text-body-md text-on-surface-variant">
            プロジェクトが指定されていません。
          </p>
        </div>
      )}
    </div>
  );
}

export default function SL03Page() {
  return (
    <QueryProvider>
      <Suspense
        fallback={
          <div className="p-lg text-body-md text-on-surface-variant">
            読み込み中…
          </div>
        }
      >
        <SL03Inner />
      </Suspense>
    </QueryProvider>
  );
}
