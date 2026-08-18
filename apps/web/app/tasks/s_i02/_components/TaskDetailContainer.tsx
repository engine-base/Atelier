/**
 * S-I02 タスク詳細 コンテナ — T-UC-15 / design-audit v2 (実 API 全面配線)
 *
 * モック 06_mockups/task/S-I02-detail.html 準拠:
 *   役割カード → タスクヘッダ (ID/タグ/ステッパー/メタ) → 5 タブ → 操作バー。
 * 配線 (すべて実 API):
 *   - GET /tasks/{id} (title/stage/priority/type/依存/blocked_reason/retry_count)
 *   - GET /tasks/{id}/acceptance-criteria (404=未登録は正常)
 *   - GET /tasks/{id}/executions (スコア/AC 達成率 → 進捗タブ + ヘッダメタ)
 *   - GET /tasks?project_id= (依存タスクのタイトル/状態解決)
 *   - GET /ai-employees (assigned_employee_id コード → 表示名解決。鉄則5)
 *   - GET/POST /comments (target_type=task) — 一覧 + 追加コンポーザ
 *   - POST /tasks/{id}/approve|reject|retry — 操作バー (2 段階確認、409 契約に
 *     従い awaiting/blocked のときだけ描画。死にボタンを置かない Rule 10)
 * GAP-025 是正 (実 API 配線):
 *   - GET /tasks/{id}/spec-changes → 「あなたへの確認」仕様変更 3 択カード
 *     (POST /tasks/{id}/spec-changes/resolve — adopt/split/discard、2 段階確認)
 *   - GET /executions/{id}/tests → テスト結果タブ (テストケース単位の実結果)
 *   - GET /tasks/{id}/related → 関連資料タブ (実リンクのみ)
 *   - 検証担当 (verifier_employee_id)・見積/経過 (実 executions 合計)・
 *     変更ファイル数 (files_changed) のメタ行
 */

"use client";

import { progressColor } from "@atelier/design-tokens";
import * as React from "react";
import { useMemo, useState } from "react";
import Link from "next/link";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  AlertTriangle,
  Check,
  ClipboardCheck,
  ExternalLink,
  RotateCcw,
  Undo2,
} from "lucide-react";

import { ApiError, type ApiClient } from "@atelier/api-client";

import { Avatar } from "../../../../components/Avatar";
import { Loading } from "../../../../components/Loading";
import { createAuthedApiClient } from "../../../../lib/auth/connector";
import { cn } from "../../../../lib/cn";
import { TaskDetailTabs, type TaskTabId } from "./TaskDetailTabs";

interface ApiTask {
  id?: string;
  project_id?: string;
  title: string;
  description?: string | null;
  summary?: string | null;
  lifecycle_stage?: string;
  priority?: string;
  type?: string;
  estimated_hours?: number;
  assigned_employee_id?: string | null;
  blocked_reason?: string | null;
  retry_count?: number;
  dependencies?: readonly string[];
  prerequisites?: readonly string[];
  blocks?: readonly string[];
  verifier_employee_id?: string | null;
  files_changed?: readonly string[];
  // GAP-140: 紐づく画面モック
  mock_id?: string | null;
  mock_screen_name?: string | null;
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
  duration_seconds?: number | null;
}
interface ApiSpecChange {
  kind: string;
  screen_name: string;
  current_version: number;
  latest_version: number;
  latest_mock_id: string;
  detected_at: string;
}
interface ApiTestResult {
  id: string;
  name: string;
  file?: string | null;
  status: string;
  duration_ms?: number | null;
  detail?: string | null;
}
interface ApiRelated {
  kind: string;
  name: string;
  meta: string;
  href?: string | null;
}
interface ApiComment {
  id: string;
  author_user_id?: string | null;
  author_invitation_id?: string | null;
  content: string;
  created_at: string;
}
interface ApiEmployee {
  id?: string;
  name: string;
  display_name?: string | null;
}
interface TaskLite {
  id: string;
  title: string;
  lifecycle_stage?: string;
}

export interface TaskDetailContainerProps {
  readonly taskId: string;
  readonly client?: ApiClient;
}

function isForbidden(error: unknown): boolean {
  return error instanceof ApiError && error.status === 403;
}

/** 種別コード → 日本語ラベル (未知はそのまま表示)。 */
const TYPE_LABEL: Record<string, string> = {
  foundation: "基盤",
  feature: "機能実装",
  screen: "画面実装",
  verification: "検証",
  infrastructure: "インフラ",
  migration: "移行",
};
/** 優先度コード → 日本語ラベル。 */
const PRIORITY_LABEL: Record<string, string> = {
  critical: "致命",
  high: "高",
  medium: "中",
  low: "低",
};

/** ステッパー 5 段 (モック: 準備中→着手可→実装中→承認待ち→完了)。
 * blocked(要対応)は例外状態のためステッパーから除外し、バッジで別表示する。 */
const STEPS = [
  { key: "backlog", label: "準備中" },
  { key: "ready", label: "着手可" },
  { key: "in_progress", label: "実装中" },
  { key: "awaiting", label: "承認待ち" },
  { key: "done", label: "完了" },
] as const;

function currentStepIndex(stage: string | undefined): number {
  if (!stage) return 0;
  if (stage === "blocked" || stage === "triage") return 2; // 実装中相当
  const i = STEPS.findIndex((s) => s.key === stage);
  return i < 0 ? 0 : i;
}

function fmtTs(iso: string): string {
  return iso.slice(0, 16).replace("T", " ");
}

/** 実行ステータス (task_execution_status_enum) → 日本語ラベル。
 * 旧実装は "completed" と比較しており実 enum (succeeded) で常に灰色になる実バグだった。 */
const EXEC_STATUS_LABEL: Record<string, string> = {
  running: "実行中",
  succeeded: "成功",
  failed: "失敗",
  cancelled: "中止",
  timeout: "タイムアウト",
};

/** AC item は文字列 or 自由形式オブジェクト。表示文字列に落とす。 */
function acItemText(item: unknown): string {
  if (typeof item === "string") return item;
  if (item && typeof item === "object") {
    const o = item as Record<string, unknown>;
    for (const key of ["text", "title", "description", "criteria"]) {
      if (typeof o[key] === "string") return o[key];
    }
    return JSON.stringify(item);
  }
  return String(item);
}

