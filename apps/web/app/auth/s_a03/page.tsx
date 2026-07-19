/**
 * S-A03 ワークスペース設定 — T-UC-02
 *
 * 実 workspaces / ai-learning API に配線。workspaceId は URL ?workspace=、
 * 無ければ localStorage(atelier_current_workspace) を使う。
 */

"use client";

import * as React from "react";
import { Suspense, useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";

import { getJson } from "../../../lib/auth/connector";
import {
  CURRENT_WS_KEY,
  readCurrentWorkspace,
} from "../../../lib/currentWorkspace";
import { QueryProvider } from "../../../providers/query-provider";
import { WorkspaceSettingsContainer } from "./_components/WorkspaceSettingsContainer";

function SA03Inner() {
  const params = useSearchParams();
  const router = useRouter();
  const fromUrl = params.get("workspace");
  const [workspaceId, setWorkspaceId] = useState<string | null | undefined>(
    fromUrl ?? undefined,
  );

  // ?workspace= が無ければ localStorage → 先頭 WS フォールバック (行き止まり防止)
  useEffect(() => {
    if (fromUrl) return;
    const saved = readCurrentWorkspace();
    if (saved) {
      setWorkspaceId(saved);
      return;
    }
    let cancelled = false;
    getJson<ReadonlyArray<{ id: string }>>("/workspaces")
      .then((res) => {
        if (!cancelled) setWorkspaceId(res.data[0]?.id ?? null);
      })
      .catch(() => {
        if (!cancelled) setWorkspaceId(null);
      });
    return () => {
      cancelled = true;
    };
  }, [fromUrl]);

  if (workspaceId === undefined) {
    return (
      <p className="p-lg text-body-md text-on-surface-variant">読み込み中…</p>
    );
  }
  return (
    <div className="mx-auto w-full max-w-[1200px] px-md py-lg">
      {workspaceId ? (
        <WorkspaceSettingsContainer
          workspaceId={workspaceId}
          onDeleted={() => {
            window.localStorage.removeItem(CURRENT_WS_KEY);
            router.push("/projects");
          }}
        />
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
