/**
 * S-I03 実行モニター フリートビュー — design-audit v2 (実 tasks API 配線)
 *
 * モック 06_mockups/task/S-I03-monitor.html の「統計バー → 要対応 → 進行中 →
 * 順番待ち」構成をダークテーマで忠実に再現し、すべて実データにバインドする:
 *   - GET /tasks?project_id= : lifecycle_stage / dispatch_status で 3 区分に分類
 *   - GET /ai-employees : 担当コード → 表示名 (鉄則5)
 *   - GET /tasks/{id}/executions : 要対応/進行中カードの最新スコア・ログ導線
 *   - POST /tasks/{id}/approve|reject|retry : カード上の判断 (2 段階確認)
 * モックの Bridge 接続バッジ・すべて一時停止・順番待ちから追加・ログ集約ビュー・
 * キュー取消は対応 API が無いため未描画 (Rule 10 / GAP-026)。
 * 個別実行の SSE ライブログは ExecutionMonitorContainer (?execution=) が担う。
 */

"use client";

import * as React from "react";
import { useMemo, useState } from "react";
import Link from "next/link";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  AlertCircle,
  AlertTriangle,
  Check,
  CheckCircle2,
  Clock,
  ExternalLink,
  Loader2,
  PlayCircle,
  RotateCcw,
  Terminal,
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
    action: "approve" | "reject" | "retry";
  } | null>(null);
  const [decisionError, setDecisionError] = useState<string | null>(null);

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
            disabled={decide.isPending}
            onClick={() => decide.mutate({ taskId: t.id, action: confirming.action })}
            className={cn(
              "rounded-md px-3 py-1.5 text-[11.5px] font-bold text-white disabled:opacity-50",
              confirming.action === "approve" ? "bg-tertiary" : "bg-error",
            )}
          >
            {decide.isPending ? "実行中…" : "確定"}
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
                  attentionCard ? "bg-secondary" : "bg-primary",
                )}
                style={{
                  width: `${Math.round(((score ?? acRate) ?? 0) * 100)}%`,
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
        </div>
      </div>
    );
  };

  return (
    <div className="flex flex-col gap-4 rounded-lg bg-[#0F172A] p-4 sm:p-5">
      {decisionError ? (
        <p role="alert" className="rounded-md bg-error/15 px-3 py-2 text-[12.5px] text-[#FCA5A5]">
          {decisionError}
        </p>
      ) : null}

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

      {/* ── 順番待ち ── */}
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
              </li>
            ))}
          </ul>
        </div>
      ) : (
        <p className={cn("rounded-md border border-dashed border-[#334155] px-4 py-5 text-center text-[12.5px]", DARK.muted)}>
          順番待ちのタスクはありません。
        </p>
      )}
    </div>
  );
}
