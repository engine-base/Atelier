/**
 * S-I03 実行モニター フリートビュー — design-audit v2 (実 tasks API 配線)
 *
 * モック 06_mockups/task/S-I03-monitor.html の「統計バー → 要対応 → 進行中 →
 * 順番待ち」構成をダークテーマで忠実に再現し、すべて実データにバインドする:
 *   - GET /tasks?project_id= : lifecycle_stage / dispatch_status で 3 区分に分類
 *   - GET /ai-employees : 担当コード → 表示名 (鉄則5)
 *   - GET /tasks/{id}/executions : 要対応/進行中カードの最新スコア・ログ導線
 *   - POST /tasks/{id}/approve|reject|retry : カード上の判断 (2 段階確認)
 * 並び替え (GAP-031③): モックの「要対応が上」(既定 — 区分表示) /「新しい順」/
 * 「進捗順」を実装。後 2 者は要対応+進行中を 1 つのグリッドに結合し
 * updated_at 降順 / 最新実行の進捗 (score ?? ac_pass_rate) 降順で並べる。
 * GAP-026 (運用操作系):
 *   - Bridge 接続バッジ (GET /bridge/status — bridge_workers presence)
 *   - 同時実行枠 X / Y + すべて一時停止⇄再開 (POST /dispatch/pause|resume)
 *   - 順番待ちから 1 件追加 (POST /dispatch/promote — 次の pick で最優先)
 *   - キュー取消 (POST /tasks/{id}/dispatch-cancel) / セッション停止 (dispatch-stop)
 *   - 表示方法 カード/一覧/ログ集約 (集約 = GET /executions-events 実イベント)
 *   - 経過時間 (実 started_at からの実測 tick) + 着手時刻・見積比の残り
 * 個別実行の SSE ライブログは ExecutionMonitorContainer (?execution=) が担う。
 */

"use client";

import { progressColor } from "@atelier/design-tokens";
import * as React from "react";
import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  AlertCircle,
  AlertTriangle,
  Check,
  CheckCircle2,
  Clock,
  ExternalLink,
  LayoutGrid,
  List,
  Loader2,
  Pause,
  PlayCircle,
  RotateCcw,
  Square,
  Terminal,
  X,
} from "lucide-react";

import { ApiError, type ApiClient } from "@atelier/api-client";

import { Loading } from "../../../../components/Loading";
import { createAuthedApiClient } from "../../../../lib/auth/connector";
import { cn } from "../../../../lib/cn";

interface ApiTask {
  id: string;
  title: string;
  lifecycle_stage?: string;
  dispatch_status?: string | null;
  assigned_employee_id?: string | null;
  estimated_hours?: number;
  retry_count?: number;
  blocked_reason?: string | null;
  updated_at?: string;
  created_at?: string;
}
interface ApiEmployee {
  name: string;
  display_name?: string | null;
}
interface ApiExecution {
  id: string;
  status: string;
  score?: number | null;
  ac_pass_rate?: number | null;
  started_at: string;
}
interface ApiBridgeStatus {
  running_count: number;
  queued_count: number;
  parallel_limit: number;
  available_slots: number;
  paused?: boolean;
  workers?: readonly {
    id: string;
    host_label: string;
    version: string;
    connected: boolean;
    last_seen_at: string;
  }[];
}
interface ApiExecutionEvent {
  at: string;
  kind: string;
  execution_id: string;
  task_id: string;
  task_title: string;
  score?: number | null;
  error_summary?: string | null;
}

const EVENT_LABEL: Record<string, { label: string; tone: string }> = {
  started: { label: "開始", tone: "text-[#93C5FD]" },
  succeeded: { label: "成功", tone: "text-tertiary" },
  failed: { label: "失敗", tone: "text-[#FCA5A5]" },
  cancelled: { label: "停止", tone: "text-secondary" },
  timeout: { label: "タイムアウト", tone: "text-[#FCA5A5]" },
};

/** 経過秒 → 「X 分 Y 秒」表示。 */
function fmtElapsed(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  const m = Math.floor(s / 60);
  return m > 0 ? `${m} 分 ${s % 60} 秒` : `${s} 秒`;
}

export interface FleetMonitorContainerProps {
  readonly projectId: string;
  readonly client?: ApiClient;
}

const DISPATCH_LABEL: Record<string, string> = {
  queued: "順番待ち",
  spawning: "起動中",
  running: "実行中",
  completing: "仕上げ中",
  dead: "応答なし",
  reclaimed: "回収済み",
};

/** ダークテーマ (モック準拠の固定パレット — モック自身が hex 指定のため踏襲)。 */
const DARK = {
  panel: "border-[#1E293B] bg-[#0B1220]",
  panelInner: "border-[#1E293B] bg-[#0F172A]",
  text: "text-[#E2E8F0]",
  muted: "text-[#94A3B8]",
  faint: "text-[#64748B]",
};

function StatCard({
  icon,
  label,
  value,
  sub,
  tone,
}: {
  readonly icon: React.ReactNode;
  readonly label: string;
  readonly value: React.ReactNode;
  readonly sub: string;
  readonly tone: string;
}) {
  return (
    <div className={cn("rounded-md border p-4", DARK.panel)}>
      <div className={cn("mb-1 flex items-center gap-1.5 text-[11px] font-bold", DARK.faint)}>
        {icon}
        {label}
      </div>
      <div className={cn("text-[26px] font-extrabold leading-none tracking-tight tabular-nums", tone)}>
        {value}
      </div>
      <div className={cn("mt-1 text-[11px]", DARK.faint)}>{sub}</div>
    </div>
  );
}

