/**
 * S-J01 承認インボックス コンテナ — T-UC-17 系 (実 approval-inbox API 配線) v2
 *
 * モック S-J01-list.html の全ブロックを実データで構成する:
 *   - KPI 4 連 (緊急 / 未処理 / 今日承認した / 平均処理時間) — 全件取得から実算出
 *   - カテゴリチップ (種類で絞り込み・件数付き) + プロジェクト絞り込み select
 *   - リスト (緊急 / 通常セクション) + 詳細ペイン (2 カラム、<lg は縦積み)
 *   - POST /approval-inbox/{id}/decide {decision, note} で承認 / 差戻 → 楽観除外
 * api client は prop 注入可能 (テスト時に fake を渡す)。
 */

"use client";

import * as React from "react";
import { Loading } from "../../../../components/Loading";
import { useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { ApiError, type ApiClient } from "@atelier/api-client";

import { createAuthedApiClient } from "../../../../lib/auth/connector";
import { employeeName, type EmployeeLike } from "../../../../lib/aiEmployees";
import { relTime } from "../../../../lib/format";
import { cn } from "../../../../lib/cn";
import {
  ApprovalDetail,
  type ApprovalDetailData,
  type ImpactRow,
  type StageOption,
} from "./ApprovalDetail";
import {
  ApprovalsList,
  type ApprovalKind,
  type ApprovalRow,
} from "./ApprovalsList";

const KINDS: readonly ApprovalKind[] = [
  "task_approval",
  "phase_approval",
  "knowledge_write",
  "comment_response",
  "scope_change",
];
const KEY = ["approval-inbox"] as const;

interface ApiApproval {
  id: string;
  type: string;
  title: string;
  payload?: Record<string, unknown>;
  status?: string;
  resolved_at?: string | null;
  created_at: string;
}

interface ProjectLite {
  id: string;
  name: string;
}

function toKind(type: string): ApprovalKind {
  return (KINDS as readonly string[]).includes(type)
    ? (type as ApprovalKind)
    : "task_approval";
}

function asArray<T>(v: unknown): T[] {
  return Array.isArray(v) ? (v as T[]) : [];
}

function str(v: unknown): string | undefined {
  return typeof v === "string" && v ? v : undefined;
}

function num(v: unknown): number | undefined {
  return typeof v === "number" ? v : undefined;
}

/** payload.impact ([{label, value, warn?}]) を検証つきで取り出す。 */
function impactOf(payload: Record<string, unknown> | undefined): ImpactRow[] {
  return asArray<Record<string, unknown>>(payload?.impact)
    .map((r) => ({
      label: str(r.label) ?? "",
      value: str(r.value) ?? "",
      ...(r.warn === true ? { warn: true } : {}),
    }))
    .filter((r) => r.label && r.value);
}

/** payload.stages ([{key, label, checked?, disabled?}]) を検証つきで取り出す。 */
function stagesOf(payload: Record<string, unknown> | undefined): StageOption[] {
  return asArray<Record<string, unknown>>(payload?.stages)
    .map((s) => ({
      key: str(s.key) ?? str(s.label) ?? "",
      label: str(s.label) ?? "",
      ...(s.checked === true ? { checked: true } : {}),
      ...(s.disabled === true ? { disabled: true } : {}),
    }))
    .filter((s) => s.key && s.label);
}

const CHIP_DEFS: readonly {
  key: "all" | ApprovalKind;
  label: string;
  urgent?: boolean;
}[] = [
  { key: "all", label: "すべて" },
  { key: "scope_change", label: "仕様変更の取り込み判断", urgent: true },
  { key: "task_approval", label: "タスク承認" },
  { key: "phase_approval", label: "工程進行の承認" },
  { key: "knowledge_write", label: "ナレッジ登録の承認" },
  { key: "comment_response", label: "コメント返信" },
];

function Kpi({
  label,
  value,
  sub,
  tone,
}: {
  readonly label: string;
  readonly value: React.ReactNode;
  readonly sub: string;
  readonly tone?: "urgent" | "green";
}) {
  return (
    <div
      className={cn(
        "rounded-md border bg-white px-[18px] py-[14px]",
        tone === "urgent" ? "border-error bg-[#FEF2F2]" : "border-border",
      )}
    >
      <div className="mb-1.5 text-[11.5px] font-bold tracking-[0.04em] text-on-surface-variant">
        {label}
      </div>
      <div
        className={cn(
          "text-[30px] font-extrabold leading-none tracking-[-0.02em] tabular-nums",
          tone === "urgent" && "text-error",
          tone === "green" && "text-tertiary",
          !tone && "text-on-surface",
        )}
      >
        {value}
      </div>
      <div className="mt-1.5 text-[11.5px] text-on-surface-variant">{sub}</div>
    </div>
  );
}

export interface ApprovalsContainerProps {
  readonly client?: ApiClient;
}

function isForbidden(error: unknown): boolean {
  return error instanceof ApiError && error.status === 403;
}

export function ApprovalsContainer({
  client: injected,
}: ApprovalsContainerProps) {
  const client = useMemo(() => injected ?? createAuthedApiClient(), [injected]);
  const queryClient = useQueryClient();
  const [kindFilter, setKindFilter] = useState<"all" | ApprovalKind>("all");
  const [projectFilter, setProjectFilter] = useState<string>("all");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const detailRef = useRef<HTMLDivElement | null>(null);

  // モバイル (1 カラム積み) では詳細ペインが画面外に出るため、選択時にスクロールする
  const selectAndReveal = (id: string): void => {
    setSelectedId(id);
    if (typeof window !== "undefined" && window.innerWidth < 1024) {
      requestAnimationFrame(() => {
        detailRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
      });
    }
  };

  const list = useQuery({
    queryKey: KEY,
    queryFn: async () => {
      // 全 status を取得し client 側で pending / 処理済に分ける
      // (処理済は KPI「今日 承認した」「平均処理時間」の実算出に使う)。
      const res = await client.get("/approval-inbox", {
        params: { query: { limit: 200 } },
      });
      return asArray<ApiApproval>((res as { data?: unknown }).data);
    },
    retry: false,
  });

  const employeesQuery = useQuery({
    queryKey: ["approvals-employees"],
    queryFn: async () => {
      const res = await client.get("/ai-employees", {});
      return asArray<EmployeeLike>((res as { data?: unknown }).data);
    },
    retry: false,
  });

  const projectsQuery = useQuery({
    queryKey: ["approvals-projects"],
    queryFn: async () => {
      const res = await client.get("/projects", {
        params: { query: { limit: 50 } },
      });
      return asArray<ProjectLite>((res as { data?: unknown }).data);
    },
    retry: false,
  });

  const decideMut = useMutation({
    mutationFn: (vars: {
      id: string;
      decision: "approve" | "reject";
      note?: string | null;
    }) =>
      client.post("/approval-inbox/{approval_id}/decide", {
        params: { path: { approval_id: vars.id } },
        body: {
          decision: vars.decision,
          ...(vars.note ? { note: vars.note } : {}),
        },
      }),
    // 楽観更新: 決裁した項目を即座に pending から除外。失敗時は元に戻す。
    onMutate: async (vars) => {
      await queryClient.cancelQueries({ queryKey: KEY });
      const prev = queryClient.getQueryData<ApiApproval[]>(KEY);
      queryClient.setQueryData<ApiApproval[]>(KEY, (old) =>
        (old ?? []).filter((a) => a.id !== vars.id),
      );
      setSelectedId((cur) => (cur === vars.id ? null : cur));
      return { prev };
    },
    onError: (_e, _vars, ctx) => {
      if (ctx?.prev) queryClient.setQueryData(KEY, ctx.prev);
    },
    onSettled: () => void queryClient.invalidateQueries({ queryKey: KEY }),
  });

  if (isForbidden(list.error)) {
    return (
      <p role="alert" className="text-body-md text-error">
        承認インボックスにアクセスする権限がありません。
      </p>
    );
  }
  if (list.error) {
    return (
      <p role="alert" className="text-body-md text-error">
        承認待ちの取得に失敗しました。
      </p>
    );
  }
  if (list.isLoading) {
    return <Loading className="py-md" />;
  }

  const all = list.data ?? [];
  // status 未返却 (旧 API 形状) は pending とみなす
  const pending = all.filter((a) => (a.status ?? "pending") === "pending");
  const resolved = all.filter((a) => (a.status ?? "pending") !== "pending");

  if (pending.length === 0 && resolved.length === 0) {
    return (
      <p className="text-body-md text-on-surface-variant">
        承認待ちはありません。
      </p>
    );
  }

  const employees = employeesQuery.data ?? [];
  const employeeByName = new Map<string, EmployeeLike>();
  for (const e of employees) {
    const n = (e as { name?: string }).name;
    if (n) employeeByName.set(n, e);
  }

  const requesterOf = (a: ApiApproval): string => {
    const raw =
      str(a.payload?.requested_by) ??
      str(a.payload?.actor) ??
      str(a.payload?.assigned_employee_id);
    if (!raw) return "—";
    const emp = employeeByName.get(raw);
    return emp ? (employeeName(emp) ?? raw) : raw;
  };

  // ── KPI (実データから算出) ─────────────────────────────
  const urgentCount = pending.filter((a) => a.type === "scope_change").length;
  const today = new Date();
  const isToday = (iso: string | null | undefined): boolean => {
    if (!iso) return false;
    const d = new Date(iso);
    return (
      d.getFullYear() === today.getFullYear() &&
      d.getMonth() === today.getMonth() &&
      d.getDate() === today.getDate()
    );
  };
  const approvedToday = resolved.filter(
    (a) => a.status === "approved" && isToday(a.resolved_at),
  ).length;
  const durations = resolved
    .filter((a) => a.resolved_at)
    .map(
      (a) =>
        (new Date(a.resolved_at as string).getTime() -
          new Date(a.created_at).getTime()) /
        1000,
    )
    .filter((s) => s >= 0);
  const avgSec =
    durations.length > 0
      ? durations.reduce((s, v) => s + v, 0) / durations.length
      : null;
  const avgDisplay =
    avgSec === null
      ? "—"
      : avgSec < 90
        ? `${Math.round(avgSec)} 秒`
        : avgSec < 5400
          ? `${Math.round(avgSec / 60)} 分`
          : `${(avgSec / 3600).toFixed(1)} 時間`;

  // ── フィルタ ───────────────────────────────────────────
  const countByKind = new Map<ApprovalKind, number>();
  for (const a of pending) {
    const k = toKind(a.type);
    countByKind.set(k, (countByKind.get(k) ?? 0) + 1);
  }
  const projects = projectsQuery.data ?? [];
  const projectName = (id: string): string =>
    projects.find((p) => p.id === id)?.name ?? id;
  const projectIds = [
    ...new Set(
      pending
        .map((a) => str(a.payload?.project_id))
        .filter((v): v is string => Boolean(v)),
    ),
  ];

  const visible = pending.filter((a) => {
    if (kindFilter !== "all" && toKind(a.type) !== kindFilter) return false;
    if (projectFilter !== "all" && str(a.payload?.project_id) !== projectFilter)
      return false;
    return true;
  });

  const rows: ApprovalRow[] = visible.map((a) => ({
    id: a.id,
    kind: toKind(a.type),
    title: a.title,
    requester: requesterOf(a),
    created_at: relTime(a.created_at),
    ...(str(a.payload?.preview) ?? str(a.payload?.description)
      ? { preview: (str(a.payload?.preview) ?? str(a.payload?.description))! }
      : {}),
    ...(num(a.payload?.score) !== undefined
      ? { score: num(a.payload?.score)! }
      : {}),
  }));

  const selected = visible.find((a) => a.id === selectedId) ?? null;
  const detail: ApprovalDetailData | null = selected
    ? {
        id: selected.id,
        kind: toKind(selected.type),
        title: selected.title,
        requester: requesterOf(selected),
        createdAt: relTime(selected.created_at),
        ...(str(selected.payload?.description)
          ? { description: str(selected.payload?.description)! }
          : {}),
        ...(impactOf(selected.payload).length > 0
          ? { impact: impactOf(selected.payload) }
          : {}),
        ...(stagesOf(selected.payload).length > 0
          ? { stages: stagesOf(selected.payload) }
          : {}),
        ...(num(selected.payload?.score) !== undefined
          ? { score: num(selected.payload?.score)! }
          : {}),
      }
    : null;

  return (
    <div className="flex flex-col gap-4">
      {/* KPI 4 連 */}
      <section
        aria-label="承認 KPI"
        className="grid grid-cols-2 gap-3 xl:grid-cols-4"
      >
        <Kpi
          label="緊急（仕様変更）"
          value={urgentCount}
          sub={urgentCount > 0 ? "他工程をブロック中" : "ブロックなし"}
          {...(urgentCount > 0 ? { tone: "urgent" as const } : {})}
        />
        <Kpi label="未処理" value={pending.length} sub="あなたの判断待ち" />
        <Kpi
          label="今日 承認した"
          value={approvedToday}
          sub="本日決裁済みの件数"
          {...(approvedToday > 0 ? { tone: "green" as const } : {})}
        />
        <Kpi label="平均処理時間" value={avgDisplay} sub="承認 1 件あたり" />
      </section>

      {/* カテゴリチップ + プロジェクト絞り込み */}
      <section
        aria-label="種類で絞り込み"
        className="flex flex-wrap items-center gap-2 rounded-md border border-border bg-white px-[14px] py-[10px]"
      >
        <span className="mr-1 text-[11.5px] font-bold text-on-surface-variant">
          種類で絞り込み
        </span>
        {CHIP_DEFS.map((c) => {
          const active = kindFilter === c.key;
          const count =
            c.key === "all"
              ? pending.length
              : (countByKind.get(c.key as ApprovalKind) ?? 0);
          return (
            <button
              key={c.key}
              type="button"
              aria-pressed={active}
              onClick={() => setKindFilter(c.key)}
              className={cn(
                "inline-flex items-center gap-1.5 rounded-full px-3.5 py-1.5 text-[12.5px] font-semibold transition-colors",
                c.urgent && !active && "bg-[#FEE2E2] text-[#991B1B]",
                c.urgent && active && "bg-error text-white",
                !c.urgent &&
                  (active
                    ? "bg-primary text-on-primary"
                    : "bg-surface-variant text-on-surface-variant hover:bg-primary-container hover:text-primary-container-fg"),
              )}
            >
              {c.label}
              <span
                className={cn(
                  "rounded-full px-[7px] py-[1px] text-[11px] font-bold tabular-nums",
                  active ? "bg-white/25" : "bg-black/10",
                )}
              >
                {count}
              </span>
            </button>
          );
        })}
        {projectIds.length > 0 ? (
          <label className="ml-auto inline-flex items-center gap-2 text-[12px] text-on-surface-variant">
            <span className="sr-only">プロジェクトで絞り込み</span>
            <select
              value={projectFilter}
              onChange={(e) => setProjectFilter(e.target.value)}
              className="rounded-md border border-border bg-white px-3 py-[7px] text-[12.5px] text-on-surface focus:border-primary focus:outline-none"
            >
              <option value="all">全プロジェクト</option>
              {projectIds.map((id) => (
                <option key={id} value={id}>
                  {projectName(id)}
                </option>
              ))}
            </select>
          </label>
        ) : null}
      </section>

      {/* リスト + 詳細ペイン */}
      <div className="grid grid-cols-1 items-start gap-5 lg:grid-cols-[1fr_400px]">
        <ApprovalsList
          rows={rows}
          selectedId={selectedId}
          onSelect={selectAndReveal}
          onApprove={(id) => decideMut.mutate({ id, decision: "approve" })}
          onReject={(id) => decideMut.mutate({ id, decision: "reject" })}
        />
        <div ref={detailRef} className="scroll-mt-[64px] lg:sticky lg:top-[72px]">
          <ApprovalDetail
            item={detail}
            deciding={decideMut.isPending}
            onDecide={(decision, note) => {
              if (selected)
                decideMut.mutate({ id: selected.id, decision, note });
            }}
            onDefer={() => setSelectedId(null)}
          />
        </div>
      </div>
    </div>
  );
}
