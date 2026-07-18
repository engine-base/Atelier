/**
 * S-E01 スレッドサイドバー — チャットの入口導線。
 *
 * モック 06_mockups/chat/S-E01-thread.html の左ペインに準拠:
 *   - スレッド検索 + 新規スレッド (全幅 primary ボタン)
 *   - 工程ごとのグルーピング (「◯◯工程（現在）」「◯◯工程（完了）」「工程横断」)
 *   - スレッドカード: 社員アバター(カラー) + 名前 + 相対時刻 + タイトル
 * 実 API:
 *   - GET  /chat/threads?project_id       スレッド一覧 (phase_id / last_message_preview 付)
 *   - GET  /workflow/phases?project_id    グルーピング用の工程
 *   - POST /chat/threads {project_id, ai_employee_id, phase_id?}  新規作成
 */

"use client";

import * as React from "react";
import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, Plus, Search } from "lucide-react";

import * as api from "../../../../lib/auth/connector";
import {
  employeeColor,
  employeeName,
  type EmployeeLike,
} from "../../../../lib/aiEmployees";
import { relTime } from "../../../../lib/format";
import { cn } from "../../../../lib/cn";

interface Thread {
  readonly id: string;
  readonly project_id: string;
  readonly ai_employee_id: string;
  readonly title: string | null;
  readonly phase_id?: string | null;
  readonly updated_at?: string;
  readonly last_message_preview?: string | null;
}
interface ProjectLite {
  readonly id: string;
  readonly name: string;
}
interface PhaseLite {
  readonly id: string;
  readonly name: string;
  readonly status: string;
  readonly order?: number;
}

export interface ThreadSidebarProps {
  readonly selectedId: string | null;
  readonly onSelect: (threadId: string) => void;
  /** 現在プロジェクト (指定時はそのプロジェクトのスレッドに絞り、工程グルーピングを行う)。 */
  readonly projectId?: string | null;
}

function ThreadCard({
  thread,
  employee,
  active,
  onSelect,
}: {
  readonly thread: Thread;
  readonly employee?: EmployeeLike;
  readonly active: boolean;
  readonly onSelect: (id: string) => void;
}) {
  const name = employeeName(employee) ?? "AI 社員";
  return (
    <button
      type="button"
      onClick={() => onSelect(thread.id)}
      className={cn(
        "mb-[2px] w-full rounded-md px-3 py-[10px] text-left transition-colors",
        active ? "bg-primary-container" : "hover:bg-surface-variant",
      )}
    >
      <span className="mb-[2px] flex items-center gap-2">
        <span
          aria-hidden="true"
          className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-[11px] font-bold text-white"
          style={{ backgroundColor: employeeColor(employee) }}
        >
          {name.charAt(0)}
        </span>
        <span className="text-[12px] font-bold text-on-surface">{name}</span>
        <span className="ml-auto text-[10.5px] tabular-nums text-on-surface-variant">
          {relTime(thread.updated_at)}
        </span>
      </span>
      <span className="line-clamp-2 block text-[12px] leading-[1.4] text-on-surface">
        {thread.title ?? thread.last_message_preview ?? "無題スレッド"}
      </span>
    </button>
  );
}