/** AC item の tier (1 構造 / 2 機能 / 3 再発防止)。無ければ null。 */
function acItemTier(item: unknown): number | null {
  if (item && typeof item === "object") {
    const t = (item as Record<string, unknown>).tier;
    if (typeof t === "number" && t >= 1 && t <= 3) return t;
  }
  return null;
}

const TIER_META: Record<number, { title: string; desc: string }> = {
  1: { title: "構造の条件", desc: "画面・要素が正しく存在するか" },
  2: { title: "機能の条件", desc: "想定どおりに動くか" },
  3: { title: "再発防止の条件", desc: "既存機能が壊れていないか" },
};

/** 画面の役割カード (モック section 1)。静的説明。 */
function RoleCard() {
  const points = [
    { n: 1, label: "何が完成すれば終わりか", desc: "受入条件の達成状況を見ます" },
    { n: 2, label: "いま、どこまで進んだか", desc: "進捗・スコア・実行ログを見ます" },
    { n: 3, label: "あなたが判断すべきこと", desc: "承認・差し戻し・再試行を行います" },
  ];
  return (
    <section className="grid grid-cols-[56px_1fr] items-start gap-[18px] rounded-lg border border-border bg-gradient-to-br from-white to-primary-container p-5">
      <div className="flex h-14 w-14 items-center justify-center rounded-md bg-primary text-on-primary">
        <ClipboardCheck size={28} strokeWidth={2} aria-hidden="true" />
      </div>
      <div>
        <div className="text-lg font-bold tracking-tight text-on-surface">
          タスク詳細
        </div>
        <p className="mt-1 text-body-sm text-on-surface-variant">
          1 つのタスクの「達成条件・進捗・あなたが下すべき判断」を 1
          画面で確認・操作する場所です。
        </p>
        <div className="mt-3.5 grid gap-3 sm:grid-cols-3">
          {points.map((p) => (
            <div key={p.n} className="rounded-md bg-white/70 px-3 py-2.5">
              <div className="mb-1.5 flex h-[22px] w-[22px] items-center justify-center rounded-full bg-primary text-label-sm font-bold text-on-primary">
                {p.n}
              </div>
              <div className="text-label-md font-bold text-on-surface">
                {p.label}
              </div>
              <div className="mt-0.5 text-body-sm leading-relaxed text-on-surface-variant">
                {p.desc}
              </div>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

/** メタ 1 項目。 */
function Meta({
  label,
  value,
}: {
  readonly label: string;
  readonly value: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-0.5">
      <span className="text-[10.5px] font-bold uppercase tracking-wider text-on-surface-variant">
        {label}
      </span>
      <span className="flex items-center gap-1.5 text-body-md font-semibold text-on-surface">
        {value}
      </span>
    </div>
  );
}

/** タスクヘッダ (モック section 2: ID/タグ/タイトル/サマリ/ステッパー/メタ)。 */
function TaskHero({
  taskId,
  task,
  assigneeLabel,
  verifierLabel,
  elapsedHours,
  latestScore,
  execCount,
}: {
  readonly taskId: string;
  readonly task: ApiTask;
  readonly assigneeLabel: string | null;
  readonly verifierLabel: string | null;
  readonly elapsedHours: number | null;
  readonly latestScore: number | null;
  readonly execCount: number;
}) {
  const typeLabel = task.type ? (TYPE_LABEL[task.type] ?? task.type) : null;
  const priorityLabel = task.priority
    ? (PRIORITY_LABEL[task.priority] ?? task.priority)
    : null;
  const isBlocked = task.lifecycle_stage === "blocked";
  const cur = currentStepIndex(task.lifecycle_stage);
  const summary = task.summary ?? task.description ?? null;

  return (
    <section className="rounded-lg border border-border bg-white p-6">
      {/* ID + タグ */}
      <div className="flex flex-wrap items-center gap-2.5">
        <span
          title={taskId}
          className="rounded-sm bg-surface-variant px-2.5 py-[3px] font-mono text-label-sm font-bold text-on-surface-variant"
        >
          #{taskId.slice(0, 8)}
        </span>
        {typeLabel ? (
          <span className="rounded-full bg-primary-container px-2.5 py-[3px] text-label-sm font-semibold text-primary-container-fg">
            {typeLabel}
          </span>
        ) : null}
        {priorityLabel ? (
          <span className="rounded-full bg-secondary-container px-2.5 py-[3px] text-label-sm font-semibold text-secondary-container-fg">
            優先度：{priorityLabel}
          </span>
        ) : null}
        {isBlocked ? (
          <span className="rounded-full bg-[#FEE2E2] px-2.5 py-[3px] text-label-sm font-semibold text-[#991B1B]">
            要対応
          </span>
        ) : null}
        {/* GAP-140: 紐づく画面モック (分解時プレースホルダー含む) */}
        {task.mock_id && task.mock_screen_name ? (
          <a
            href={`/mocks?mock=${encodeURIComponent(task.mock_id)}`}
            className="rounded-full border border-border px-2.5 py-[3px] text-label-sm font-semibold text-primary hover:bg-primary-container/30"
          >
            画面: {task.mock_screen_name} →
          </a>
        ) : null}
      </div>

      <h1 className="mt-2 text-[22px] font-bold leading-snug tracking-tight text-on-surface">
        {task.title}
      </h1>
      {summary ? (
        <p className="mt-1.5 text-body-sm leading-relaxed text-on-surface-variant">
          {summary}
        </p>
      ) : null}
      {isBlocked && task.blocked_reason ? (
        <p className="mt-2 rounded-md border-l-[3px] border-error bg-error/10 px-3 py-2 text-body-sm text-error">
          {task.blocked_reason}
        </p>
      ) : null}

      {/* ステッパー */}
      <ol className="mt-5 grid grid-cols-5" aria-label="ライフサイクル">
        {STEPS.map((s, i) => {
          const state = i < cur ? "done" : i === cur ? "current" : "todo";
          return (
            <li key={s.key} className="relative px-2 text-center">
              {i < STEPS.length - 1 ? (
                <span
                  aria-hidden="true"
                  className={cn(
                    "absolute right-[-50%] top-[13px] left-1/2 h-0.5",
                    i < cur ? "bg-tertiary" : "bg-border",
                  )}
                />
              ) : null}
              <span
                className={cn(
                  "relative z-10 mx-auto mb-1.5 flex h-7 w-7 items-center justify-center rounded-full border-2 text-label-sm font-bold",
                  state === "done" &&
                    "border-tertiary bg-tertiary text-on-tertiary",
                  state === "current" &&
                    "border-primary bg-primary text-on-primary ring-4 ring-primary/20",
                  state === "todo" &&
                    "border-border bg-white text-on-surface-variant",
                )}
              >
                {state === "done" ? (
                  <Check size={14} strokeWidth={3} aria-hidden="true" />
                ) : (
                  i + 1
                )}
              </span>
              <span
                className={cn(
                  "text-label-sm font-semibold",
                  state === "current" && "text-primary",
                  state === "done" && "text-on-surface",
                  state === "todo" && "text-on-surface-variant",
                )}
              >
                {s.label}
              </span>
            </li>
          );
        })}
      </ol>

      {/* メタ行 */}
      <div className="mt-5 flex flex-wrap gap-6 border-t border-border pt-4">
        <Meta
          label="実装担当"
          value={
            assigneeLabel ? (
              <>
                <Avatar name={assigneeLabel} size="sm" decorative />
                {assigneeLabel}
              </>
            ) : (
              <span className="text-on-surface-variant">未割当</span>
            )
          }
        />
        <Meta
          label="検証担当"
          value={
            verifierLabel ? (
              <>
                <Avatar name={verifierLabel} size="sm" decorative />
                {verifierLabel}
              </>
            ) : (
              <span className="text-on-surface-variant">未割当</span>
            )
          }
        />
        <Meta
          label="見積 / 経過"
          value={
            task.estimated_hours != null ? (
              <>
                {task.estimated_hours} 時間 /{" "}
                <span className="text-primary">
                  {elapsedHours != null ? `${elapsedHours} 時間` : "実行記録なし"}
                </span>
              </>
            ) : (
              "—"
            )
          }
        />
        <Meta
          label="変更ファイル数"
          value={
            (task.files_changed?.length ?? 0) > 0
              ? `${task.files_changed?.length} 件`
              : "記録なし"
          }
        />
        <Meta
          label="いまの達成スコア"
          value={
            latestScore != null ? (
              <span className="text-secondary">{latestScore.toFixed(2)}</span>
            ) : (
              "—"
            )
          }
        />
        <Meta label="実行回数" value={`${execCount} 回`} />
        <Meta label="再試行" value={`${task.retry_count ?? 0} / 3 回`} />
      </div>
    </section>
  );
}

/** 依存チップ (モック .dep-chip)。 */
function DepChip({
  taskRef,
  current,
}: {
  readonly taskRef: TaskLite | { id: string; title: null };
  readonly current?: boolean;
}) {
  const stage = "lifecycle_stage" in taskRef ? taskRef.lifecycle_stage : undefined;
  const done = stage === "done";
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-md border px-3.5 py-2 text-[12.5px] font-semibold",
        current
          ? "border-primary bg-primary text-on-primary shadow-sm"
          : done
            ? "border-tertiary bg-tertiary-container text-tertiary-container-fg"
            : "border-border bg-white text-on-surface",
      )}
    >
      {done ? <Check size={12} strokeWidth={3} aria-hidden="true" /> : null}
      <span className="font-mono text-[11px] opacity-70">
        #{taskRef.id.slice(0, 8)}
      </span>
      {current ? "このタスク" : (taskRef.title ?? "（参照不可）")}
    </span>
  );
}

export function TaskDetailContainer({
  taskId,
  client: injected,
}: TaskDetailContainerProps) {
  const client = useMemo(() => injected ?? createAuthedApiClient(), [injected]);
  const queryClient = useQueryClient();
  const COMMENTS_KEY = ["task", taskId, "comments"] as const;
  const [commentDraft, setCommentDraft] = useState("");
  const [confirming, setConfirming] = useState<
    "approve" | "reject" | "retry" | null
  >(null);
  const [rejectNote, setRejectNote] = useState("");
  const [decisionError, setDecisionError] = useState<string | null>(null);

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
      try {
        const res = await client.get("/tasks/{task_id}/acceptance-criteria", {
          params: { path: { task_id: taskId } },
        });
        return (res as { data?: ApiAc }).data ?? null;
      } catch (error: unknown) {
        // AC 未登録は正常状態 — 404 をエラー toast にしない (バグ #24)。
        if (error instanceof ApiError && error.status === 404) return null;
        throw error;
      }
    },
    retry: false,
  });
  const executions = useQuery({
    queryKey: ["task", taskId, "executions"],
    queryFn: async () => {
      const res = await client.get("/tasks/{task_id}/executions", {
        params: { path: { task_id: taskId } },
      });
      const d = (res as { data?: unknown }).data;
      return Array.isArray(d) ? (d as ApiExecution[]) : [];
    },
    retry: false,
  });
  const comments = useQuery({
    queryKey: COMMENTS_KEY,
    queryFn: async () => {
      const res = await client.get("/comments", {
        params: { query: { target_type: "task", target_id: taskId } },
      });
      const d = (res as { data?: unknown }).data;
      return Array.isArray(d) ? (d as ApiComment[]) : [];
    },
    retry: false,
  });
  // 担当 AI 社員コード (thor 等) → 表示名 (ソー) の解決 (鉄則5: 生コードを出さない)。
  const employees = useQuery({
    queryKey: ["ai-employees", "for-task-detail"],
    queryFn: async () => {
      const res = await client.get("/ai-employees", { params: { query: {} } });
      const d = (res as { data?: unknown }).data;
      return Array.isArray(d) ? (d as ApiEmployee[]) : [];
    },
    retry: false,
  });
  // 依存タスクのタイトル/状態解決 (同一プロジェクトの一覧から引く)。
  const projectId = task.data?.project_id;
  const projectTasks = useQuery({
    queryKey: ["tasks", "of-project", projectId],
    enabled: Boolean(projectId),
    queryFn: async () => {
      const res = await client.get("/tasks", {
        params: { query: { project_id: projectId, limit: 200 } },
      });
      const d = (res as { data?: unknown }).data;
      return Array.isArray(d) ? (d as (TaskLite & ApiTask)[]) : [];
    },
    retry: false,
  });

  // GAP-025①: 仕様変更の検知 (モック新版があるときだけカード描画)
  const specChange = useQuery({
    queryKey: ["task", taskId, "spec-change"],
    queryFn: async () => {
      const res = await client.get("/tasks/{task_id}/spec-changes", {
        params: { path: { task_id: taskId } },
      });
      return ((res as { data?: ApiSpecChange | null }).data ?? null);
    },
    retry: false,
  });
  // GAP-025③: 関連資料 (実リンクのみ)
  const related = useQuery({
    queryKey: ["task", taskId, "related"],
    queryFn: async () => {
      const res = await client.get("/tasks/{task_id}/related", {
        params: { path: { task_id: taskId } },
      });
      const d = (res as { data?: unknown }).data;
      return Array.isArray(d) ? (d as ApiRelated[]) : [];
    },
    retry: false,
  });
  // GAP-025②: 最新実行のテストケース単位結果
  const latestExecId = (executions.data ?? []).reduce<ApiExecution | null>(
    (acc, e) => (!acc || e.started_at > acc.started_at ? e : acc),
    null,
  )?.id;
  const testResults = useQuery({
    queryKey: ["execution", latestExecId, "tests"],
    enabled: Boolean(latestExecId),
    queryFn: async () => {
      const res = await client.get("/executions/{execution_id}/tests", {
        params: { path: { execution_id: latestExecId ?? "" } },
      });
      const d = (res as { data?: unknown }).data;
      return Array.isArray(d) ? (d as ApiTestResult[]) : [];
    },
    retry: false,
  });

  // GAP-025①: 3 択の実行 (2 段階確認は specConfirm で)
  const [specConfirm, setSpecConfirm] = useState<
    "adopt" | "split" | "discard" | null
  >(null);
  const [specNotice, setSpecNotice] = useState<string | null>(null);
  const resolveSpec = useMutation({
    mutationFn: ({ choice }: { choice: "adopt" | "split" | "discard" }) =>
      client.post("/tasks/{task_id}/spec-changes/resolve", {
        params: { path: { task_id: taskId } },
        body: { choice, latest_mock_id: specChange.data?.latest_mock_id ?? "" },
      }),
    onSuccess: (res: unknown) => {
      setSpecConfirm(null);
      setSpecNotice((res as { data?: { note?: string } }).data?.note ?? "反映しました");
      void queryClient.invalidateQueries({ queryKey: ["task", taskId] });
    },
    onError: () => {
      setSpecConfirm(null);
      setSpecNotice(null);
      setDecisionError("仕様変更の反映に失敗しました。時間をおいて再試行してください。");
    },
  });

  // 操作バー: 承認 (awaiting→done) / 差戻 (awaiting→blocked) / 再試行 (blocked→ready)。
  const decide = useMutation({
    mutationFn: ({
      action,
      note,
    }: {
      action: "approve" | "reject" | "retry";
      note?: string;
    }) =>
      client.post(`/tasks/{task_id}/${action}` as "/tasks/{task_id}/approve", {
        params: { path: { task_id: taskId } },
        body: note ? { note } : {},
      }),
    onSuccess: () => {
      setConfirming(null);
      setRejectNote("");
      setDecisionError(null);
      void queryClient.invalidateQueries({ queryKey: ["task", taskId] });
      void queryClient.invalidateQueries({ queryKey: ["tasks"] });
    },
    onError: (error: unknown) => {
      setDecisionError(
        error instanceof ApiError && error.status === 409
          ? "タスクの状態が変わったため実行できませんでした。再読み込みしてください。"
          : "操作に失敗しました。時間をおいて再試行してください。",
      );
    },
  });

  // コメント追加 (POST /comments target_type=task)。
  const addComment = useMutation({
    mutationFn: (text: string) =>
      client.post("/comments", {
        body: { target_type: "task", target_id: taskId, content: text },
      }),
    onSuccess: () => {
      setCommentDraft("");
      void queryClient.invalidateQueries({ queryKey: COMMENTS_KEY });
    },
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
  const acItemsRaw = ac.data?.items ?? [];
  const acItems = Array.isArray(acItemsRaw) ? acItemsRaw : [];
  const execs = executions.data ?? [];
  const cmts = comments.data ?? [];

  const employeeName = (code: string | null | undefined): string | null => {
    if (!code) return null;
    const hit = (employees.data ?? []).find((e) => e.name === code);
    return hit?.display_name || code;
  };

  // 最新実行のスコア (started_at 最大)。
  const latest = execs.reduce<ApiExecution | null>((acc, e) => {
    if (!acc) return e;
    return e.started_at > acc.started_at ? e : acc;
  }, null);
  const latestScore = latest?.score ?? null;
  const latestAcRate = latest?.ac_pass_rate ?? null;

  const taskById = new Map<string, TaskLite>(
    (projectTasks.data ?? []).map((pt) => [pt.id, pt]),
  );
  const resolveDep = (id: string): TaskLite | { id: string; title: null } =>
    taskById.get(id) ?? { id, title: null };
  const prereqIds = [
    ...new Set([...(t.prerequisites ?? []), ...(t.dependencies ?? [])]),
  ];
  const blockIds = [...new Set(t.blocks ?? [])];

  const stage = t.lifecycle_stage;
  const canDecide = stage === "awaiting";
  const canRetry = stage === "blocked" && (t.retry_count ?? 0) < 3;

  const authorLabel = (c: ApiComment): string => {
    if (c.author_invitation_id) return "クライアント（招待）";
    if (c.author_user_id) return `メンバー ${c.author_user_id.slice(0, 8)}`;
    return "匿名";
  };

  const content: Partial<Record<TaskTabId, React.ReactNode>> = {
    ac: acItems.length ? (
      <div>
        <div className="text-base font-bold tracking-tight text-on-surface">
          受入条件（{acItems.length} 項目）
        </div>
        <p className="mt-1 mb-4 text-body-sm text-on-surface-variant">
          このタスクが「完了」とみなされるための条件です。
        </p>
        {([1, 2, 3] as const).map((tier) => {
          const items = acItems
            .map((item, i) => ({ item, i }))
            .filter(({ item }) => acItemTier(item) === tier);
          if (!items.length) return null;
          return (
            <div key={tier} className="mb-5 last:mb-0">
              <div className="mb-2.5 flex items-center gap-2.5">
                <span className="flex h-6 w-6 items-center justify-center rounded-full bg-on-surface text-label-sm font-bold text-white">
                  {tier}
                </span>
                <span className="text-body-md font-bold text-on-surface">
                  {TIER_META[tier]!.title}
                </span>
                <span className="ml-auto text-label-sm text-on-surface-variant">
                  {TIER_META[tier]!.desc}
                </span>
              </div>
              <ul className="flex flex-col gap-1.5">
                {items.map(({ item, i }) => (
                  <li
                    key={i}
                    className="grid grid-cols-[28px_1fr_auto] items-center gap-3 rounded-md border border-border bg-white px-3.5 py-3"
                  >
                    <span
                      aria-hidden="true"
                      className="flex h-[22px] w-[22px] items-center justify-center rounded-full border-2 border-border"
                    />
                    <span className="text-body-md leading-relaxed text-on-surface">
                      {acItemText(item)}
                    </span>
                    <span className="font-mono text-label-sm text-on-surface-variant">
                      条件 {i + 1}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          );
        })}
        {/* tier 情報が無い item は通しで並べる */}
        {acItems.some((item) => acItemTier(item) === null) ? (
          <ul className="flex flex-col gap-1.5">
            {acItems
              .map((item, i) => ({ item, i }))
              .filter(({ item }) => acItemTier(item) === null)
              .map(({ item, i }) => (
                <li
                  key={i}
                  className="grid grid-cols-[28px_1fr_auto] items-center gap-3 rounded-md border border-border bg-white px-3.5 py-3"
                >
                  <span
                    aria-hidden="true"
                    className="flex h-[22px] w-[22px] items-center justify-center rounded-full border-2 border-border"
                  />
                  <span className="text-body-md leading-relaxed text-on-surface">
                    {acItemText(item)}
                  </span>
                  <span className="font-mono text-label-sm text-on-surface-variant">
                    条件 {i + 1}
                  </span>
                </li>
              ))}
          </ul>
        ) : null}
        {ac.data?.version != null ? (
          <p className="mt-3 text-label-sm text-on-surface-variant">
            受入条件バージョン {ac.data.version}
          </p>
        ) : null}
      </div>
    ) : (
      <p className="py-12 text-center text-body-md text-on-surface-variant">
        受入条件は登録されていません。
      </p>
    ),
    progress: (
      <div>
        <div className="text-base font-bold tracking-tight text-on-surface">
          いまの達成スコア
        </div>
        <p className="mt-1 mb-4 text-body-sm text-on-surface-variant">
          検証 AI による最新実行の評価です。
        </p>
        {latest ? (
          <div className="grid gap-7 rounded-lg border border-border bg-surface p-6 sm:grid-cols-[220px_1fr]">
            <div className="text-center">
              <div
                role="img"
                aria-label={`達成スコア ${latestScore != null ? latestScore.toFixed(2) : "未評価"}`}
                className="relative mx-auto flex h-[180px] w-[180px] items-center justify-center rounded-full"
                style={{
                  background: `conic-gradient(#B45309 0% ${Math.round((latestScore ?? 0) * 100)}%, #E7E5E4 ${Math.round((latestScore ?? 0) * 100)}% 100%)`,
                }}
              >
                <span className="absolute inset-3.5 rounded-full bg-white" />
                <span className="relative text-center">
                  <span className="block text-[44px] font-black leading-none tracking-tight text-secondary tabular-nums">
                    {latestScore != null ? latestScore.toFixed(2) : "—"}
                  </span>
                  <span className="mt-1 block text-label-sm font-semibold text-on-surface-variant">
                    / 1.00
                  </span>
                </span>
              </div>
              <p className="mt-3 text-body-sm font-bold text-secondary">
                {stage === "awaiting"
                  ? "承認待ち（要・人間の確認）"
                  : stage === "done"
                    ? "完了"
                    : stage === "blocked"
                      ? "要対応"
                      : "実行中"}
              </p>
            </div>
            <div className="flex flex-col justify-center gap-3.5">
              <div className="grid grid-cols-[110px_1fr_64px] items-center gap-3">
                <span className="text-body-sm font-semibold text-on-surface">
                  受入条件の達成
                </span>
                <span className="h-2 overflow-hidden rounded-full bg-surface-variant">
                  <span
                    className="block h-full rounded-full"
                    style={{
                      width: `${Math.round((latestAcRate ?? 0) * 100)}%`,
                      backgroundColor: progressColor(latestAcRate ?? 0),
                    }}
                  />
                </span>
                <span className="text-right text-body-md font-bold tabular-nums text-on-surface">
                  {latestAcRate != null
                    ? `${Math.round(latestAcRate * 100)}%`
                    : "—"}
                </span>
              </div>
              <div className="grid grid-cols-[110px_1fr_64px] items-center gap-3">
                <span className="text-body-sm font-semibold text-on-surface">
                  検証 AI の評価
                </span>
                <span className="h-2 overflow-hidden rounded-full bg-surface-variant">
                  <span
                    className="block h-full rounded-full"
                    style={{
                      width: `${Math.round((latestScore ?? 0) * 100)}%`,
                      backgroundColor: progressColor(latestScore ?? 0),
                    }}
                  />
                </span>
                <span className="text-right text-body-md font-bold tabular-nums text-on-surface">
                  {latestScore != null ? latestScore.toFixed(2) : "—"}
                </span>
              </div>
              <p className="mt-1 flex items-center gap-2.5 rounded-md bg-primary-container px-4 py-3 text-body-sm text-primary-container-fg">
                再試行は最大 3 回まで実行可能（現在 {t.retry_count ?? 0} / 3
                回）。最新実行: {fmtTs(latest.started_at)}
              </p>
            </div>
          </div>
        ) : (
          <p className="py-12 text-center text-body-md text-on-surface-variant">
            まだ実行がありません。実行後にスコアが表示されます。
          </p>
        )}
      </div>
    ),
    deps: (
      <div>
        <div className="text-base font-bold tracking-tight text-on-surface">
          前後のタスクとのつながり
        </div>
        <p className="mt-1 mb-4 text-body-sm text-on-surface-variant">
          このタスクを始めるために必要なタスク、そしてこのタスクの完了を待っているタスクです。
        </p>
        <div className="mb-5">
          <div className="mb-2 flex items-baseline gap-2.5">
            <span className="text-body-md font-bold text-on-surface">
              前提タスク
            </span>
            <span className="text-label-sm text-on-surface-variant">
              先に終わっている必要があるタスク（{prereqIds.length} 件）
            </span>
          </div>
          <div className="flex flex-wrap items-center gap-2 rounded-md border border-border bg-surface px-4 py-3.5">
            {prereqIds.length ? (
              <>
                {prereqIds.map((id) => (
                  <React.Fragment key={id}>
                    <DepChip taskRef={resolveDep(id)} />
                    <span
                      aria-hidden="true"
                      className="text-on-surface-variant"
                    >
                      →
                    </span>
                  </React.Fragment>
                ))}
                <DepChip taskRef={{ id: taskId, title: null }} current />
              </>
            ) : (
              <span className="text-body-sm text-on-surface-variant">
                前提タスクはありません。
              </span>
            )}
          </div>
        </div>
        <div>
          <div className="mb-2 flex items-baseline gap-2.5">
            <span className="text-body-md font-bold text-on-surface">
              後続タスク
            </span>
            <span className="text-label-sm text-on-surface-variant">
              このタスクの完了を待っているタスク（{blockIds.length} 件）
            </span>
          </div>
          <div className="flex flex-wrap items-center gap-2 rounded-md border border-border bg-surface px-4 py-3.5">
            {blockIds.length ? (
              <>
                <DepChip taskRef={{ id: taskId, title: null }} current />
                <span aria-hidden="true" className="text-on-surface-variant">
                  →
                </span>
                {blockIds.map((id) => (
                  <DepChip key={id} taskRef={resolveDep(id)} />
                ))}
              </>
            ) : (
              <span className="text-body-sm text-on-surface-variant">
                後続タスクはありません。
              </span>
            )}
          </div>
        </div>
      </div>
    ),
    history: execs.length ? (
      <div>
        <div className="text-base font-bold tracking-tight text-on-surface">
          実行履歴（{execs.length} 回）
        </div>
        <p className="mt-1 mb-4 text-body-sm text-on-surface-variant">
          このタスクに対する AI 社員の実行結果です。行を開くと実行モニター
          (S-I03) でログを確認できます。
        </p>
        <ul className="flex flex-col gap-1.5">
          {execs.map((e) => {
            const passed = e.status === "succeeded";
            return (
              <li key={e.id}>
                <Link
                  href={`/tasks/monitor?execution=${e.id}`}
                  className="grid grid-cols-[28px_1fr_auto] items-center gap-3 rounded-md border border-border bg-white px-3.5 py-3 transition-colors hover:border-primary hover:bg-primary-container/20"
                >
                  <span
                    className={cn(
                      "flex h-[22px] w-[22px] items-center justify-center rounded-full",
                      passed
                        ? "bg-tertiary text-on-tertiary"
                        : "bg-surface-variant text-on-surface-variant",
                    )}
                  >
                    {passed ? (
                      <Check size={12} strokeWidth={3} aria-hidden="true" />
                    ) : null}
                  </span>
                  <span>
                    <span className="block text-body-md font-semibold text-on-surface">
                      {EXEC_STATUS_LABEL[e.status] ?? e.status}
                    </span>
                    <span className="block text-label-sm text-on-surface-variant">
                      スコア {e.score ?? "—"} / AC{" "}
                      {e.ac_pass_rate != null
                        ? `${Math.round(e.ac_pass_rate * 100)}%`
                        : "—"}
                    </span>
                  </span>
                  <time className="font-mono text-label-sm text-on-surface-variant">
                    {fmtTs(e.started_at)}
                  </time>
                </Link>
              </li>
            );
          })}
        </ul>
      </div>
    ) : (
      <p className="py-12 text-center text-body-md text-on-surface-variant">
        実行履歴はまだありません。
      </p>
    ),
    comments: (
      <div>
        <div className="text-base font-bold tracking-tight text-on-surface">
          コメント（{cmts.length} 件）
        </div>
        {cmts.length ? (
          <ul className="mt-4 flex flex-col gap-2.5">
            {cmts.map((c) => (
              <li
                key={c.id}
                className="rounded-md border border-border bg-white px-4 py-3.5"
              >
                <div className="flex items-center gap-2">
                  <Avatar name={authorLabel(c)} size="sm" decorative />
                  <span className="text-label-sm font-semibold text-on-surface">
                    {authorLabel(c)}
                  </span>
                  <span className="text-label-sm tabular-nums text-on-surface-variant">
                    {fmtTs(c.created_at)}
                  </span>
                </div>
                <p className="mt-2 whitespace-pre-wrap text-body-md leading-relaxed text-on-surface">
                  {c.content}
                </p>
              </li>
            ))}
          </ul>
        ) : (
          <p className="py-8 text-center text-body-md text-on-surface-variant">
            コメントはまだありません。
          </p>
        )}
        <form
          className="mt-4 rounded-md bg-surface-variant p-3"
          onSubmit={(e) => {
            e.preventDefault();
            const text = commentDraft.trim();
            if (text) addComment.mutate(text);
          }}
        >
          <label className="block">
            <span className="sr-only">コメントを追加</span>
            <textarea
              value={commentDraft}
              onChange={(e) => setCommentDraft(e.target.value)}
              rows={2}
              placeholder="コメントを追加…"
              className="w-full resize-none border-0 bg-transparent text-[13px] text-on-surface outline-none placeholder:text-on-surface-variant"
            />
          </label>
          <div className="mt-2 flex justify-end">
            <button
              type="submit"
              disabled={!commentDraft.trim() || addComment.isPending}
              className="inline-flex items-center rounded-md bg-primary px-4 py-1.5 text-[12px] font-semibold text-on-primary transition-colors hover:bg-primary-hover disabled:opacity-50"
            >
              コメント
            </button>
          </div>
        </form>
      </div>
    ),
  };

  // GAP-025②: テスト結果タブ (最新実行のテストケース単位結果)
  const tests = testResults.data ?? [];
  const testPass = tests.filter((x) => x.status === "pass").length;
  content.tests = tests.length ? (
    <div>
      <div className="text-base font-bold tracking-tight text-on-surface">
        テスト結果（{testPass} / {tests.length} 合格）
      </div>
      <p className="mt-1 mb-4 text-body-sm text-on-surface-variant">
        最新の実行で記録されたテストケース単位の結果です。
      </p>
      <ul role="list" className="flex flex-col gap-1.5">
        {tests.map((x) => (
          <li
            key={x.id}
            className={cn(
              "flex items-center gap-3 rounded-md border px-3.5 py-2.5",
              x.status === "pass"
                ? "border-border bg-white"
                : x.status === "fail"
                  ? "border-error/40 bg-error/5"
                  : "border-border bg-surface-variant",
            )}
          >
            <span
              aria-hidden="true"
              className={cn(
                "flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-[10px] font-bold text-white",
                x.status === "pass"
                  ? "bg-tertiary"
                  : x.status === "fail"
                    ? "bg-error"
                    : "bg-neutral",
              )}
            >
              {x.status === "pass" ? "✓" : x.status === "fail" ? "✕" : "−"}
            </span>
            <div className="min-w-0 flex-1">
              <div className="text-[13px] font-semibold text-on-surface">
                {x.name}
              </div>
              {x.file ? (
                <div className="font-mono text-[11px] text-on-surface-variant">
                  {x.file}
                </div>
              ) : null}
              {x.detail ? (
                <div className="text-[11.5px] text-error">{x.detail}</div>
              ) : null}
            </div>
            {x.duration_ms != null ? (
              <span className="shrink-0 text-[11.5px] tabular-nums text-on-surface-variant">
                {(x.duration_ms / 1000).toFixed(1)} 秒
              </span>
            ) : null}
          </li>
        ))}
      </ul>
    </div>
  ) : (
    <p className="py-12 text-center text-body-md text-on-surface-variant">
      テスト単位の結果はまだ記録されていません。Bridge の実行完了時に記録されます。
    </p>
  );

  // GAP-025③: 関連資料タブ (実リンクのみ — モック .resource-grid 準拠)
  const relatedItems = related.data ?? [];
  content.resources = relatedItems.length ? (
    <div>
      <div className="text-base font-bold tracking-tight text-on-surface">
        このタスクに紐づく資料
      </div>
      <p className="mt-1 mb-4 text-body-sm text-on-surface-variant">
        実際に紐づいている資料のみを表示します。
      </p>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        {relatedItems.map((r, i) => {
          const inner = (
            <>
              <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-md bg-primary-container text-primary">
                <ClipboardCheck size={20} aria-hidden="true" />
              </div>
              <div className="min-w-0">
                <div className="truncate text-[13px] font-bold text-on-surface">
                  {r.name}
                </div>
                <div className="text-[11.5px] text-on-surface-variant">
                  {r.meta}
                </div>
              </div>
              {r.href ? (
                <ExternalLink
                  size={13}
                  aria-hidden="true"
                  className="ml-auto shrink-0 text-on-surface-variant"
                />
              ) : null}
            </>
          );
          return r.href ? (
            <Link
              key={`${r.kind}-${i}`}
              href={r.href}
              className="flex items-center gap-3 rounded-md border border-border bg-white px-4 py-3 transition-colors hover:border-primary"
            >
              {inner}
            </Link>
          ) : (
            <div
              key={`${r.kind}-${i}`}
              className="flex items-center gap-3 rounded-md border border-border bg-white px-4 py-3"
            >
              {inner}
            </div>
          );
        })}
      </div>
    </div>
  ) : (
    <p className="py-12 text-center text-body-md text-on-surface-variant">
      紐づく資料はまだありません。
    </p>
  );

  const counts: Partial<Record<TaskTabId, string>> = {
    ...(acItems.length ? { ac: String(acItems.length) } : {}),
    ...(prereqIds.length + blockIds.length
      ? { deps: String(prereqIds.length + blockIds.length) }
      : {}),
    ...(tests.length ? { tests: `${testPass} / ${tests.length}` } : {}),
    ...(execs.length ? { history: String(execs.length) } : {}),
    ...(relatedItems.length ? { resources: String(relatedItems.length) } : {}),
    ...(cmts.length ? { comments: String(cmts.length) } : {}),
  };

  // GAP-025④: 経過 = 実 executions の実測 duration 合計 (時間、1 桁)
  const totalSeconds = execs.reduce(
    (acc, e) => acc + (e.duration_seconds ?? 0),
    0,
  );
  const elapsedHours =
    totalSeconds > 0 ? Math.round((totalSeconds / 3600) * 10) / 10 : null;
  const verifierLabel = t.verifier_employee_id
    ? ((employees.data ?? []).find((e) => e.id === t.verifier_employee_id)
        ?.display_name ?? null)
    : null;

  return (
    <div className="flex flex-col gap-4">
      <RoleCard />
      <TaskHero
        taskId={taskId}
        task={t}
        assigneeLabel={employeeName(t.assigned_employee_id)}
        verifierLabel={verifierLabel}
        elapsedHours={elapsedHours}
        latestScore={latestScore}
        execCount={execs.length}
      />

      {/* ── あなたへの確認: 仕様変更 3 択 (GAP-025① — 実検知時のみ描画) ── */}
      {specNotice ? (
        <p
          role="status"
          className="rounded-md border border-tertiary bg-tertiary-container/40 px-4 py-3 text-[12.5px] text-on-surface"
        >
          {specNotice}
        </p>
      ) : null}
      {specChange.data ? (
        <section className="rounded-lg border border-secondary bg-secondary-container/30 p-5">
          <div className="flex items-center gap-2.5">
            <span className="flex h-7 w-7 items-center justify-center rounded-md bg-secondary text-white">
              <AlertTriangle size={14} aria-hidden="true" />
            </span>
            <strong className="text-[14px] text-on-surface">
              あなたへの確認：仕様変更が検知されました
            </strong>
          </div>
          <p className="mt-2 text-[13px] leading-relaxed text-on-surface-variant">
            紐づくモック「{specChange.data.screen_name}」に新しいバージョン
            (v{specChange.data.current_version} → v{specChange.data.latest_version})
            がアップロードされています。このタスクへの取り込み方を 3 択から選んでください。
          </p>
          {specConfirm ? (
            <div className="mt-3 flex flex-wrap items-center gap-2">
              <span className="text-[12.5px] font-semibold text-on-surface">
                {specConfirm === "adopt"
                  ? "最新仕様 (新しいモック) をこのタスクに取り込みますか？"
                  : specConfirm === "split"
                    ? "現状のまま、追加対応を別タスクとして起票しますか？"
                    : "作業を破棄して再分解待ち (blocked) にしますか？"}
              </span>
              <button
                type="button"
                onClick={() => setSpecConfirm(null)}
                className="rounded-md border border-border px-3 py-1.5 text-[12px] font-semibold text-on-surface-variant hover:bg-surface-variant"
              >
                キャンセル
              </button>
              <button
                type="button"
                disabled={resolveSpec.isPending}
                onClick={() => resolveSpec.mutate({ choice: specConfirm })}
                className="rounded-md bg-primary px-3.5 py-1.5 text-[12px] font-bold text-on-primary disabled:opacity-50"
              >
                {resolveSpec.isPending ? "反映中…" : "確定"}
              </button>
            </div>
          ) : (
            <div className="mt-3 grid grid-cols-1 gap-2 sm:grid-cols-3">
              {(
                [
                  [
                    "adopt",
                    "最新仕様で実装し直す",
                    "紐づくモックを最新バージョンに差し替えます（推奨）。",
                  ],
                  [
                    "split",
                    "現状の実装で完了にする",
                    "追加対応は別タスクとして起票します。",
                  ],
                  [
                    "discard",
                    "破棄して分解からやり直す",
                    "作業を破棄し、再分解待ち (blocked) にします。",
                  ],
                ] as const
              ).map(([key, title, desc]) => (
                <button
                  key={key}
                  type="button"
                  onClick={() => setSpecConfirm(key)}
                  className="rounded-md border border-border bg-white px-4 py-3 text-left transition-colors hover:border-primary"
                >
                  <div className="text-[13px] font-bold text-on-surface">{title}</div>
                  <div className="mt-0.5 text-[11.5px] text-on-surface-variant">
                    {desc}
                  </div>
                </button>
              ))}
            </div>
          )}
        </section>
      ) : null}

      <TaskDetailTabs title={t.title} content={content} counts={counts} />

      {/* ── 操作バー (モック .action-bar)。awaiting/blocked のときだけ描画 — 死にボタンを置かない ── */}
      {canDecide || canRetry ? (
        <div className="sticky bottom-5 flex flex-wrap items-center gap-3 rounded-lg border border-border bg-white px-5 py-3.5 shadow-md">
          <div className="min-w-0">
            <div className="text-[12.5px] font-bold text-on-surface">
              このタスクに対するあなたの判断
            </div>
            <div className="text-[11.5px] text-on-surface-variant">
              {canDecide
                ? latestScore != null
                  ? `スコア ${latestScore.toFixed(2)} は「人間の確認が必要」な水準です。`
                  : "承認するか、差し戻すかを選んでください。"
                : `要対応のタスクです（再試行 ${t.retry_count ?? 0} / 3 回）。`}
            </div>
            {decisionError ? (
              <p role="alert" className="mt-1 text-[11.5px] text-error">
                {decisionError}
              </p>
            ) : null}
          </div>
          <div className="ml-auto flex flex-wrap items-center gap-2">
            {confirming === null ? (
              <>
                {canRetry ? (
                  <button
                    type="button"
                    onClick={() => setConfirming("retry")}
                    className="inline-flex items-center gap-1.5 rounded-md bg-primary-container px-4 py-2.5 text-[13px] font-bold text-primary-container-fg transition-colors hover:bg-primary hover:text-on-primary"
                  >
                    <RotateCcw size={14} aria-hidden="true" />
                    再試行
                  </button>
                ) : null}
                {canDecide ? (
                  <>
                    <button
                      type="button"
                      onClick={() => setConfirming("reject")}
                      className="inline-flex items-center gap-1.5 rounded-md border border-border bg-white px-4 py-2.5 text-[13px] font-semibold text-on-surface transition-colors hover:bg-surface-variant"
                    >
                      <Undo2 size={14} aria-hidden="true" />
                      差し戻し
                    </button>
                    <button
                      type="button"
                      onClick={() => setConfirming("approve")}
                      className="inline-flex items-center gap-1.5 rounded-md bg-tertiary px-5 py-2.5 text-[13.5px] font-bold text-on-tertiary transition-[filter] hover:brightness-110"
                    >
                      <Check size={16} aria-hidden="true" />
                      承認する
                    </button>
                  </>
                ) : null}
              </>
            ) : (
              <div className="flex flex-wrap items-center gap-2">
                {confirming === "reject" ? (
                  <input
                    value={rejectNote}
                    onChange={(e) => setRejectNote(e.target.value)}
                    placeholder="差し戻し理由 (任意)"
                    aria-label="差し戻し理由"
                    className="w-[220px] rounded-md border border-border px-3 py-2 text-[12.5px] text-on-surface outline-none focus:border-primary"
                  />
                ) : null}
                <span className="text-[12px] font-semibold text-on-surface">
                  {confirming === "approve"
                    ? "承認して完了にしますか？"
                    : confirming === "reject"
                      ? "差し戻して要対応にしますか？"
                      : "再試行して着手可に戻しますか？"}
                </span>
                <button
                  type="button"
                  onClick={() => {
                    setConfirming(null);
                    setRejectNote("");
                  }}
                  className="rounded-md border border-border px-3 py-2 text-[12.5px] font-semibold text-on-surface hover:bg-surface-variant"
                >
                  キャンセル
                </button>
                <button
                  type="button"
                  disabled={decide.isPending}
                  onClick={() =>
                    decide.mutate({
                      action: confirming,
                      note:
                        confirming === "reject" && rejectNote.trim()
                          ? rejectNote.trim()
                          : undefined,
                    })
                  }
                  className={cn(
                    "rounded-md px-4 py-2 text-[12.5px] font-bold text-white transition-[filter] hover:brightness-110 disabled:opacity-50",
                    confirming === "approve" ? "bg-tertiary" : "bg-error",
                  )}
                >
                  {decide.isPending ? "実行中…" : "確定"}
                </button>
              </div>
            )}
          </div>
        </div>
      ) : null}
    </div>
  );
}
