/**
 * GAP-157 — ヘッダーのフェーズスイッチャー (プロジェクト文脈で常設)。
 *
 * 経営者指示「フェーズはヘッダーで画面全体を切り替える」:
 *   - ピル = 表示中フェーズ (現在 or 確定済みスナップショット)。クリックで一覧
 *   - フェーズを選ぶと全タブ (進行 / モック / タスク) が追従する (useSelectedPhase)
 *   - 現在フェーズの「確定して次へ」もここ (明示承認つき — GAP-152 の hard gate 運用)
 */

"use client";

import * as React from "react";
import { useEffect, useRef, useState } from "react";
import { ChevronDown, Layers } from "lucide-react";

import * as api from "../../lib/auth/connector";
import { cn } from "../../lib/cn";
import { useSelectedPhase, writeSelectedPhase } from "../../lib/currentPhase";

export interface PhaseLite {
  readonly id: string;
  readonly seq: number;
  readonly name: string;
  readonly status: "active" | "frozen";
  readonly mock_count: number;
  readonly output_count: number;
  readonly task_count: number;
}

export interface PhaseSwitcherProps {
  readonly projectId: string;
  /** テスト注入用 (省略時は実 API)。 */
  readonly getPhasesFn?: (projectId: string) => Promise<readonly PhaseLite[]>;
  readonly freezePhaseFn?: (
    projectId: string,
    phaseId: string,
    note?: string,
  ) => Promise<readonly PhaseLite[]>;
  /** GAP-165: 確定前チェック (未完了の工程・タスク・未解決コメント)。 */
  readonly freezeCheckFn?: (projectId: string, phaseId: string) => Promise<FreezeCheck>;
}

async function defaultGetPhases(projectId: string): Promise<readonly PhaseLite[]> {
  return (await api.getJson<PhaseLite[]>(`/projects/${projectId}/delivery-phases`))
    .data;
}

export interface FreezeCheck {
  readonly phase_name: string;
  readonly pending_stages: readonly string[];
  readonly open_tasks: number;
  readonly unresolved_comments: number;
  readonly output_count: number;
  readonly mock_count: number;
  readonly warnings: readonly string[];
}

async function defaultFreezeCheck(
  projectId: string,
  phaseId: string,
): Promise<FreezeCheck> {
  return (
    await api.getJson<FreezeCheck>(
      `/projects/${projectId}/delivery-phases/${phaseId}/freeze-check`,
    )
  ).data;
}

async function defaultFreezePhase(
  projectId: string,
  phaseId: string,
  note?: string,
): Promise<readonly PhaseLite[]> {
  const res = await api.sendJson<PhaseLite[]>(
    "POST",
    `/projects/${projectId}/delivery-phases/${phaseId}/freeze`,
    { confirm: true, ...(note ? { note } : {}) },
  );
  return res ?? [];
}

