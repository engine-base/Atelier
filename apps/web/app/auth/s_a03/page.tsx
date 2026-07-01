/**
 * S-A03 ワークスペース設定 — T-UC-02
 *
 * 実 workspaces / ai-learning API に配線。workspaceId は URL ?workspace=、
 * 無ければ localStorage(atelier_current_workspace) を使う。
 */

"use client";

import * as React from "react";
import { Suspense } from "react";
import { useSearchParams } from "next/navigation";

import { QueryProvider } from "../../../providers/query-provider";
import { WorkspaceSettingsContainer } from "./_components/WorkspaceSettingsContainer";

function readCurrentWorkspace(): string | null {
  if (typeof window === "undefined") return null;
  return window.localStorage.getItem("atelier_current_workspace");
}

function SA03Inner() {
  const params = useSearchParams();
  const workspaceId = params.get("workspace") ?? readCurrentWorkspace();

  return (
    <div className="mx-auto w-full max-w-2xl px-md py-lg">
      {workspaceId ? (
        <WorkspaceSettingsContainer workspaceId={workspaceId} />
      ) : (
        <p className="text-body-md text-on-surface-variant">
          ワークスペースが選択されていません。
        </p>
      )}
    </div>
  );
}

export default function SA03Page() {
  return (
    <QueryProvider>
      <Suspense
        fallback={
          <div className="p-lg text-body-md text-on-surface-variant">
            読み込み中…
          </div>
        }
      >
        <SA03Inner />
      </Suspense>
    </QueryProvider>
  );
}
