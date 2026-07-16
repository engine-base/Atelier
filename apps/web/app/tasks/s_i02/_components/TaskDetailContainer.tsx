/**
 * S-I02 タスク詳細 コンテナ — T-UC-15 / F-VIS 是正 (実 tasks/comments API 配線)
 *
 * 概要(GET /tasks/{id}) / 仕様(/acceptance-criteria) / 実行履歴(/executions) /
 * コメント(GET /comments?target_type=task) を取得し、モック
 * 06_mockups/task/S-I02-detail.html に忠実な「画面の役割カード + タスクヘッダ
 * (ID/タグ/ステッパー/メタ) + 6 タブ」で描画する。
 * 入出力・添付は単一の裏付け API が無いため「情報なし」を表示する。
 * api client は prop 注入可能 (テスト時に fake を渡す)。
 *
 * データ配線・props・型・container/presentational 分割は不変。JSX/className のみ
 * モック忠実へ再構築し、既存の実データ/props にバインドしている。
 */

"use client";

import * as React from "react";
import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { Check, ClipboardCheck } from "lucide-react";

import { ApiError, type ApiClient } from "@atelier/api-client";

import { Avatar } from "../../../../components/Avatar";
import { Loading } from "../../../../components/Loading";
import { createAuthedApiClient } from "../../../../lib/auth/connector";
import { cn } from "../../../../lib/cn";
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

