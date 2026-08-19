/**
 * S-E01 フローレール (GAP-150 — COO ハブ&スポーク / ステージゲート)
 *
 * チャットの左ペイン最上部に「プロジェクトの進行フロー」を常設する。
 * 「どの社員と話すか」をユーザーに選ばせず、フローが次を指す:
 *   - ✓ 完了 / ⤼ スキップ / ● 現在 / ○ これから — seq 順の実状態
 *   - 現在ステージをクリック → 担当社員のスレッドへ (無ければ作成)
 *   - 順序外 (これから) のステージはソフトゲート — 警告つきで開ける
 *   - 現在ステージの「完了」で次へ (hard_gate = 契約/納品は明示確認必須)、
 *     skippable は理由必須でスキップ、完了済みは差し戻し可
 *   - 完了直後は「次は◯◯ — △△に繋ぎます」の引き継ぎバナー (COO 運用)
 */

"use client";

import * as React from "react";
import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import * as api from "../../../../lib/auth/connector";
import { cn } from "../../../../lib/cn";
import { useSelectedPhase } from "../../../../lib/currentPhase";

export interface FlowStage {
  readonly id: string;
  readonly stage_key: string;
  readonly seq: number;
  readonly title: string;
  readonly department: string;
  readonly status: "pending" | "done" | "skipped";
  readonly skippable: boolean;
  readonly hard_gate: boolean;
  readonly skip_reason?: string | null;
  readonly current: boolean;
  readonly employee_id?: string | null;
  readonly employee_name?: string | null;
  readonly thread_id?: string | null;
}

/** GAP-152: 納品単位のフェーズ (フェーズ1..N)。frozen = 確定済み (成果物凍結)。 */
export interface DeliveryPhase {
  readonly id: string;
  readonly seq: number;
  readonly name: string;
  readonly status: "active" | "frozen";
  readonly frozen_at?: string | null;
  readonly mock_count: number;
  readonly output_count: number;
  readonly task_count: number;
  readonly stages_done: number;
  readonly stages_total: number;
}

export interface FlowRailProps {
  readonly projectId: string;
  readonly selectedThreadId?: string | null;
  readonly onSelectThread: (threadId: string) => void;
  /** テスト注入用 (省略時は実 API)。 */
  readonly getFlowFn?: (
    projectId: string,
    phaseId?: string | null,
  ) => Promise<readonly FlowStage[]>;
  readonly postFlowFn?: (
    projectId: string,
    stageKey: string,
    action: "complete" | "skip" | "reopen",
    body: Record<string, unknown>,
  ) => Promise<readonly FlowStage[]>;
  readonly ensureThreadFn?: (
    projectId: string,
    stageKey: string,
  ) => Promise<{ thread_id: string }>;
  /** GAP-152/157: フェーズ一覧 (テスト注入用)。確定はヘッダーのスイッチャーへ移設。 */
  readonly getPhasesFn?: (projectId: string) => Promise<readonly DeliveryPhase[]>;
  /** GAP-151: 選択スレッド未指定なら現在工程の会話を自動で開く。 */
  readonly autoOpenCurrent?: boolean;
}

async function defaultGetFlow(
  projectId: string,
  phaseId?: string | null,
): Promise<readonly FlowStage[]> {
  const q = phaseId ? `?phase=${phaseId}` : "";
  return (await api.getJson<FlowStage[]>(`/projects/${projectId}/flow${q}`)).data;
}

async function defaultGetPhases(
  projectId: string,
): Promise<readonly DeliveryPhase[]> {
  return (
    await api.getJson<DeliveryPhase[]>(`/projects/${projectId}/delivery-phases`)
  ).data;
}

async function defaultPostFlow(
  projectId: string,
  stageKey: string,
  action: "complete" | "skip" | "reopen",
  body: Record<string, unknown>,
): Promise<readonly FlowStage[]> {
  // connector.sendJson は API の {data} envelope を剥がして返す
  const res = await api.sendJson<FlowStage[]>(
    "POST",
    `/projects/${projectId}/flow/${stageKey}/${action}`,
    body,
  );
  return res ?? [];
}

async function defaultEnsureThread(
  projectId: string,
  stageKey: string,
): Promise<{ thread_id: string }> {
  // GAP-151: 工程専用スレッド (無ければサーバーが作成し工程に固定する)
  const res = await api.sendJson<{ thread_id: string }>(
    "POST",
    `/projects/${projectId}/flow/${stageKey}/thread`,
  );
  if (!res?.thread_id) throw new Error("stage thread failed");
  return res;
}

