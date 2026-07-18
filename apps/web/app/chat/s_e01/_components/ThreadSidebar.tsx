/**
 * S-E01 スレッドサイドバー — チャットの入口導線。
 *
 * 以前は /chat が `?thread=<id>` 前提で、スレッド一覧も新規作成導線も無く、
 * URL に thread が無いと「スレッドを選択してください」で必ず行き止まりだった。
 * ここで実 API に配線する:
 *   - GET  /chat/threads          スレッド一覧
 *   - POST /chat/threads {project_id, ai_employee_id}  新規作成
 *   - GET  /projects / /ai-employees  作成フォームの選択肢
 * 作成/選択したスレッドを onSelect(threadId) で親に伝える。
 */

"use client";

import * as React from "react";
import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import * as api from "../../../../lib/auth/connector";

interface Thread {
  readonly id: string;
  readonly project_id: string;
  readonly ai_employee_id: string;
  readonly title: string | null;
}
interface ProjectLite {
  readonly id: string;
  readonly name: string;
}
interface EmployeeLite {
  readonly id: string;
  readonly name: string;
  readonly display_name: string;
}

export interface ThreadSidebarProps {
  readonly selectedId: string | null;
  readonly onSelect: (threadId: string) => void;
}

export function ThreadSidebar({ selectedId, onSelect }: ThreadSidebarProps) {
  const queryClient = useQueryClient();
  const [creating, setCreating] = useState(false);
  const [projectId, setProjectId] = useState("");
  const [employeeId, setEmployeeId] = useState("");
  const [error, setError] = useState<string | null>(null);

  const threadsQuery = useQuery({
    queryKey: ["chat-threads"],
    queryFn: async () => (await api.getJson<Thread[]>("/chat/threads")).data,
    retry: false,
  });
  const projectsQuery = useQuery({
    queryKey: ["chat-projects"],
    queryFn: async () =>
      (await api.getJson<ProjectLite[]>("/projects?limit=50")).data,
    retry: false,
  });
  const employeesQuery = useQuery({
    queryKey: ["chat-employees"],
    queryFn: async () =>
      (await api.getJson<EmployeeLite[]>("/ai-employees")).data,
    retry: false,
  });

  const empName = useMemo(() => {
    const m = new Map<string, string>();
    for (const e of employeesQuery.data ?? [])
      m.set(e.id, e.display_name || e.name);
    return m;
  }, [employeesQuery.data]);
  const projName = useMemo(() => {
    const m = new Map<string, string>();
    for (const p of projectsQuery.data ?? []) m.set(p.id, p.name);
    return m;
  }, [projectsQuery.data]);

  const createMut = useMutation({
    mutationFn: async () => {
      const created = await api.sendJson<Thread>("POST", "/chat/threads", {
        project_id: projectId,
        ai_employee_id: employeeId,
      });
      return created ?? null;
    },
    onSuccess: (created) => {
      setError(null);
      setCreating(false);
      setProjectId("");
      setEmployeeId("");
      void queryClient.invalidateQueries({ queryKey: ["chat-threads"] });
      if (created?.id) onSelect(created.id);
    },
    onError: () => setError("スレッドの作成に失敗しました。"),
  });

  const threads = threadsQuery.data ?? [];
  const projects = projectsQuery.data ?? [];
  const employees = employeesQuery.data ?? [];

  return (
    <aside className="flex w-full flex-col gap-3 md:w-[280px] md:shrink-0">
      <div className="flex items-center justify-between">
        <h2 className="text-label-lg font-bold text-on-surface">スレッド</h2>
        <button
          type="button"
          onClick={() => {
            setCreating((v) => !v);
            setError(null);
          }}
          className="inline-flex h-8 items-center gap-1 rounded-md bg-primary px-3 text-label-md font-semibold text-on-primary transition-colors hover:bg-[#1E54D8]"
        >
          ＋ 新規
        </button>
      </div>

      {creating ? (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (projectId && employeeId) createMut.mutate();
          }}
          className="flex flex-col gap-2 rounded-md border border-border bg-surface p-3"
        >
          <label className="flex flex-col gap-1">
            <span className="text-label-sm font-medium text-on-surface-variant">
              プロジェクト
            </span>
            <select
              value={projectId}
              onChange={(e) => setProjectId(e.target.value)}
              className="h-9 rounded-md border border-border bg-white px-2 text-body-sm text-on-surface focus:border-primary focus:outline-none"
            >
              <option value="">選択してください</option>
              {projects.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-label-sm font-medium text-on-surface-variant">
              AI 社員
            </span>
            <select
              value={employeeId}
              onChange={(e) => setEmployeeId(e.target.value)}
              className="h-9 rounded-md border border-border bg-white px-2 text-body-sm text-on-surface focus:border-primary focus:outline-none"
            >
              <option value="">選択してください</option>
              {employees.map((e) => (
                <option key={e.id} value={e.id}>
                  {e.display_name || e.name}
                </option>
              ))}
            </select>
          </label>
          {error ? (
            <p role="alert" className="text-body-sm text-error">
              {error}
            </p>
          ) : null}
          <button
            type="submit"
            disabled={!projectId || !employeeId || createMut.isPending}
            className="mt-1 inline-flex h-9 items-center justify-center rounded-md bg-primary px-3 text-label-md font-semibold text-on-primary transition-colors hover:bg-[#1E54D8] disabled:opacity-50"
          >
            {createMut.isPending ? "作成中…" : "スレッドを作成"}
          </button>
        </form>
      ) : null}

      <div className="flex min-h-0 flex-1 flex-col gap-1 overflow-y-auto">
        {threadsQuery.isLoading ? (
          <p className="text-body-sm text-on-surface-variant">読み込み中…</p>
        ) : threads.length === 0 ? (
          <p className="text-body-sm text-on-surface-variant">
            スレッドがありません。「＋ 新規」で AI 社員との会話を始めましょう。
          </p>
        ) : (
          threads.map((t) => {
            const label =
              t.title ||
              `${projName.get(t.project_id) ?? "プロジェクト"} · ${empName.get(t.ai_employee_id) ?? "AI 社員"}`;
            return (
              <button
                key={t.id}
                type="button"
                onClick={() => onSelect(t.id)}
                className={
                  "flex flex-col rounded-md border px-3 py-2 text-left transition-colors " +
                  (selectedId === t.id
                    ? "border-primary bg-primary-container"
                    : "border-border hover:border-primary hover:bg-surface")
                }
              >
                <span className="truncate text-body-sm font-semibold text-on-surface">
                  {label}
                </span>
                <span className="truncate text-label-sm text-on-surface-variant">
                  {empName.get(t.ai_employee_id) ?? ""}
                </span>
              </button>
            );
          })
        )}
      </div>
    </aside>
  );
}
