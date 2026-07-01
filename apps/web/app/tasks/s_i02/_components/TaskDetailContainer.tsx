/**
 * S-I02 タスク詳細 コンテナ — T-UC-15 (実 tasks/comments API 配線)
 *
 * 概要(GET /tasks/{id}) / 仕様(/acceptance-criteria) / 実行履歴(/executions) /
 * コメント(GET /comments?target_type=task) を取得し TaskDetailTabs に渡す。
 * 入出力・添付は単一の裏付け API が無いため「情報なし」を表示する。
 * api client は prop 注入可能 (テスト時に fake を渡す)。
 */

"use client";

import * as React from "react";
import { Loading } from "../../../../components/Loading";
import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";

import { ApiError, type ApiClient } from "@atelier/api-client";

import { createAuthedApiClient } from "../../../../lib/auth/connector";
import { TaskDetailTabs, type TaskTabId } from "./TaskDetailTabs";

interface ApiTask {
  title: string;
  description?: string | null;
  summary?: string | null;
  lifecycle_stage?: string;
  priority?: string;
  type?: string;
  estimated_hours?: number;
  assigned_employee_id?: string | null;
}
interface ApiAc {
  items?: readonly unknown[];
  version?: number;
}
interface ApiExecution {
  id: string;
  status: string;
  score?: number | null;
  ac_pass_rate?: number | null;
  started_at: string;
}
interface ApiComment {
  id: string;
  author_user_id?: string | null;
  content: string;
  created_at: string;
}

export interface TaskDetailContainerProps {
  readonly taskId: string;
  readonly client?: ApiClient;
}

function isForbidden(error: unknown): boolean {
  return error instanceof ApiError && error.status === 403;
}

function Row({
  label,
  value,
}: {
  readonly label: string;
  readonly value: React.ReactNode;
}) {
  return (
    <div className="flex justify-between gap-md border-b border-surface-variant/40 py-xs">
      <dt className="text-label-md text-on-surface-variant">{label}</dt>
      <dd className="text-body-md text-on-surface">{value}</dd>
    </div>
  );
}

export function TaskDetailContainer({
  taskId,
  client: injected,
}: TaskDetailContainerProps) {
  const client = useMemo(() => injected ?? createAuthedApiClient(), [injected]);

  const task = useQuery({
    queryKey: ["task", taskId],
    queryFn: async () => {
      const res = await client.get("/tasks/{task_id}", {
        params: { path: { task_id: taskId } },
      });
      return (res as { data?: ApiTask }).data ?? null;
    },
    retry: false,
  });
  const ac = useQuery({
    queryKey: ["task", taskId, "ac"],
    queryFn: async () => {
      const res = await client.get("/tasks/{task_id}/acceptance-criteria", {
        params: { path: { task_id: taskId } },
      });
      return (res as { data?: ApiAc }).data ?? null;
    },
    retry: false,
  });
  const executions = useQuery({
    queryKey: ["task", taskId, "executions"],
    queryFn: async () => {
      const res = await client.get("/tasks/{task_id}/executions", {
        params: { path: { task_id: taskId } },
      });
      return (res as { data?: ApiExecution[] }).data ?? [];
    },
    retry: false,
  });
  const comments = useQuery({
    queryKey: ["task", taskId, "comments"],
    queryFn: async () => {
      const res = await client.get("/comments", {
        params: { query: { target_type: "task", target_id: taskId } },
      });
      return (res as { data?: ApiComment[] }).data ?? [];
    },
    retry: false,
  });

  if (isForbidden(task.error)) {
    return (
      <p role="alert" className="text-body-md text-error">
        このタスクを表示する権限がありません。
      </p>
    );
  }
  if (task.error) {
    return (
      <p role="alert" className="text-body-md text-error">
        タスクの取得に失敗しました。
      </p>
    );
  }
  if (task.isLoading || !task.data) {
    return <Loading className="py-md" />;
  }

  const t = task.data;
  const acItems = ac.data?.items ?? [];
  const execs = executions.data ?? [];
  const cmts = comments.data ?? [];

  const content: Partial<Record<TaskTabId, React.ReactNode>> = {
    overview: (
      <dl className="flex flex-col gap-xs">
        <Row label="ステータス" value={t.lifecycle_stage ?? "—"} />
        <Row label="優先度" value={t.priority ?? "—"} />
        <Row label="種別" value={t.type ?? "—"} />
        <Row label="見積(h)" value={t.estimated_hours ?? "—"} />
        <Row label="担当 AI 社員" value={t.assigned_employee_id ?? "未割当"} />
        {t.summary ? <Row label="サマリ" value={t.summary} /> : null}
        {t.description ? (
          <p className="whitespace-pre-wrap pt-sm text-body-md text-on-surface">
            {t.description}
          </p>
        ) : null}
      </dl>
    ),
    spec: acItems.length ? (
      <ul className="flex flex-col gap-xs">
        {acItems.map((item, i) => (
          <li key={i} className="text-body-md text-on-surface">
            ・{typeof item === "string" ? item : JSON.stringify(item)}
          </li>
        ))}
      </ul>
    ) : (
      <p className="text-body-md text-on-surface-variant">
        受入条件は登録されていません。
      </p>
    ),
    history: execs.length ? (
      <ul className="flex flex-col gap-sm">
        {execs.map((e) => (
          <li
            key={e.id}
            className="flex items-center justify-between rounded-md border border-surface-variant/40 px-md py-xs text-body-sm"
          >
            <span className="font-semibold text-on-surface">{e.status}</span>
            <span className="text-on-surface-variant">
              スコア {e.score ?? "—"} / AC{" "}
              {e.ac_pass_rate != null
                ? `${Math.round(e.ac_pass_rate * 100)}%`
                : "—"}
            </span>
            <time className="text-label-sm text-on-surface-variant">
              {e.started_at.slice(0, 16).replace("T", " ")}
            </time>
          </li>
        ))}
      </ul>
    ) : (
      <p className="text-body-md text-on-surface-variant">
        実行履歴はまだありません。
      </p>
    ),
    comments: cmts.length ? (
      <ul className="flex flex-col gap-sm">
        {cmts.map((c) => (
          <li
            key={c.id}
            className="rounded-md border border-surface-variant/40 px-md py-sm"
          >
            <p className="text-label-sm text-on-surface-variant">
              {c.author_user_id ?? "匿名"}・
              {c.created_at.slice(0, 16).replace("T", " ")}
            </p>
            <p className="whitespace-pre-wrap text-body-md text-on-surface">
              {c.content}
            </p>
          </li>
        ))}
      </ul>
    ) : (
      <p className="text-body-md text-on-surface-variant">
        コメントはまだありません。
      </p>
    ),
  };

  return <TaskDetailTabs title={t.title} content={content} />;
}
