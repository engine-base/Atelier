/**
 * S-E01 スレッド未選択時の右ペイン (GAP-123 — 経営者指示「空白が気になる」)
 *
 * ただの案内文ではなく、ここから会話を始められるクイックスタートにする:
 *   - AI 社員カードの一覧 (実 GET /ai-employees)。クリックで即スレッド作成 → 開く
 *   - プロジェクト文脈 (nav) があればそのプロジェクトで作成、無ければ選択 UI
 * 死にボタンは置かない: プロジェクト未選択のときは社員カードを無効化して
 * 理由を明示する (Rule 10)。
 */

"use client";

import * as React from "react";
import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { MessageSquarePlus } from "lucide-react";

import * as api from "../../../../lib/auth/connector";
import {
  employeeColor,
  employeeName,
  employeeTitle,
  type EmployeeLike,
} from "../../../../lib/aiEmployees";

interface ProjectLite {
  readonly id: string;
  readonly name: string;
}

export interface ChatEmptyStateProps {
  /** プロジェクト文脈 (nav 由来)。あれば選択 UI を出さずこのプロジェクトで作成。 */
  readonly projectId?: string | null;
  readonly onOpenThread: (threadId: string) => void;
}

export function ChatEmptyState({ projectId, onOpenThread }: ChatEmptyStateProps) {
  const queryClient = useQueryClient();
  const [pickedProject, setPickedProject] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [creatingFor, setCreatingFor] = useState<string | null>(null);

  const employeesQuery = useQuery({
    queryKey: ["chat-employees"],
    queryFn: async () => (await api.getJson<EmployeeLike[]>("/ai-employees")).data,
    retry: false,
  });
  const projectsQuery = useQuery({
    queryKey: ["chat-projects"],
    enabled: !projectId,
    queryFn: async () => (await api.getJson<ProjectLite[]>("/projects?limit=50")).data,
    retry: false,
  });

  const effectiveProject = projectId ?? pickedProject;
  const employees = employeesQuery.data ?? [];
  const projects = useMemo(() => projectsQuery.data ?? [], [projectsQuery.data]);

  const createMut = useMutation({
    mutationFn: async (employeeId: string) => {
      const created = await api.sendJson<{ id: string }>("POST", "/chat/threads", {
        project_id: effectiveProject,
        ai_employee_id: employeeId,
      });
      return created ?? null;
    },
    onSuccess: (created) => {
      setError(null);
      setCreatingFor(null);
      void queryClient.invalidateQueries({ queryKey: ["chat-threads"] });
      if (created?.id) onOpenThread(created.id);
    },
    onError: () => {
      setCreatingFor(null);
      setError("スレッドを作成できませんでした。");
    },
  });

  const start = (employeeId: string) => {
    if (!effectiveProject || createMut.isPending) return;
    setCreatingFor(employeeId);
    createMut.mutate(employeeId);
  };

  return (
    <div className="mx-auto flex w-full max-w-[720px] flex-col px-md py-10">
      <h2 className="text-[22px] font-bold tracking-tight text-on-surface">
        AI 社員とチャットを始める
      </h2>
      <p className="mt-1.5 text-body-md text-on-surface-variant">
        社員を選ぶと、すぐに新しいスレッドが始まります。左の一覧から過去のスレッドを開くこともできます。
      </p>

      {!projectId ? (
        <label className="mt-5 flex max-w-[360px] flex-col gap-1.5">
          <span className="text-label-md font-medium text-on-surface-variant">
            プロジェクト
          </span>
          <select
            value={pickedProject}
            onChange={(e) => setPickedProject(e.target.value)}
            className="h-10 rounded-md border border-border bg-white px-2.5 text-body-sm text-on-surface focus:border-primary focus:outline-none"
          >
            <option value="">選択してください</option>
            {projects.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
          {!effectiveProject ? (
            <span className="text-[11.5px] text-on-surface-variant">
              プロジェクトを選ぶと社員カードから会話を始められます。
            </span>
          ) : null}
        </label>
      ) : null}

      {error ? (
        <p role="alert" className="mt-3 text-body-sm font-semibold text-error">
          {error}
        </p>
      ) : null}

      {employeesQuery.isLoading ? (
        <p className="mt-6 text-body-sm text-on-surface-variant">読み込み中…</p>
      ) : employees.length === 0 ? (
        <p className="mt-6 text-body-sm text-on-surface-variant">
          AI 社員がまだいません。ワークスペースを作成すると自動配備されます。
        </p>
      ) : (
        <div className="mt-6 grid grid-cols-1 gap-3 sm:grid-cols-2">
          {employees.map((emp) => {
            const name = employeeName(emp) ?? "AI 社員";
            const title = employeeTitle(emp);
            const busy = creatingFor === emp.id;
            return (
              <button
                key={emp.id}
                type="button"
                disabled={!effectiveProject || createMut.isPending}
                onClick={() => start(emp.id)}
                aria-label={`${name}と新しいスレッドを開始`}
                className="group flex items-center gap-3 rounded-lg border border-border bg-white px-4 py-3.5 text-left transition-all hover:-translate-y-px hover:border-primary hover:shadow-sm disabled:cursor-not-allowed disabled:opacity-50"
              >
                <span
                  aria-hidden="true"
                  className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full text-[15px] font-bold text-white"
                  style={{ backgroundColor: employeeColor(emp) }}
                >
                  {name.charAt(0)}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[13.5px] font-bold text-on-surface">
                    {name}
                  </span>
                  {title ? (
                    <span className="block truncate text-[11.5px] text-on-surface-variant">
                      {title}
                    </span>
                  ) : null}
                </span>
                <MessageSquarePlus
                  size={16}
                  aria-hidden="true"
                  className="shrink-0 text-on-surface-variant transition-colors group-hover:text-primary"
                />
                {busy ? (
                  <span className="text-[11px] font-semibold text-on-surface-variant">
                    作成中…
                  </span>
                ) : null}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
