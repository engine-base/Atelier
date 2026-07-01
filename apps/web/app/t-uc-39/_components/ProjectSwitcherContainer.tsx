/**
 * T-UC-39 プロジェクト切替 コンテナ — 実 projects API 配線
 *
 * GET /projects（現在 WS で絞り込み）で一覧を取得し ProjectPicker に渡す。
 * 選択は localStorage(atelier_current_project) に永続化する。api client は注入可能。
 */

"use client";

import * as React from "react";
import { Loading } from "../../../components/Loading";
import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";

import { ApiError, type ApiClient } from "@atelier/api-client";

import { createAuthedApiClient } from "../../../lib/auth/connector";
import {
  ProjectPicker,
  type ProjectOption,
} from "../../../components/ProjectPicker";

interface ApiProject {
  id: string;
  name: string;
}

const CURRENT_PROJECT_KEY = "atelier_current_project";
const CURRENT_WS_KEY = "atelier_current_workspace";

function readLocal(key: string): string | undefined {
  if (typeof window === "undefined") return undefined;
  return window.localStorage.getItem(key) ?? undefined;
}

export interface ProjectSwitcherContainerProps {
  readonly client?: ApiClient;
}

function isForbidden(error: unknown): boolean {
  return error instanceof ApiError && error.status === 403;
}

export function ProjectSwitcherContainer({
  client: injected,
}: ProjectSwitcherContainerProps) {
  const client = useMemo(() => injected ?? createAuthedApiClient(), [injected]);
  const [current, setCurrent] = useState<string | undefined>(undefined);
  const workspaceId = readLocal(CURRENT_WS_KEY);

  const list = useQuery({
    queryKey: ["projects", "switcher", workspaceId ?? null],
    queryFn: async () => {
      const res = await client.get("/projects", {
        params: { query: workspaceId ? { workspace_id: workspaceId } : {} },
      });
      return (res as { data?: ApiProject[] }).data ?? [];
    },
    retry: false,
  });

  useEffect(() => {
    const saved = readLocal(CURRENT_PROJECT_KEY);
    if (saved) {
      setCurrent(saved);
    } else if (list.data && list.data.length > 0) {
      setCurrent(list.data[0]!.id);
    }
  }, [list.data]);

  const onChange = (id: string): void => {
    setCurrent(id);
    if (typeof window !== "undefined")
      window.localStorage.setItem(CURRENT_PROJECT_KEY, id);
  };

  if (isForbidden(list.error)) {
    return (
      <p role="alert" className="text-body-md text-error">
        プロジェクトにアクセスする権限がありません。
      </p>
    );
  }
  if (list.error) {
    return (
      <p role="alert" className="text-body-md text-error">
        プロジェクトの取得に失敗しました。
      </p>
    );
  }
  if (list.isLoading) {
    return <Loading className="py-md" />;
  }

  const options: ProjectOption[] = (list.data ?? []).map((p) => ({
    id: p.id,
    name: p.name,
  }));

  if (options.length === 0) {
    return (
      <p className="text-body-md text-on-surface-variant">
        プロジェクトがありません。
      </p>
    );
  }

  return (
    <div className="flex flex-col gap-md">
      <ProjectPicker value={current} options={options} onChange={onChange} />
      <p className="text-label-md text-on-surface-variant">
        現在:{" "}
        <strong>{options.find((o) => o.id === current)?.name ?? "—"}</strong>
      </p>
    </div>
  );
}