export function PhaseSwitcher({
  projectId,
  getPhasesFn = defaultGetPhases,
  freezePhaseFn = defaultFreezePhase,
  freezeCheckFn = defaultFreezeCheck,
}: PhaseSwitcherProps) {
  const [phases, setPhases] = useState<readonly PhaseLite[]>([]);
  const [open, setOpen] = useState(false);
  const [freezeConfirm, setFreezeConfirm] = useState(false);
  // GAP-165: 確定していいかの判断材料 (実データ)。null = 取得中
  const [check, setCheck] = useState<FreezeCheck | null>(null);
  const [freezeNote, setFreezeNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const selectedId = useSelectedPhase(projectId);

  useEffect(() => {
    let cancelled = false;
    getPhasesFn(projectId)
      .then((d) => {
        if (!cancelled) setPhases(d);
      })
      .catch(() => {
        /* フェーズ未取得ならピル非表示のまま (シェルは継続) */
      });
    return () => {
      cancelled = true;
    };
  }, [projectId, getPhasesFn]);

  useEffect(() => {
    // 外側クリックで閉じる
    const onDown = (ev: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(ev.target as Node)) {
        setOpen(false);
        setFreezeConfirm(false);
      }
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, []);

  if (phases.length === 0) return null;
  const active = phases.find((p) => p.status === "active") ?? null;
  const viewing =
    (selectedId ? phases.find((p) => p.id === selectedId) : null) ?? active;
  if (viewing === null) return null;
  const isSnapshot = viewing.status === "frozen";

  return (
    <div ref={rootRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-label={`フェーズ切替（表示中: ${viewing.name}）`}
        className={cn(
          "flex items-center gap-1.5 rounded-full border px-3 py-1 text-[12.5px] font-semibold transition-colors",
          isSnapshot
            ? "border-border bg-surface-variant text-on-surface-variant"
            : "border-tertiary-container bg-tertiary-container/60 text-tertiary-container-fg",
        )}
      >
        <Layers className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
        <span className="truncate">
          {viewing.name}
          {isSnapshot ? " ✓確定 (閲覧中)" : ""}
        </span>
        <ChevronDown className="h-3 w-3 shrink-0" aria-hidden="true" />
      </button>

      {open ? (
        <div
          role="menu"
          aria-label="フェーズ一覧"
          className="absolute left-0 top-full z-[300] mt-1 w-[290px] rounded-lg border border-border bg-surface p-1.5 shadow-lg"
        >
          {phases.map((p) => {
            const isViewing = viewing.id === p.id;
            return (
              <button
                key={p.id}
                type="button"
                role="menuitem"
                onClick={() => {
                  writeSelectedPhase(projectId, p.status === "active" ? null : p.id);
                  setOpen(false);
                  setFreezeConfirm(false);
                }}
                className={cn(
                  "flex w-full items-center gap-2 rounded-md px-2.5 py-2 text-left text-[12.5px]",
                  isViewing
                    ? "bg-primary-container/60 text-on-primary-container"
                    : "text-on-surface hover:bg-surface-variant",
                )}
              >
                <span className="font-semibold">{p.name}</span>
                <span className="text-[10.5px] text-on-surface-variant">
                  {p.status === "frozen" ? "✓確定済み" : "進行中"}
                </span>
                <span className="ml-auto text-[10.5px] tabular-nums text-on-surface-variant">
                  成果物{p.output_count} · モック{p.mock_count} · タスク{p.task_count}
                </span>
              </button>
            );
          })}

          <div className="mt-1 border-t border-border pt-1.5">
            {error ? (
              <p role="alert" className="px-2 pb-1 text-[11px] text-error">
                {error}
              </p>
            ) : null}
            {active && !freezeConfirm ? (
              <button
                type="button"
                onClick={() => {
                  setFreezeConfirm(true);
                  setCheck(null);
                  freezeCheckFn(projectId, active.id)
                    .then(setCheck)
                    .catch(() => setCheck(null));
                }}
                className="w-full rounded-md px-2.5 py-1.5 text-left text-[12px] font-semibold text-on-surface-variant hover:bg-surface-variant hover:text-on-surface"
              >
                「{active.name}」を確定して次フェーズへ…
              </button>
            ) : null}
            {active && freezeConfirm ? (
              <div className="rounded-md border-l-[3px] border-error bg-error/10 px-2.5 py-2 text-[11.5px] text-on-surface">
                確定すると成果物
                {active.output_count + active.mock_count > 0
                  ? `（${active.output_count + active.mock_count} 件）`
                  : ""}
                が凍結されます。
                {/* GAP-165: 「直せなくなる」わけではないことを先に伝える */}
                <span className="mt-1 block text-[11px] text-on-surface-variant">
                  確定後も修正はできます。確定済みの版はそのまま記録として残り、
                  修正すると<strong>新しい版が「{active.name}の次のフェーズ」の成果物</strong>
                  になります。
                </span>

                {/* GAP-165: 確定していいかの判断材料 (実データ) */}
                <div className="mt-1.5 rounded-sm bg-white/70 px-2 py-1.5">
                  {check === null ? (
                    <span className="text-[11px] text-on-surface-variant">
                      残っている作業を確認しています…
                    </span>
                  ) : check.warnings.length === 0 ? (
                    <span className="text-[11px] text-on-surface-variant">
                      未完了の工程・タスク・未解決コメントはありません。
                    </span>
                  ) : (
                    <ul role="list" aria-label="確定前の確認事項" className="flex flex-col gap-0.5">
                      {check.warnings.map((w) => (
                        <li key={w} className="text-[11px] text-on-surface">
                          ・{w}
                        </li>
                      ))}
                    </ul>
                  )}
                </div>

                <label className="mt-1.5 block">
                  <span className="text-[10.5px] font-semibold text-on-surface-variant">
                    このフェーズで確定した範囲 (任意 — 後から人も AI も参照します)
                  </span>
                  <input
                    value={freezeNote}
                    onChange={(e) => setFreezeNote(e.target.value)}
                    placeholder="例: 初期スコープの要件・見積まで。決済連携は次フェーズ"
                    className="mt-0.5 w-full rounded-sm border border-border bg-white px-1.5 py-1 text-[11px] text-on-surface outline-none focus-visible:border-primary"
                  />
                </label>
                <div className="mt-1.5 flex justify-end gap-1.5">
                  <button
                    type="button"
                    onClick={() => setFreezeConfirm(false)}
                    className="rounded-sm px-1.5 py-0.5 text-[10.5px] font-semibold text-on-surface-variant"
                  >
                    やめる
                  </button>
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => {
                      setBusy(true);
                      setError(null);
                      freezePhaseFn(projectId, active.id, freezeNote.trim() || undefined)
                        .then((next) => {
                          setPhases(next);
                          setFreezeConfirm(false);
                          setOpen(false);
                          // 表示は新しい現在フェーズへ (全タブ同期)
                          writeSelectedPhase(projectId, null);
                          setFreezeNote("");
                        })
                        .catch((e: unknown) => {
                          setError(
                            e instanceof api.ApiError &&
                              (e.status === 403 || e.status === 409)
                              ? e.message
                              : "フェーズの確定に失敗しました。",
                          );
                        })
                        .finally(() => setBusy(false));
                    }}
                    className="rounded-sm bg-error px-2 py-0.5 text-[10.5px] font-semibold text-on-error disabled:opacity-50"
                  >
                    {busy ? "確定中…" : "確定して次フェーズへ"}
                  </button>
                </div>
              </div>
            ) : null}
          </div>
        </div>
      ) : null}
    </div>
  );
}