export function ThreadSidebar({
  selectedId,
  onSelect,
  projectId,
}: ThreadSidebarProps) {
  const queryClient = useQueryClient();
  const [creating, setCreating] = useState(false);
  const [search, setSearch] = useState("");
  const [formProjectId, setFormProjectId] = useState("");
  const [formEmployeeId, setFormEmployeeId] = useState("");
  const [formPhaseId, setFormPhaseId] = useState("");
  const [error, setError] = useState<string | null>(null);

  const threadsQuery = useQuery({
    queryKey: ["chat-threads", projectId ?? "all"],
    queryFn: async () =>
      (
        await api.getJson<Thread[]>(
          projectId ? `/chat/threads?project_id=${projectId}` : "/chat/threads",
        )
      ).data,
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
      (await api.getJson<EmployeeLike[]>("/ai-employees")).data,
    retry: false,
  });
  const phasesQuery = useQuery({
    queryKey: ["chat-phases", projectId ?? "none"],
    enabled: !!projectId,
    queryFn: async () =>
      (
        await api.getJson<PhaseLite[]>(
          `/workflow/phases?project_id=${projectId}`,
        )
      ).data,
    retry: false,
  });

  const employeeById = useMemo(() => {
    const m = new Map<string, EmployeeLike>();
    for (const e of employeesQuery.data ?? []) m.set(e.id, e);
    return m;
  }, [employeesQuery.data]);

  const createMut = useMutation({
    mutationFn: async () => {
      const created = await api.sendJson<Thread>("POST", "/chat/threads", {
        project_id: formProjectId,
        ai_employee_id: formEmployeeId,
        ...(formPhaseId ? { phase_id: formPhaseId } : {}),
      });
      return created ?? null;
    },
    onSuccess: (created) => {
      setError(null);
      setCreating(false);
      setFormProjectId("");
      setFormEmployeeId("");
      setFormPhaseId("");
      void queryClient.invalidateQueries({ queryKey: ["chat-threads"] });
      if (created?.id) onSelect(created.id);
    },
    onError: () => setError("スレッドの作成に失敗しました。"),
  });

  const threads = useMemo(() => threadsQuery.data ?? [], [threadsQuery.data]);
  const projects = projectsQuery.data ?? [];
  const employees = employeesQuery.data ?? [];
  const phases = useMemo(
    () =>
      [...(phasesQuery.data ?? [])].sort(
        (a, b) => (a.order ?? 0) - (b.order ?? 0),
      ),
    [phasesQuery.data],
  );

  // 検索フィルタ (タイトル / 社員名 / 最終メッセージ)
  const visible = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return threads;
    return threads.filter((t) => {
      const emp = employeeById.get(t.ai_employee_id);
      return [t.title, t.last_message_preview, employeeName(emp)]
        .filter((v): v is string => !!v)
        .some((v) => v.toLowerCase().includes(q));
    });
  }, [threads, search, employeeById]);

  // 工程グルーピング: 各工程 (スレッドを持つもののみ) → 工程横断
  const groups = useMemo(() => {
    const byPhase = new Map<string, Thread[]>();
    const cross: Thread[] = [];
    for (const t of visible) {
      if (t.phase_id) {
        const arr = byPhase.get(t.phase_id) ?? [];
        arr.push(t);
        byPhase.set(t.phase_id, arr);
      } else {
        cross.push(t);
      }
    }
    // モック準拠の並び: 現在(in_progress) → その他 (工程の逆順 = 直近工程が上)
    const ordered = [
      ...phases.filter((p) => p.status === "in_progress"),
      ...[...phases.filter((p) => p.status !== "in_progress")].reverse(),
    ];
    const phaseGroups = ordered
      .filter((p) => byPhase.has(p.id))
      .map((p) => ({ phase: p, threads: byPhase.get(p.id)! }));
    // phases 未取得でも phase_id 付きスレッドは落とさない
    const knownIds = new Set(phases.map((p) => p.id));
    for (const [pid, arr] of byPhase) {
      if (!knownIds.has(pid)) cross.push(...arr);
    }
    return { phaseGroups, cross };
  }, [visible, phases]);

  return (
    <aside
      aria-label="スレッド一覧"
      className="flex h-full min-h-0 w-full flex-col overflow-hidden bg-white lg:border-r lg:border-border"
    >
      <div className="border-b border-border p-[14px]">
        <div className="mb-[10px] flex items-center gap-[6px] rounded-md bg-surface-variant px-[10px] py-[6px]">
          <Search size={13} aria-hidden="true" className="shrink-0 text-on-surface-variant" />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="スレッドを検索"
            aria-label="スレッドを検索"
            className="w-full border-0 bg-transparent text-[12.5px] text-on-surface outline-none placeholder:text-on-surface-variant"
          />
        </div>
        <button
          type="button"
          onClick={() => {
            setCreating((v) => !v);
            setError(null);
            if (projectId) setFormProjectId(projectId);
          }}
          className="flex w-full items-center justify-center gap-1 rounded-md bg-primary px-3 py-[7px] text-[12.5px] font-semibold text-on-primary transition-colors hover:opacity-90"
        >
          <Plus size={13} aria-hidden="true" />
          新規スレッド
        </button>
      </div>

      {creating ? (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (formProjectId && formEmployeeId) createMut.mutate();
          }}
          className="flex flex-col gap-2 border-b border-border p-3"
        >
          <label className="flex flex-col gap-1">
            <span className="text-label-sm font-medium text-on-surface-variant">
              プロジェクト
            </span>
            <select
              value={formProjectId}
              onChange={(e) => setFormProjectId(e.target.value)}
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
              value={formEmployeeId}
              onChange={(e) => setFormEmployeeId(e.target.value)}
              className="h-9 rounded-md border border-border bg-white px-2 text-body-sm text-on-surface focus:border-primary focus:outline-none"
            >
              <option value="">選択してください</option>
              {employees.map((e) => (
                <option key={e.id} value={e.id}>
                  {employeeName(e)}
                </option>
              ))}
            </select>
          </label>
          {phases.length > 0 ? (
            <label className="flex flex-col gap-1">
              <span className="text-label-sm font-medium text-on-surface-variant">
                工程 (任意)
              </span>
              <select
                value={formPhaseId}
                onChange={(e) => setFormPhaseId(e.target.value)}
                className="h-9 rounded-md border border-border bg-white px-2 text-body-sm text-on-surface focus:border-primary focus:outline-none"
              >
                <option value="">工程横断</option>
                {phases.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>
            </label>
          ) : null}
          {error ? (
            <p role="alert" className="text-body-sm text-error">
              {error}
            </p>
          ) : null}
          <button
            type="submit"
            disabled={!formProjectId || !formEmployeeId || createMut.isPending}
            className="mt-1 inline-flex h-9 items-center justify-center rounded-md bg-primary px-3 text-label-md font-semibold text-on-primary transition-colors hover:opacity-90 disabled:opacity-50"
          >
            {createMut.isPending ? "作成中…" : "スレッドを作成"}
          </button>
        </form>
      ) : null}

      <div className="min-h-0 flex-1 overflow-y-auto p-[6px]">
        {threadsQuery.isLoading ? (
          <p className="px-[10px] py-2 text-body-sm text-on-surface-variant">
            読み込み中…
          </p>
        ) : visible.length === 0 ? (
          <p className="px-[10px] py-2 text-body-sm text-on-surface-variant">
            {search
              ? "検索に一致するスレッドがありません。"
              : "スレッドがありません。「新規スレッド」で AI 社員との会話を始めましょう。"}
          </p>
        ) : (
          <>
            {groups.phaseGroups.map(({ phase, threads: ts }) => {
              const current = phase.status === "in_progress";
              const done = phase.status === "completed";
              return (
                <div key={phase.id}>
                  <div
                    className={cn(
                      "flex items-center gap-[6px] px-[10px] pb-1 pt-2 text-[10px] font-bold uppercase tracking-[0.1em]",
                      current
                        ? "text-primary"
                        : done
                          ? "text-tertiary"
                          : "text-on-surface-variant",
                    )}
                  >
                    {current ? (
                      <span
                        aria-hidden="true"
                        className="h-[6px] w-[6px] rounded-full bg-primary"
                      />
                    ) : done ? (
                      <Check size={10} aria-hidden="true" />
                    ) : null}
                    {phase.name}工程{current ? "（現在）" : done ? "（完了）" : ""}
                  </div>
                  {ts.map((t) => (
                    <ThreadCard
                      key={t.id}
                      thread={t}
                      employee={employeeById.get(t.ai_employee_id)}
                      active={selectedId === t.id}
                      onSelect={onSelect}
                    />
                  ))}
                </div>
              );
            })}
            {groups.cross.length > 0 ? (
              <div>
                <div className="px-[10px] pb-1 pt-2 text-[10px] font-bold uppercase tracking-[0.1em] text-on-surface-variant">
                  工程横断
                </div>
                {groups.cross.map((t) => (
                  <ThreadCard
                    key={t.id}
                    thread={t}
                    employee={employeeById.get(t.ai_employee_id)}
                    active={selectedId === t.id}
                    onSelect={onSelect}
                  />
                ))}
              </div>
            ) : null}
          </>
        )}
      </div>
    </aside>
  );
}
