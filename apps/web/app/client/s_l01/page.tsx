/**
 * S-L01 クライアント招待管理画面 — T-UC-20
 *
 * 実 client-invitations API に配線。projectId は URL ?project=。
 */

"use client";

import * as React from "react";
import { Suspense } from "react";
import { useSearchParams } from "next/navigation";

import { QueryProvider } from "../../../providers/query-provider";
import { InvitationsListContainer } from "./_components/InvitationsListContainer";

function SL01Inner() {
  const params = useSearchParams();
  const projectId = params.get("project");

  return (
    <div className="mx-auto w-full max-w-4xl px-md py-lg">
      <h1 className="mb-md text-headline-md font-bold text-on-surface">
        クライアント招待管理
      </h1>
      {projectId ? (
        <InvitationsListContainer projectId={projectId} />
      ) : (
        <p className="text-body-md text-on-surface-variant">
          プロジェクトを選択すると招待を管理できます。
        </p>
      )}
    </div>
  );
}

export default function SL01Page() {
  return (
    <QueryProvider>
      <Suspense
        fallback={
          <div className="p-lg text-body-md text-on-surface-variant">
            読み込み中…
          </div>
        }
      >
        <SL01Inner />
      </Suspense>
    </QueryProvider>
  );
}
