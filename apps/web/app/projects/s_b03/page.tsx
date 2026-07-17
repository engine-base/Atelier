/**
 * S-B03 プロジェクト設定画面 — T-UC-05
 *
 * 実 projects API (GET/PATCH/DELETE /projects/{id}) に配線。projectId は URL ?project=。
 */

"use client";

import * as React from "react";
import { Suspense } from "react";
import { useRouter, useSearchParams } from "next/navigation";

import { QueryProvider } from "../../../providers/query-provider";
import { ProjectSettingsContainer } from "./_components/ProjectSettingsContainer";

function SB03Inner() {
  const params = useSearchParams();
  const router = useRouter();
  const projectId = params.get("project");

  return (
    <div className="mx-auto w-full max-w-[800px] px-md py-lg">
      {projectId ? (
        <ProjectSettingsContainer
          projectId={projectId}
          onDeleted={() => router.push("/projects")}
        />
      ) : (
        <p className="text-body-md text-on-surface-variant">
          プロジェクトを選択すると設定を表示します。
        </p>
      )}
    </div>
  );
}

export default function SB03Page() {
  return (
    <QueryProvider>
      <Suspense
        fallback={
          <div className="p-lg text-body-md text-on-surface-variant">
            読み込み中…
          </div>
        }
      >
        <SB03Inner />
      </Suspense>
    </QueryProvider>
  );
}
