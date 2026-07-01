/**
 * T-UC-38 ワークスペース切替 コンテナ — 実 workspaces API 配線
 *
 * GET /workspaces で所属 WS 一覧を取得し WorkspacePicker に渡す。選択は
 * localStorage (atelier_current_workspace) に永続化する。api client は注入可能。
 */

"use client";

import * as React from "react";
import { Loading } from "../../../components/Loading";
import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";

import { ApiError, type ApiClient } from "@atelier/api-client";

import { createAuthedApiClient } from "../../../lib/auth/connector";
import {
  WorkspacePicker,
  type WorkspaceOption,
} from "../../../components/WorkspacePicker";

interface ApiWorkspace {
  id: string;
  name: string;
}

const CURRENT_WS_KEY = "atelier_current_workspace";

function readCurrent(): string | undefined {
  if (typeof window === "undefined") return undefined;
  return window.localStorage.getItem(CURRENT_WS_KEY) ?? undefined;
}

export interface WorkspaceSwitcherContainerProps {
  readonly client?: ApiClient;
}

function isForbidden(error: unknown): boolean {
  return error instanceof ApiError && error.status === 403;
}

export function WorkspaceSwitcherContainer({
  client: injected,
}: WorkspaceSwitcherContainerProps) {
  const client = useMemo(() => injected ?? createAuthedApiClient(), [injected]);
  const [current, setCurrent] = useState<string | undefined>(undefined);

  const list = useQuery({
    queryKey: ["workspaces"],
    queryFn: async () => {
      const res = await client.get("/workspaces");
      return (res as { data?: ApiWorkspace[] }).data ?? [];
    },
    retry: false,
  });

  // 初期選択: localStorage → 先頭 WS。
  useEffect(() => {
    const saved = readCurrent();
    if (saved) {
      setCurrent(saved);
    } else if (list.data && list.data.length > 0) {
      setCurrent(list.data[0]!.id);
    }
  }, [list.data]);

  const onChange = (id: string): void => {
    setCurrent(id);
    if (typeof window !== "undefined")
      window.localStorage.setItem(CURRENT_WS_KEY, id);
  };

  if (isForbidden(list.error)) {
    return (
      <p role="alert" className="text-body-md text-error">
        ワークスペースにアクセスする権限がありません。
      </p>
    );
  }
  if (list.error) {
    return (
      <p role="alert" className="text-body-md text-error">
        ワークスペースの取得に失敗しました。
      </p>
    );
  }
  if (list.isLoading) {
    return <Loading className="py-md" />;
  }

  const options: WorkspaceOption[] = (list.data ?? []).map((w) => ({
    id: w.id,
    name: w.name,
  }));

  if (options.length === 0) {
    return (
      <p className="text-body-md text-on-surface-variant">
        所属ワークスペースがありません。
      </p>
    );
  }

  return (
    <div className="flex flex-col gap-md">
      <WorkspacePicker value={current} options={options} onChange={onChange} />
      <p className="text-label-md text-on-surface-variant">
        現在:{" "}
        <strong>{options.find((o) => o.id === current)?.name ?? "—"}</strong>
      </p>
    </div>
  );
}