function statusMark(s: FlowStage): string {
  if (s.status === "done") return "✓";
  if (s.status === "skipped") return "⤼";
  return s.current ? "●" : "○";
}

export function FlowRail({
  projectId,
  selectedThreadId,
  onSelectThread,
  getFlowFn = defaultGetFlow,
  postFlowFn = defaultPostFlow,
  ensureThreadFn = defaultEnsureThread,
  getPhasesFn = defaultGetPhases,
  autoOpenCurrent = false,
}: FlowRailProps) {
  const queryClient = useQueryClient();
  const [error, setError] = useState<string | null>(null);
  // ソフトゲート確認 / hard_gate 完了確認 / スキップ理由入力の対象 stage_key
  const [confirmOpen, setConfirmOpen] = useState<string | null>(null);
  const [hardConfirm, setHardConfirm] = useState<string | null>(null);
  const [skipFor, setSkipFor] = useState<string | null>(null);
  const [skipReason, setSkipReason] = useState("");
  // 引き継ぎバナー (完了直後の COO 案内)
  const [handoff, setHandoff] = useState<FlowStage | null>(null);
  // GAP-157: 表示フェーズはヘッダーのスイッチャーが正本 (全タブ同期)
  const viewPhaseId = useSelectedPhase(projectId);

  const phasesQuery = useQuery({
    queryKey: ["delivery-phases", projectId],
    queryFn: () => getPhasesFn(projectId),
    retry: false,
  });
  const phases = useMemo(() => phasesQuery.data ?? [], [phasesQuery.data]);
  const activePhase = phases.find((p) => p.status === "active") ?? null;
  const viewingPhase =
    (viewPhaseId ? phases.find((p) => p.id === viewPhaseId) : null) ??
    activePhase;
  const isFrozenView = viewingPhase?.status === "frozen";

  const flow = useQuery({
    queryKey: ["project-flow", projectId, viewingPhase?.id ?? "active"],
    queryFn: () => getFlowFn(projectId, isFrozenView ? viewingPhase?.id : null),
    retry: false,
  });


  const openStage = async (s: FlowStage): Promise<void> => {
    setError(null);
    if (s.thread_id) {
      onSelectThread(s.thread_id);
      return;
    }
    if (isFrozenView) {
      // GAP-152: 確定フェーズはスナップショット — 新しい会話は作らない
      return;
    }
    try {
      // GAP-151: 工程専用スレッド — 担当社員は工程 × 部門で固定 (サーバー解決)
      const ensured = await ensureThreadFn(projectId, s.stage_key);
      void queryClient.invalidateQueries({ queryKey: ["project-flow", projectId] });
      void queryClient.invalidateQueries({ queryKey: ["chat-threads"] });
      onSelectThread(ensured.thread_id);
    } catch (e) {
      setError(
        e instanceof api.ApiError && e.status === 409
          ? e.message
          : "工程の会話を開けませんでした。",
      );
    }
  };

  const act = useMutation({
    retry: false,
    mutationFn: async (args: {
      stageKey: string;
      action: "complete" | "skip" | "reopen";
      body: Record<string, unknown>;
    }) => postFlowFn(projectId, args.stageKey, args.action, args.body),
    onSuccess: (next, args) => {
      queryClient.setQueryData(["project-flow", projectId], next);
      setError(null);
      if (args.action === "complete") {
        const cur = next.find((s) => s.current) ?? null;
        setHandoff(cur);
      }
    },
    onError: (e) => {
      setError(
        e instanceof api.ApiError && (e.status === 403 || e.status === 409)
          ? e.message
          : "フローの更新に失敗しました。",
      );
    },
  });

  const stages = useMemo(() => flow.data ?? [], [flow.data]);
  const current = stages.find((s) => s.current) ?? null;

  // GAP-151: 「開くと現在工程の会話が自動で開く」— 未選択時に一度だけ
  const autoOpenedRef = React.useRef(false);
  React.useEffect(() => {
    if (!autoOpenCurrent || autoOpenedRef.current || isFrozenView) return;
    if (selectedThreadId) {
      autoOpenedRef.current = true;
      return;
    }
    if (current === null) return;
    autoOpenedRef.current = true;
    void openStage(current);
    // openStage は安定参照でないが「一度だけ」ガードで再実行しない
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoOpenCurrent, selectedThreadId, current]);

  if (
    (flow.isLoading || flow.error || stages.length === 0) &&
    phases.length === 0
  )
    return null;

  return (
    <section
      aria-label="プロジェクト進行フロー"
      className="border-b border-border bg-surface px-sm py-2"
    >
      <p className="mb-1 px-1 text-[10.5px] font-bold uppercase tracking-[0.12em] text-on-surface-variant">
        進行フロー
      </p>

      {/* GAP-157: 確定フェーズの閲覧バナー (ヘッダーで切替 — 読み取り専用スナップショット) */}
      {isFrozenView && viewingPhase ? (
        <div
          role="note"
          className="mx-1 mb-1.5 rounded-md bg-surface-variant px-2 py-1.5 text-[11px] text-on-surface"
        >
          「{viewingPhase.name}」は確定済みです（成果物 {viewingPhase.output_count} ·
          モック {viewingPhase.mock_count} · タスク {viewingPhase.task_count}
          は凍結）。
          {/* GAP-165: 「もう直せない」ではないことを明示する */}
          <span className="mt-0.5 block text-on-surface-variant">
            確定済みの版はこのまま記録として残ります。修正の依頼はできて、
            その結果は{activePhase ? `「${activePhase.name}」` : "現在のフェーズ"}
            の新しい版になります。
          </span>
        </div>
      ) : null}

      {handoff ? (
        <div
          role="status"
          className="mb-1.5 rounded-md bg-tertiary-container px-2 py-1.5 text-[11.5px] text-tertiary-container-fg"
        >
          次は「{handoff.title}」
          {handoff.employee_name ? ` — ${handoff.employee_name}に繋ぎます` : ""}
          <button
            type="button"
            onClick={() => {
              setHandoff(null);
              void openStage(handoff);
            }}
            className="ml-1.5 font-semibold underline"
          >
            開く →
          </button>
        </div>
      ) : null}
      {error ? (
        <p role="alert" className="mb-1.5 px-1 text-[11px] text-error">
          {error}
        </p>
      ) : null}
      <ol className="flex flex-col">
        {stages.map((s) => {
          const isLockedAhead = s.status === "pending" && !s.current;
          const selected =
            s.thread_id != null && s.thread_id === (selectedThreadId ?? null);
          return (
            <li key={s.id}>
              <div
                className={cn(
                  "group flex items-center gap-1.5 rounded-md px-1.5 py-1",
                  selected && "bg-primary-container/50",
                )}
              >
                <button
                  type="button"
                  onClick={() => {
                    if (isLockedAhead && !isFrozenView) {
                      setConfirmOpen(s.stage_key);
                      return;
                    }
                    void openStage(s);
                  }}
                  aria-label={`${s.title} を開く`}
                  className={cn(
                    "flex min-w-0 flex-1 items-center gap-1.5 text-left text-[12px]",
                    s.current
                      ? "font-bold text-on-surface"
                      : isLockedAhead
                        ? "text-on-surface-variant/60"
                        : "text-on-surface-variant hover:text-on-surface",
                  )}
                >
                  <span
                    aria-hidden="true"
                    className={cn(
                      "w-3 shrink-0 text-center text-[11px]",
                      s.status === "done" || s.status === "skipped"
                        ? "text-primary"
                        : s.current
                          ? "animate-pulse text-primary"
                          : "text-on-surface-variant/50",
                    )}
                  >
                    {statusMark(s)}
                  </span>
                  <span className="truncate">{s.title}</span>
                  {s.employee_name ? (
                    <span className="ml-auto shrink-0 text-[10.5px] text-on-surface-variant">
                      {s.employee_name}
                    </span>
                  ) : null}
                </button>
                {s.current && !isFrozenView ? (
                  <>
                    <button
                      type="button"
                      aria-label={`${s.title} を完了`}
                      onClick={() => {
                        if (s.hard_gate) setHardConfirm(s.stage_key);
                        else
                          act.mutate({
                            stageKey: s.stage_key,
                            action: "complete",
                            body: {},
                          });
                      }}
                      className="shrink-0 rounded-sm px-1.5 py-0.5 text-[10.5px] font-semibold text-primary hover:bg-primary-container"
                    >
                      完了
                    </button>
                    {s.skippable ? (
                      <button
                        type="button"
                        aria-label={`${s.title} をスキップ`}
                        onClick={() => {
                          setSkipFor(s.stage_key);
                          setSkipReason("");
                        }}
                        className="shrink-0 rounded-sm px-1 py-0.5 text-[10.5px] text-on-surface-variant hover:bg-surface-variant"
                      >
                        スキップ
                      </button>
                    ) : null}
                  </>
                ) : s.status !== "pending" && !isFrozenView ? (
                  <button
                    type="button"
                    aria-label={`${s.title} を差し戻す`}
                    onClick={() =>
                      act.mutate({ stageKey: s.stage_key, action: "reopen", body: {} })
                    }
                    className="shrink-0 rounded-sm px-1 py-0.5 text-[10.5px] text-on-surface-variant opacity-0 hover:bg-surface-variant group-hover:opacity-100"
                  >
                    差し戻し
                  </button>
                ) : null}
              </div>

              {/* ソフトゲート: 順序外を開く前の警告 (理由をわかって越える) */}
              {confirmOpen === s.stage_key ? (
                <div className="mx-1.5 mb-1 rounded-md bg-surface-variant px-2 py-1.5 text-[11px] text-on-surface">
                  {current
                    ? `先に「${current.title}」が残っています。順序を飛ばして開きますか？`
                    : "順序外のステージです。開きますか？"}
                  <div className="mt-1 flex justify-end gap-1.5">
                    <button
                      type="button"
                      onClick={() => setConfirmOpen(null)}
                      className="rounded-sm px-1.5 py-0.5 text-[10.5px] font-semibold text-on-surface-variant"
                    >
                      やめる
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        setConfirmOpen(null);
                        void openStage(s);
                      }}
                      className="rounded-sm bg-primary px-2 py-0.5 text-[10.5px] font-semibold text-on-primary"
                    >
                      それでも開く
                    </button>
                  </div>
                </div>
              ) : null}

              {/* hard_gate 完了の明示確認 (契約・納品) */}
              {hardConfirm === s.stage_key ? (
                <div className="mx-1.5 mb-1 rounded-md border-l-[3px] border-error bg-error/10 px-2 py-1.5 text-[11px] text-on-surface">
                  「{s.title}」は致命工程です。内容を確認のうえ完了を承認しますか？
                  <div className="mt-1 flex justify-end gap-1.5">
                    <button
                      type="button"
                      onClick={() => setHardConfirm(null)}
                      className="rounded-sm px-1.5 py-0.5 text-[10.5px] font-semibold text-on-surface-variant"
                    >
                      やめる
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        setHardConfirm(null);
                        act.mutate({
                          stageKey: s.stage_key,
                          action: "complete",
                          body: { confirm: true },
                        });
                      }}
                      className="rounded-sm bg-error px-2 py-0.5 text-[10.5px] font-semibold text-on-error"
                    >
                      承認して完了
                    </button>
                  </div>
                </div>
              ) : null}

              {/* スキップ理由の入力 (黙って消さない) */}
              {skipFor === s.stage_key ? (
                <form
                  className="mx-1.5 mb-1 rounded-md bg-surface-variant px-2 py-1.5"
                  onSubmit={(e) => {
                    e.preventDefault();
                    if (skipReason.trim() === "") return;
                    setSkipFor(null);
                    act.mutate({
                      stageKey: s.stage_key,
                      action: "skip",
                      body: { reason: skipReason.trim() },
                    });
                  }}
                >
                  <label className="block text-[11px] text-on-surface">
                    スキップ理由 (記録されます)
                    <input
                      value={skipReason}
                      onChange={(e) => setSkipReason(e.target.value)}
                      maxLength={500}
                      className="mt-0.5 w-full rounded-sm border border-border bg-surface px-1.5 py-1 text-[11.5px] text-on-surface"
                    />
                  </label>
                  <div className="mt-1 flex justify-end gap-1.5">
                    <button
                      type="button"
                      onClick={() => setSkipFor(null)}
                      className="rounded-sm px-1.5 py-0.5 text-[10.5px] font-semibold text-on-surface-variant"
                    >
                      やめる
                    </button>
                    <button
                      type="submit"
                      disabled={skipReason.trim() === ""}
                      className="rounded-sm bg-primary px-2 py-0.5 text-[10.5px] font-semibold text-on-primary disabled:opacity-50"
                    >
                      スキップする
                    </button>
                  </div>
                </form>
              ) : null}
            </li>
          );
        })}
      </ol>
    </section>
  );
}