/** 種別コード → 日本語ラベル (未知はそのまま表示)。 */
const TYPE_LABEL: Record<string, string> = {
  feature: "機能実装",
  screen: "画面実装",
  bug: "不具合修正",
  chore: "保守作業",
  infra: "基盤整備",
  docs: "ドキュメント",
};
/** 優先度コード → 日本語ラベル。 */
const PRIORITY_LABEL: Record<string, string> = {
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
  latestScore,
  execCount,
}: {
  readonly taskId: string;
  readonly task: ApiTask;
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
        <span className="rounded-sm bg-surface-variant px-2.5 py-[3px] font-mono text-label-sm font-bold text-on-surface-variant">
          {taskId}
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
      </div>

      <h1 className="mt-2 text-[22px] font-bold leading-snug tracking-tight text-on-surface">
        {task.title}
      </h1>
      {summary ? (
        <p className="mt-1.5 text-body-sm leading-relaxed text-on-surface-variant">
          {summary}
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
            task.assigned_employee_id ? (
              <>
                <Avatar
                  name={task.assigned_employee_id}
                  size="sm"
                  decorative
                />
                {task.assigned_employee_id}
              </>
            ) : (
              <span className="text-on-surface-variant">未割当</span>
            )
          }
        />
        <Meta
          label="見積(h)"
          value={
            task.estimated_hours != null ? `${task.estimated_hours} 時間` : "—"
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
      </div>
    </section>
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
  const acItemsRaw = ac.data?.items ?? [];
  const acItems = Array.isArray(acItemsRaw) ? acItemsRaw : [];
  const execsRaw = executions.data ?? [];
  const execs = Array.isArray(execsRaw) ? execsRaw : [];
  const cmtsRaw = comments.data ?? [];
  const cmts = Array.isArray(cmtsRaw) ? cmtsRaw : [];

  // 最新実行のスコア (started_at 最大)。
  const latest = execs.reduce<ApiExecution | null>((acc, e) => {
    if (!acc) return e;
    return e.started_at > acc.started_at ? e : acc;
  }, null);
  const latestScore = latest?.score ?? null;

  const content: Partial<Record<TaskTabId, React.ReactNode>> = {
    overview: (
      <div>
        <div className="text-base font-bold tracking-tight text-on-surface">
          概要
        </div>
        <p className="mt-1 mb-4 text-body-sm text-on-surface-variant">
          このタスクの基本情報です。
        </p>
        <dl className="grid gap-2.5 sm:grid-cols-2">
          {(
            [
              ["ステータス", t.lifecycle_stage ?? "—"],
              ["優先度", t.priority ?? "—"],
              ["種別", t.type ?? "—"],
              ["見積(h)", t.estimated_hours ?? "—"],
              ["担当 AI 社員", t.assigned_employee_id ?? "未割当"],
              ...(t.summary ? ([["サマリ", t.summary]] as const) : []),
            ] as const
          ).map(([label, value]) => (
            <div
              key={label}
              className="flex flex-col gap-0.5 rounded-md border border-border bg-white px-3.5 py-2.5"
            >
              <dt className="text-label-sm text-on-surface-variant">{label}</dt>
              <dd className="text-body-md font-semibold text-on-surface">
                {value}
              </dd>
            </div>
          ))}
        </dl>
        {t.description ? (
          <p className="mt-4 whitespace-pre-wrap text-body-md leading-relaxed text-on-surface">
            {t.description}
          </p>
        ) : null}
      </div>
    ),
    spec: acItems.length ? (
      <div>
        <div className="text-base font-bold tracking-tight text-on-surface">
          受入条件（{acItems.length} 項目）
        </div>
        <p className="mt-1 mb-4 text-body-sm text-on-surface-variant">
          このタスクが「完了」とみなされるための条件です。
        </p>
        <ul className="flex flex-col gap-1.5">
          {acItems.map((item, i) => (
            <li
              key={i}
              className="grid grid-cols-[28px_1fr_auto] items-center gap-3 rounded-md border border-border bg-white px-3.5 py-3"
            >
              <span
                aria-hidden="true"
                className="flex h-[22px] w-[22px] items-center justify-center rounded-full border-2 border-border"
              />
              <span className="text-body-md leading-relaxed text-on-surface">
                {typeof item === "string" ? item : JSON.stringify(item)}
              </span>
              <span className="font-mono text-label-sm text-on-surface-variant">
                条件 {i + 1}
              </span>
            </li>
          ))}
        </ul>
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
    history: execs.length ? (
      <div>
        <div className="text-base font-bold tracking-tight text-on-surface">
          実行履歴（{execs.length} 回）
        </div>
        <p className="mt-1 mb-4 text-body-sm text-on-surface-variant">
          このタスクに対する AI 社員の実行結果です。
        </p>
        <ul className="flex flex-col gap-1.5">
          {execs.map((e) => {
            const passed = e.status === "completed" || e.status === "passed";
            return (
              <li
                key={e.id}
                className="grid grid-cols-[28px_1fr_auto] items-center gap-3 rounded-md border border-border bg-white px-3.5 py-3"
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
                <div>
                  <div className="text-body-md font-semibold text-on-surface">
                    {e.status}
                  </div>
                  <div className="text-label-sm text-on-surface-variant">
                    スコア {e.score ?? "—"} / AC{" "}
                    {e.ac_pass_rate != null
                      ? `${Math.round(e.ac_pass_rate * 100)}%`
                      : "—"}
                  </div>
                </div>
                <time className="font-mono text-label-sm text-on-surface-variant">
                  {fmtTs(e.started_at)}
                </time>
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
    comments: cmts.length ? (
      <div>
        <div className="text-base font-bold tracking-tight text-on-surface">
          コメント（{cmts.length} 件）
        </div>
        <ul className="mt-4 flex flex-col gap-2.5">
          {cmts.map((c) => (
            <li
              key={c.id}
              className="rounded-md border border-border bg-white px-4 py-3.5"
            >
              <div className="flex items-center gap-2">
                <Avatar
                  name={c.author_user_id ?? "匿名"}
                  size="sm"
                  decorative
                />
                <span className="text-label-sm font-semibold text-on-surface">
                  {c.author_user_id ?? "匿名"}
                </span>
                <span className="text-label-sm text-on-surface-variant">
                  {fmtTs(c.created_at)}
                </span>
              </div>
              <p className="mt-2 whitespace-pre-wrap text-body-md leading-relaxed text-on-surface">
                {c.content}
              </p>
            </li>
          ))}
        </ul>
      </div>
    ) : (
      <p className="py-12 text-center text-body-md text-on-surface-variant">
        コメントはまだありません。
      </p>
    ),
  };

  return (
    <div className="flex flex-col gap-4">
      <RoleCard />
      <TaskHero
        taskId={taskId}
        task={t}
        latestScore={latestScore}
        execCount={execs.length}
      />
      <TaskDetailTabs title={t.title} content={content} />
    </div>
  );
}