function SectionHead({
  icon,
  title,
  sub,
  count,
  countTone,
}: {
  readonly icon: React.ReactNode;
  readonly title: string;
  readonly sub: string;
  readonly count: number;
  readonly countTone: string;
}) {
  return (
    <div className="flex items-center gap-3">
      {icon}
      <div>
        <div className="text-[14px] font-bold text-[#F1F5F9]">{title}</div>
        <div className={cn("text-[12px]", DARK.muted)}>{sub}</div>
      </div>
      <div className="h-px flex-1 bg-[#1E293B]" />
      <span className={cn("text-[12px] font-bold tabular-nums", countTone)}>
        {count} 件
      </span>
    </div>
  );
}

/** アバターイニシャル (ダーク面用の簡易版)。 */
function InitialAvatar({ label }: { readonly label: string }) {
  return (
    <span
      aria-hidden="true"
      className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-primary text-[11px] font-bold text-on-primary"
    >
      {Array.from(label.trim())[0] ?? "?"}
    </span>
  );
}

export function FleetMonitorContainer({
  projectId,
  client: injected,
}: FleetMonitorContainerProps) {
  const client = useMemo(() => injected ?? createAuthedApiClient(), [injected]);
  const queryClient = useQueryClient();
  const [confirming, setConfirming] = useState<{
    taskId: string;
    action: "approve" | "reject" | "retry" | "stop";
  } | null>(null);
  const [decisionError, setDecisionError] = useState<string | null>(null);
  // GAP-031③: 並び替え (要対応が上 = 区分表示 / 新しい順 / 進捗順)
  const [sort, setSort] = useState<"attention" | "newest" | "progress">(
    "attention",
  );
  // GAP-026: 表示方法 (カード / 一覧 / ログ集約) + 運用操作の通知
  const [view, setView] = useState<"card" | "list" | "logs">("card");
  const [opsNotice, setOpsNotice] = useState<string | null>(null);
  const [opsError, setOpsError] = useState<string | null>(null);
  // 経過時間の実測 tick (1 秒)
  const [nowMs, setNowMs] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNowMs(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);

  // GAP-026: Bridge 集約状態 (presence + 並列枠 + 一時停止フラグ)
  const bridge = useQuery({
    queryKey: ["bridge-status"],
    queryFn: async () => {
      const res = await client.get("/bridge/status", {});
      return ((res as { data?: ApiBridgeStatus }).data ?? null);
    },
    refetchInterval: 15000,
    retry: false,
  });

  // GAP-026⑤: ログ集約ビュー (実 task_executions 由来イベント)
  const events = useQuery({
    queryKey: ["executions-events"],
    enabled: view === "logs",
    queryFn: async () => {
      const res = await client.get("/executions-events", {
        params: { query: { limit: 100 } },
      });
      const d = (res as { data?: unknown }).data;
      return Array.isArray(d) ? (d as ApiExecutionEvent[]) : [];
    },
    refetchInterval: view === "logs" ? 10000 : false,
    retry: false,
  });

  const refreshFleet = () => {
    void queryClient.invalidateQueries({ queryKey: ["tasks", "fleet", projectId] });
    void queryClient.invalidateQueries({ queryKey: ["bridge-status"] });
  };

  const pauseMut = useMutation({
    mutationFn: (pause: boolean) =>
      client.post(pause ? "/dispatch/pause" : "/dispatch/resume", {}),
    onSuccess: (_res: unknown, paused: boolean) => {
      setOpsError(null);
      setOpsNotice(
        paused
          ? "新規の実行開始を一時停止しました (実行中のセッションは継続します)"
          : "ディスパッチを再開しました",
      );
      refreshFleet();
    },
    onError: () => setOpsError("操作に失敗しました。時間をおいて再試行してください。"),
  });

  const promoteMut = useMutation({
    mutationFn: () => client.post("/dispatch/promote", {}),
    onSuccess: (res: unknown) => {
      setOpsError(null);
      const note = (res as { data?: { note?: string } }).data?.note;
      setOpsNotice(note ?? "順番待ちの先頭タスクを最優先に昇格しました");
      refreshFleet();
    },
    onError: (error: unknown) =>
      setOpsError(
        error instanceof ApiError && error.status === 409
          ? "順番待ちのタスクがありません。"
          : "操作に失敗しました。時間をおいて再試行してください。",
      ),
  });

  const cancelMut = useMutation({
    mutationFn: (taskId: string) =>
      client.post("/tasks/{task_id}/dispatch-cancel", {
        params: { path: { task_id: taskId } },
      }),
    onSuccess: () => {
      setOpsError(null);
      setOpsNotice("順番待ちから取り消しました (タスクは ready に戻ります)");
      refreshFleet();
    },
    onError: (error: unknown) =>
      setOpsError(
        error instanceof ApiError && error.status === 409
          ? "タスクの状態が変わったため取消できませんでした。"
          : "操作に失敗しました。時間をおいて再試行してください。",
      ),
  });

  const stopMut = useMutation({
    mutationFn: (taskId: string) =>
      client.post("/tasks/{task_id}/dispatch-stop", {
        params: { path: { task_id: taskId } },
      }),
    onSuccess: () => {
      setOpsError(null);
      setOpsNotice(
        "セッションを停止しました (実行は取消で閉じられ、以後の成果は取り込まれません)",
      );
      setConfirming(null);
      refreshFleet();
    },
    onError: (error: unknown) =>
      setOpsError(
        error instanceof ApiError && error.status === 409
          ? "タスクの状態が変わったため停止できませんでした。"
          : "操作に失敗しました。時間をおいて再試行してください。",
      ),
  });

  const tasks = useQuery({
    queryKey: ["tasks", "fleet", projectId],
    queryFn: async () => {
      const res = await client.get("/tasks", {
        params: { query: { project_id: projectId, limit: 200 } },
      });
      const d = (res as { data?: unknown }).data;
      return Array.isArray(d) ? (d as ApiTask[]) : [];
    },
    retry: false,
  });

  const employees = useQuery({
    queryKey: ["ai-employees", "fleet"],
    queryFn: async () => {
      const res = await client.get("/ai-employees", { params: { query: {} } });
      const d = (res as { data?: unknown }).data;
      return Array.isArray(d) ? (d as ApiEmployee[]) : [];
    },
    retry: false,
  });

  const all = useMemo(() => tasks.data ?? [], [tasks.data]);
  const attention = useMemo(
    () =>
      all.filter(
        (t) => t.lifecycle_stage === "awaiting" || t.lifecycle_stage === "blocked",
      ),
    [all],
  );
  const running = useMemo(
    () => all.filter((t) => t.lifecycle_stage === "in_progress"),
    [all],
  );
  const queued = useMemo(
    () => all.filter((t) => t.dispatch_status === "queued"),
    [all],
  );

  // 要対応/進行中カードの最新実行 (スコア表示 + SSE ログ導線)。件数は限定的。
  const cardTaskIds = useMemo(
    () => [...attention, ...running].map((t) => t.id),
    [attention, running],
  );
  const latestExecs = useQuery({
    queryKey: ["fleet-executions", cardTaskIds],
    enabled: cardTaskIds.length > 0,
    queryFn: async () => {
      const entries = await Promise.all(
        cardTaskIds.map(async (id) => {
          try {
            const res = await client.get("/tasks/{task_id}/executions", {
              params: { path: { task_id: id } },
            });
            const d = (res as { data?: unknown }).data;
            const list = Array.isArray(d) ? (d as ApiExecution[]) : [];
            const latest = list.reduce<ApiExecution | null>(
              (acc, e) => (!acc || e.started_at > acc.started_at ? e : acc),
              null,
            );
            return [id, latest] as const;
          } catch {
            return [id, null] as const;
          }
        }),
      );
      return Object.fromEntries(entries) as Record<string, ApiExecution | null>;
    },
    retry: false,
  });

  const decide = useMutation({
    mutationFn: ({
      taskId,
      action,
    }: {
      taskId: string;
      action: "approve" | "reject" | "retry";
    }) =>
      client.post(`/tasks/{task_id}/${action}` as "/tasks/{task_id}/approve", {
        params: { path: { task_id: taskId } },
        body: {},
      }),
    onSuccess: () => {
      setConfirming(null);
      setDecisionError(null);
      void queryClient.invalidateQueries({ queryKey: ["tasks", "fleet", projectId] });
    },
    onError: (error: unknown) => {
      setDecisionError(
        error instanceof ApiError && error.status === 409
          ? "タスクの状態が変わったため実行できませんでした。再読み込みしてください。"
          : "操作に失敗しました。時間をおいて再試行してください。",
      );
    },
  });

  if (tasks.error) {
    return (
      <p
        role="alert"
        className="rounded-md border-l-[3px] border-error bg-error/10 px-md py-sm text-body-md text-error"
      >
        タスクの取得に失敗しました。
      </p>
    );
  }
  if (tasks.isLoading) return <Loading className="py-md" />;

  const employeeName = (code: string | null | undefined): string | null => {
    if (!code) return null;
    const hit = (employees.data ?? []).find((e) => e.name === code);
    return hit?.display_name || code;
  };

  const today = new Date().toISOString().slice(0, 10);
  const doneToday = all.filter(
    (t) => t.lifecycle_stage === "done" && (t.updated_at ?? "").startsWith(today),
  );
  const approveCount = attention.filter((t) => t.lifecycle_stage === "awaiting").length;
  const retryCount = attention.length - approveCount;

  const execOf = (taskId: string): ApiExecution | null =>
    latestExecs.data?.[taskId] ?? null;

  const renderDecisionButtons = (t: ApiTask) => {
    const awaiting = t.lifecycle_stage === "awaiting";
    const canRetry = t.lifecycle_stage === "blocked" && (t.retry_count ?? 0) < 3;
    const isConfirming = confirming?.taskId === t.id;
    if (isConfirming) {
      return (
        <span className="flex flex-wrap items-center gap-2">
          <span className={cn("text-[11.5px] font-semibold", DARK.text)}>
            {confirming.action === "approve"
              ? "承認して完了にしますか？"
              : confirming.action === "reject"
                ? "差し戻しますか？"
                : confirming.action === "stop"
                  ? "このセッションを停止しますか？ (実行は取消で閉じられます)"
                  : "再試行しますか？"}
          </span>
          <button
            type="button"
            onClick={() => setConfirming(null)}
            className={cn("rounded-md border border-[#334155] px-2.5 py-1.5 text-[11.5px] font-semibold", DARK.muted, "hover:bg-[#1E293B]")}
          >
            キャンセル
          </button>
          <button
            type="button"
            disabled={decide.isPending || stopMut.isPending}
            onClick={() =>
              confirming.action === "stop"
                ? stopMut.mutate(t.id)
                : decide.mutate({ taskId: t.id, action: confirming.action })
            }
            className={cn(
              "rounded-md px-3 py-1.5 text-[11.5px] font-bold text-white disabled:opacity-50",
              confirming.action === "approve" ? "bg-tertiary" : "bg-error",
            )}
          >
            {decide.isPending || stopMut.isPending ? "実行中…" : "確定"}
          </button>
        </span>
      );
    }
    return (
      <>
        {awaiting ? (
          <>
            <button
              type="button"
              onClick={() => setConfirming({ taskId: t.id, action: "approve" })}
              className="inline-flex items-center gap-1 rounded-md bg-tertiary px-3 py-1.5 text-[12px] font-semibold text-white hover:brightness-110"
            >
              <Check size={13} aria-hidden="true" />
              承認
            </button>
            <button
              type="button"
              onClick={() => setConfirming({ taskId: t.id, action: "reject" })}
              className="rounded-md bg-[#1E293B] px-3 py-1.5 text-[12px] font-semibold text-[#FCA5A5] hover:bg-[#334155]"
            >
              差し戻し
            </button>
          </>
        ) : null}
        {canRetry ? (
          <button
            type="button"
            onClick={() => setConfirming({ taskId: t.id, action: "retry" })}
            className="inline-flex items-center gap-1 rounded-md bg-[#1E293B] px-3 py-1.5 text-[12px] font-semibold text-[#93C5FD] hover:bg-[#334155]"
          >
            <RotateCcw size={12} aria-hidden="true" />
            再試行
          </button>
        ) : null}
        {["spawning", "running", "completing"].includes(t.dispatch_status ?? "") ? (
          // GAP-026④: セッション停止 (2 段階確認 → POST dispatch-stop)
          <button
            type="button"
            onClick={() => setConfirming({ taskId: t.id, action: "stop" })}
            className="inline-flex items-center gap-1 rounded-md bg-[#1E293B] px-3 py-1.5 text-[12px] font-semibold text-[#FCA5A5] hover:bg-[#334155]"
          >
            <Square size={11} aria-hidden="true" />
            停止
          </button>
        ) : null}
      </>
    );
  };

  const SessionCard = ({
    t,
    attentionCard,
  }: {
    readonly t: ApiTask;
    readonly attentionCard: boolean;
  }) => {
    const exec = execOf(t.id);
    const awaiting = t.lifecycle_stage === "awaiting";
    const assignee = employeeName(t.assigned_employee_id);
    // GAP-026⑥: 経過時間 = 実 started_at からの実測。残りは見積比 (推測を装わない)
    const isLive =
      exec?.status === "running" &&
      ["spawning", "running", "completing"].includes(t.dispatch_status ?? "");
    const elapsedSec = isLive && exec
      ? (nowMs - new Date(exec.started_at).getTime()) / 1000
      : null;
    const remainMin =
      elapsedSec != null && t.estimated_hours != null
        ? Math.round(t.estimated_hours * 60 - elapsedSec / 60)
        : null;
    const startedLabel = exec
      ? new Date(exec.started_at).toLocaleTimeString("ja-JP", {
          hour: "2-digit",
          minute: "2-digit",
        })
      : null;
    const stagePill = awaiting
      ? "スコア確定 · 人間の承認が必要"
      : t.lifecycle_stage === "blocked"
        ? `要対応 · 再試行 ${t.retry_count ?? 0} / 3 回`
        : t.dispatch_status
          ? `実装中 · ${DISPATCH_LABEL[t.dispatch_status] ?? t.dispatch_status}`
          : "実装中";
    const score = exec?.score ?? null;
    const acRate = exec?.ac_pass_rate ?? null;

    return (
      <div
        className={cn(
          "flex flex-col overflow-hidden rounded-lg border",
          DARK.panel,
          attentionCard && "border-secondary shadow-[0_0_0_1px_rgba(199,160,74,0.28)]",
        )}
      >
        <div className="flex items-center gap-3 border-b border-[#1E293B] px-4 py-3.5">
          <span
            aria-hidden="true"
            className={cn(
              "h-2.5 w-2.5 shrink-0 animate-pulse rounded-full",
              attentionCard ? "bg-secondary" : "bg-primary",
            )}
          />
          <div className="min-w-0">
            <div className="truncate text-[14px] font-bold text-[#F1F5F9]">
              {t.title}
            </div>
            <div className={cn("text-[12px]", DARK.muted)}>
              タスク #{t.id.slice(0, 8)}
            </div>
          </div>
          {elapsedSec != null ? (
            <span className={cn("ml-auto shrink-0 text-[11.5px] tabular-nums", DARK.muted)}>
              経過 {fmtElapsed(elapsedSec)}
            </span>
          ) : null}
        </div>

        <div className="flex items-center gap-2.5 border-b border-[#1E293B] px-4 py-2.5 text-[12px]">
          {assignee ? (
            <>
              <InitialAvatar label={assignee} />
              <span className={DARK.text}>{assignee}</span>
            </>
          ) : (
            <span className={DARK.muted}>担当未割当</span>
          )}
          <span
            className={cn(
              "ml-auto rounded-full px-2.5 py-[3px] text-[11.5px] font-semibold",
              awaiting || t.lifecycle_stage === "blocked"
                ? "bg-[rgba(199,160,74,0.18)] text-secondary"
                : "bg-[rgba(37,99,235,0.18)] text-[#93C5FD]",
            )}
          >
            {stagePill}
          </span>
        </div>

        {score != null || acRate != null ? (
          <div className="border-b border-[#1E293B] px-4 py-3">
            <div className="mb-1.5 flex items-center gap-2 text-[12px]">
              <span className={DARK.muted}>
                {score != null ? "達成スコア" : "受入条件の達成"}
              </span>
              <span className={cn("ml-auto font-bold tabular-nums", DARK.text)}>
                {score != null
                  ? `${score.toFixed(2)} / 0.95（自動承認しきい値）`
                  : `${Math.round((acRate ?? 0) * 100)}%`}
              </span>
            </div>
            <div className="h-1.5 overflow-hidden rounded-full bg-[#1E293B]">
              <span
                className={cn(
                  "block h-full rounded-full",
                  // 要対応は semantic に secondary 維持
                  attentionCard && "bg-secondary",
                )}
                // GAP-121: 通常進捗は単色 (進捗が高いほどランプ上の色に進む)
                style={{
                  width: `${Math.round(((score ?? acRate) ?? 0) * 100)}%`,
                  ...(attentionCard
                    ? {}
                    : { backgroundColor: progressColor((score ?? acRate) ?? 0) }),
                }}
              />
            </div>
          </div>
        ) : null}

        {t.lifecycle_stage === "blocked" && t.blocked_reason ? (
          <p className="border-b border-[#1E293B] px-4 py-2.5 text-[12px] text-[#FCD34D]">
            {t.blocked_reason}
          </p>
        ) : null}

        <div className="flex flex-wrap items-center gap-2 bg-[#0F172A] px-4 py-3">
          {renderDecisionButtons(t)}
          <Link
            href={`/tasks/detail?task=${t.id}`}
            className="inline-flex items-center gap-1 rounded-md bg-[rgba(37,99,235,0.2)] px-3 py-1.5 text-[12px] font-semibold text-[#93C5FD] hover:bg-primary hover:text-on-primary"
          >
            <ExternalLink size={12} aria-hidden="true" />
            詳細
          </Link>
          {exec ? (
            <Link
              href={`/tasks/monitor?execution=${exec.id}`}
              className="inline-flex items-center gap-1 rounded-md bg-[#1E293B] px-3 py-1.5 text-[12px] font-semibold text-[#94A3B8] hover:bg-[#334155] hover:text-[#F1F5F9]"
            >
              <Terminal size={12} aria-hidden="true" />
              ログ
            </Link>
          ) : null}
          {isLive && startedLabel ? (
            <span className={cn("ml-auto shrink-0 text-[11px] tabular-nums", DARK.faint)}>
              {startedLabel} 着手
              {remainMin != null
                ? remainMin >= 0
                  ? ` · 見積比 残り ${remainMin} 分`
                  : ` · 見積超過 +${Math.abs(remainMin)} 分`
                : ""}
            </span>
          ) : null}
        </div>
      </div>
    );
  };

  const bridgeConnected = (bridge.data?.workers ?? []).some((w) => w.connected);
  const primaryWorker = (bridge.data?.workers ?? [])[0] ?? null;
  const paused = Boolean(bridge.data?.paused);

  return (
    <div className="flex flex-col gap-4 rounded-lg bg-[#0F172A] p-4 sm:p-5">
      {decisionError ? (
        <p role="alert" className="rounded-md bg-error/15 px-3 py-2 text-[12.5px] text-[#FCA5A5]">
          {decisionError}
        </p>
      ) : null}
      {opsError ? (
        <p role="alert" className="rounded-md bg-error/15 px-3 py-2 text-[12.5px] text-[#FCA5A5]">
          {opsError}
        </p>
      ) : null}
      {opsNotice ? (
        <p
          role="status"
          className="flex items-center gap-2 rounded-md bg-[rgba(20,184,166,0.12)] px-3 py-2 text-[12.5px] text-tertiary"
        >
          {opsNotice}
          <button
            type="button"
            aria-label="通知を閉じる"
            onClick={() => setOpsNotice(null)}
            className="ml-auto rounded-sm p-[2px] hover:bg-[#1E293B]"
          >
            <X size={12} aria-hidden="true" />
          </button>
        </p>
      ) : null}
      {paused ? (
        <p role="status" className="rounded-md border border-secondary bg-[rgba(199,160,74,0.12)] px-3 py-2 text-[12.5px] text-secondary">
          すべて一時停止中 — 新規の実行開始は止まっています (実行中のセッションは継続)。
        </p>
      ) : null}

      {/* ── ツールバー (GAP-026 — モック .controls 準拠) ── */}
      <div className="flex flex-wrap items-center gap-3">
        {/* Bridge 接続バッジ (presence — bridge_workers の実 ping) */}
        {bridgeConnected && primaryWorker ? (
          <div className="flex items-center gap-2 rounded-md border border-[rgba(20,184,166,0.3)] bg-[rgba(20,184,166,0.10)] px-3 py-1.5">
            <span
              aria-hidden="true"
              className="h-2 w-2 animate-pulse rounded-full bg-tertiary"
            />
            <span className="text-[12px] font-bold text-tertiary">
              ローカル Claude Code に接続中
            </span>
            <span className={cn("text-[11px]", DARK.muted)}>
              Bridge v{primaryWorker.version} · {primaryWorker.host_label}
            </span>
          </div>
        ) : (
          <div className="flex items-center gap-2 rounded-md border border-[#334155] bg-[#1E293B] px-3 py-1.5">
            <span aria-hidden="true" className="h-2 w-2 rounded-full bg-[#64748B]" />
            <span className={cn("text-[12px] font-bold", DARK.muted)}>
              Bridge 未接続
            </span>
            <span className={cn("text-[11px]", DARK.faint)}>
              直近 90 秒の presence がありません
            </span>
          </div>
        )}
        {/* 同時実行枠 (実 parallel_limit / available_slots) */}
        {bridge.data ? (
          <div className="flex items-center gap-2">
            <span className={cn("text-[11px] font-bold", DARK.faint)}>
              同時実行できる数
            </span>
            <strong className="text-[14px] tabular-nums text-[#F1F5F9]">
              {bridge.data.running_count} / {bridge.data.parallel_limit}
            </strong>
            <span className={cn("text-[11.5px]", DARK.muted)}>
              （あと {bridge.data.available_slots} 枠空いています）
            </span>
          </div>
        ) : null}
        <div className="ml-auto flex flex-wrap items-center gap-2">
          <button
            type="button"
            disabled={pauseMut.isPending}
            onClick={() => pauseMut.mutate(!paused)}
            className="inline-flex items-center gap-1.5 rounded-md border border-[#334155] bg-[#1E293B] px-3.5 py-2 text-[12.5px] font-semibold text-[#E2E8F0] hover:bg-[#334155] disabled:opacity-50"
          >
            {paused ? (
              <PlayCircle size={13} aria-hidden="true" />
            ) : (
              <Pause size={13} aria-hidden="true" />
            )}
            {paused ? "再開する" : "すべて一時停止"}
          </button>
          <button
            type="button"
            disabled={promoteMut.isPending || queued.length === 0}
            onClick={() => promoteMut.mutate()}
            className="inline-flex items-center gap-1.5 rounded-md bg-primary px-3.5 py-2 text-[12.5px] font-bold text-on-primary hover:brightness-110 disabled:opacity-50"
          >
            <PlayCircle size={13} aria-hidden="true" />
            順番待ちから 1 件追加
          </button>
        </div>
      </div>

      {/* ── 統計バー (実データ) ── */}
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatCard
          icon={<PlayCircle size={12} aria-hidden="true" />}
          label="いま動いている"
          value={running.length}
          sub="実装中のタスク"
          tone="text-[#93C5FD]"
        />
        <StatCard
          icon={<AlertCircle size={12} aria-hidden="true" />}
          label="あなたの判断待ち"
          value={attention.length}
          sub={`承認 ${approveCount} 件・再試行 ${retryCount} 件`}
          tone="text-secondary"
        />
        <StatCard
          icon={<Clock size={12} aria-hidden="true" />}
          label="順番待ち"
          value={queued.length}
          sub="枠が空き次第、自動で開始"
          tone="text-[#E2E8F0]"
        />
        <StatCard
          icon={<CheckCircle2 size={12} aria-hidden="true" />}
          label="今日 完了"
          value={doneToday.length}
          sub="本日更新された完了タスク"
          tone="text-tertiary"
        />
      </div>

      {/* ── 表示方法 (GAP-026⑤) + 並び替え (GAP-031③ — モック .seg-dark 準拠) ── */}
      <div className="flex flex-wrap items-center gap-2.5">
        <span className={cn("text-[11px] font-bold", DARK.faint)}>表示方法</span>
        <div role="group" aria-label="表示方法" className="flex gap-1 rounded-md bg-[#1E293B] p-1">
          {(
            [
              ["card", "カード", LayoutGrid],
              ["list", "一覧", List],
              ["logs", "ログ集約", Terminal],
            ] as const
          ).map(([key, label, Icon]) => (
            <button
              key={key}
              type="button"
              aria-pressed={view === key}
              onClick={() => setView(key)}
              className={cn(
                "inline-flex items-center gap-1 rounded px-3 py-1.5 text-[12px] font-semibold transition-colors",
                view === key
                  ? "bg-[#334155] text-[#F1F5F9]"
                  : cn(DARK.muted, "hover:text-[#E2E8F0]"),
              )}
            >
              <Icon size={13} aria-hidden="true" />
              {label}
            </button>
          ))}
        </div>
        <span className={cn("text-[11px] font-bold", DARK.faint)}>並び替え</span>
        <div
          role="group"
          aria-label="並び替え"
          className="flex gap-1 rounded-md bg-[#1E293B] p-1"
        >
          {(
            [
              ["attention", "要対応が上"],
              ["newest", "新しい順"],
              ["progress", "進捗順"],
            ] as const
          ).map(([key, label]) => (
            <button
              key={key}
              type="button"
              aria-pressed={sort === key}
              onClick={() => setSort(key)}
              className={cn(
                "rounded px-3 py-1.5 text-[12px] font-semibold transition-colors",
                sort === key
                  ? "bg-[#334155] text-[#F1F5F9]"
                  : cn(DARK.muted, "hover:text-[#E2E8F0]"),
              )}
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      {view === "logs" ? (
        /* GAP-026⑤: ログ集約 — 実 task_executions 由来のイベント列 (10 秒 poll) */
        <div className={cn("rounded-lg border p-4 font-mono text-[12px] leading-[1.9]", DARK.panel)}>
          {events.isLoading ? (
            <p className={DARK.muted}>読み込み中…</p>
          ) : (events.data ?? []).length === 0 ? (
            <p className={DARK.muted}>実行イベントはまだありません。</p>
          ) : (
            <ul role="list" className="flex flex-col">
              {(events.data ?? []).map((ev) => {
                const meta = EVENT_LABEL[ev.kind] ?? {
                  label: ev.kind,
                  tone: DARK.muted,
                };
                return (
                  <li key={`${ev.execution_id}-${ev.kind}`} className="flex flex-wrap gap-2">
                    <span className={cn("tabular-nums", DARK.faint)}>
                      {new Date(ev.at).toLocaleTimeString("ja-JP")}
                    </span>
                    <span className={cn("font-bold", meta.tone)}>[{meta.label}]</span>
                    <Link
                      href={`/tasks/monitor?execution=${ev.execution_id}`}
                      className={cn("hover:underline", DARK.text)}
                    >
                      {ev.task_title}
                    </Link>
                    {ev.score != null ? (
                      <span className={cn("tabular-nums", DARK.muted)}>
                        score {ev.score.toFixed(2)}
                      </span>
                    ) : null}
                    {ev.error_summary ? (
                      <span className="text-[#FCA5A5]">{ev.error_summary}</span>
                    ) : null}
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      ) : view === "list" ? (
        /* GAP-026⑤: 一覧 — 全区分を 1 テーブルで俯瞰 */
        <div className={cn("overflow-x-auto rounded-lg border", DARK.panel)}>
          <table className="w-full text-[12.5px]">
            <thead>
              <tr className={cn("border-b border-[#1E293B] text-left text-[11px]", DARK.faint)}>
                <th className="px-3.5 py-2.5 font-bold">タスク</th>
                <th className="px-3.5 py-2.5 font-bold">担当</th>
                <th className="px-3.5 py-2.5 font-bold">状態</th>
                <th className="px-3.5 py-2.5 font-bold">スコア</th>
                <th className="px-3.5 py-2.5 font-bold">操作</th>
              </tr>
            </thead>
            <tbody>
              {[...attention, ...running, ...queued].map((t) => {
                const e = execOf(t.id);
                return (
                  <tr key={t.id} className="border-b border-[#1E293B] last:border-0">
                    <td className={cn("px-3.5 py-2.5 font-semibold", DARK.text)}>
                      <Link href={`/tasks/detail?task=${t.id}`} className="hover:underline">
                        {t.title}
                      </Link>
                    </td>
                    <td className={cn("px-3.5 py-2.5", DARK.muted)}>
                      {employeeName(t.assigned_employee_id) ?? "未割当"}
                    </td>
                    <td className={cn("px-3.5 py-2.5", DARK.muted)}>
                      {t.lifecycle_stage === "awaiting"
                        ? "承認待ち"
                        : t.lifecycle_stage === "blocked"
                          ? "要対応"
                          : t.dispatch_status
                            ? (DISPATCH_LABEL[t.dispatch_status] ?? t.dispatch_status)
                            : "実装中"}
                    </td>
                    <td className={cn("px-3.5 py-2.5 tabular-nums", DARK.muted)}>
                      {e?.score != null ? e.score.toFixed(2) : "—"}
                    </td>
                    <td className="px-3.5 py-2.5">
                      <Link
                        href={`/tasks/detail?task=${t.id}`}
                        className="text-[#93C5FD] hover:underline"
                      >
                        詳細
                      </Link>
                    </td>
                  </tr>
                );
              })}
              {attention.length + running.length + queued.length === 0 ? (
                <tr>
                  <td colSpan={5} className={cn("px-3.5 py-5 text-center", DARK.muted)}>
                    セッションはありません。
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>
      ) : sort !== "attention" ? (
        /* 新しい順 / 進捗順: 要対応+進行中を結合して 1 グリッドで実ソート */
        <>
          <SectionHead
            icon={
              <span className="flex h-7 w-7 items-center justify-center rounded-md border border-[#334155] bg-[#1E293B] text-[#94A3B8]">
                <PlayCircle size={14} aria-hidden="true" />
              </span>
            }
            title={
              sort === "newest"
                ? "すべてのセッション（新しい順）"
                : "すべてのセッション（進捗順）"
            }
            sub={
              sort === "newest"
                ? "要対応・進行中を最終更新が新しい順に表示しています"
                : "要対応・進行中を最新実行の進捗が高い順に表示しています"
            }
            count={attention.length + running.length}
            countTone={DARK.muted}
          />
          {attention.length + running.length ? (
            <div className="grid grid-cols-1 gap-3.5 xl:grid-cols-2">
              {[...attention, ...running]
                .slice()
                .sort((a, b) => {
                  if (sort === "newest") {
                    return (b.updated_at ?? b.created_at ?? "").localeCompare(
                      a.updated_at ?? a.created_at ?? "",
                    );
                  }
                  const progressOf = (t: ApiTask): number => {
                    const e = execOf(t.id);
                    return e?.score ?? e?.ac_pass_rate ?? -1;
                  };
                  return progressOf(b) - progressOf(a);
                })
                .map((t) => (
                  <SessionCard
                    key={t.id}
                    t={t}
                    attentionCard={
                      t.lifecycle_stage === "awaiting" ||
                      t.lifecycle_stage === "blocked"
                    }
                  />
                ))}
            </div>
          ) : (
            <p className={cn("rounded-md border border-dashed border-[#334155] px-4 py-5 text-center text-[12.5px]", DARK.muted)}>
              セッションはありません。
            </p>
          )}
        </>
      ) : (
        <>
      {/* ── 要対応 ── */}
      <SectionHead
        icon={
          <span className="flex h-7 w-7 items-center justify-center rounded-md border border-secondary bg-[rgba(199,160,74,0.18)] text-secondary">
            <AlertTriangle size={14} aria-hidden="true" />
          </span>
        }
        title="あなたの判断待ち"
        sub="承認・差し戻し・再試行のいずれかを選んでください"
        count={attention.length}
        countTone="text-secondary"
      />
      {attention.length ? (
        <div className="grid grid-cols-1 gap-3.5 xl:grid-cols-2">
          {attention.map((t) => (
            <SessionCard key={t.id} t={t} attentionCard />
          ))}
        </div>
      ) : (
        <p className={cn("rounded-md border border-dashed border-[#334155] px-4 py-5 text-center text-[12.5px]", DARK.muted)}>
          判断待ちのタスクはありません。
        </p>
      )}

      {/* ── 進行中 ── */}
      <SectionHead
        icon={
          <span className="flex h-7 w-7 items-center justify-center rounded-md border border-tertiary bg-[rgba(20,184,166,0.18)] text-tertiary">
            <Loader2 size={14} aria-hidden="true" />
          </span>
        }
        title="順調に進行中"
        sub="介入は不要です。完了すれば自動で承認待ち or 完了になります"
        count={running.length}
        countTone="text-tertiary"
      />
      {running.length ? (
        <div className="grid grid-cols-1 gap-3.5 xl:grid-cols-2">
          {running.map((t) => (
            <SessionCard key={t.id} t={t} attentionCard={false} />
          ))}
        </div>
      ) : (
        <p className={cn("rounded-md border border-dashed border-[#334155] px-4 py-5 text-center text-[12.5px]", DARK.muted)}>
          実行中のタスクはありません。タスクボードから「再生」で開始できます。
        </p>
      )}
        </>
      )}

      {/* ── 順番待ち (カードビューのみ — 一覧/ログ集約では重複描画しない) ── */}
      {view === "card" ? (
        <>
      <SectionHead
        icon={
          <span className="flex h-7 w-7 items-center justify-center rounded-md border border-[#334155] bg-[#1E293B] text-[#94A3B8]">
            <Clock size={14} aria-hidden="true" />
          </span>
        }
        title="順番待ち（同時実行枠が空いたら自動で開始）"
        sub="ディスパッチャの並列上限を超えた分は、ここに積まれます"
        count={queued.length}
        countTone={DARK.muted}
      />
      {queued.length ? (
        <div className={cn("rounded-lg border border-dashed border-[#334155] p-4", DARK.panel)}>
          <ul role="list" className="flex flex-col gap-2">
            {queued.map((t, i) => (
              <li
                key={t.id}
                className={cn("flex items-center gap-3 rounded-md border px-3.5 py-2.5 text-[12.5px]", DARK.panelInner)}
              >
                <span className="flex h-[22px] w-[22px] shrink-0 items-center justify-center rounded-full bg-[#1E293B] text-[11px] font-bold text-[#94A3B8]">
                  {i + 1}
                </span>
                <span className={cn("font-mono text-[11px]", DARK.faint)}>
                  #{t.id.slice(0, 8)}
                </span>
                <Link
                  href={`/tasks/detail?task=${t.id}`}
                  className={cn("min-w-0 flex-1 font-semibold hover:text-[#93C5FD] hover:underline", DARK.text)}
                >
                  {t.title}
                </Link>
                <span className={cn("ml-auto shrink-0 whitespace-nowrap text-[11.5px] tabular-nums", DARK.muted)}>
                  {t.estimated_hours != null ? `見積 ${t.estimated_hours} 時間` : "未見積"}
                </span>
                {/* GAP-026③: キュー取消 */}
                <button
                  type="button"
                  disabled={cancelMut.isPending}
                  onClick={() => cancelMut.mutate(t.id)}
                  aria-label={`順番待ちから取消: ${t.title}`}
                  className="inline-flex shrink-0 items-center gap-1 rounded-md bg-[#1E293B] px-2.5 py-1 text-[11.5px] font-semibold text-[#FCA5A5] hover:bg-[#334155] disabled:opacity-50"
                >
                  <X size={11} aria-hidden="true" />
                  取消
                </button>
              </li>
            ))}
          </ul>
        </div>
      ) : (
        <p className={cn("rounded-md border border-dashed border-[#334155] px-4 py-5 text-center text-[12.5px]", DARK.muted)}>
          順番待ちのタスクはありません。
        </p>
      )}
        </>
      ) : null}
    </div>
  );
}
