/**
 * S-I03 実行モニター画面 — T-UC-16
 *
 * 実 exec-logs SSE (GET /executions/{id}/logs/stream) に配線。executionId は URL ?execution=。
 * 本文はモック 06_mockups/task/S-I03-monitor.html を踏襲:
 *   役割カード(説明 + リアルタイム更新中バッジ + 3 ポイント) → 統計/セッション/ライブログ。
 */

"use client";

import * as React from "react";
import { Suspense } from "react";
import { useSearchParams } from "next/navigation";
import { Cpu } from "lucide-react";

import { ExecutionMonitorContainer } from "./_components/ExecutionMonitorContainer";

/** モックの role-point (1/2/3) — 画面の役割を説明する静的コピー。 */
const ROLE_POINTS = [
  {
    label: "いま何が動いているか見る",
    desc: "セッションごとに進捗・実行ログ・スコアを表示します",
  },
  {
    label: "要対応のセッションを察知する",
    desc: "橙色の枠は承認 / 差し戻し / 再試行の判断待ちです",
  },
  {
    label: "必要なら介入する",
    desc: "セッションを停止・承認・差し戻しできます",
  },
] as const;

function SI03Inner() {
  const params = useSearchParams();
  const executionId = params.get("execution");

  return (
    <div className="mx-auto flex w-full max-w-[1200px] flex-col gap-lg px-md py-lg">
      {/* 役割カード */}
      <section className="grid grid-cols-[60px_1fr] gap-lg rounded-lg border border-border bg-primary-container p-lg text-primary-container-fg">
        <div className="flex h-[60px] w-[60px] items-center justify-center rounded-md bg-primary text-on-primary">
          <Cpu size={28} aria-hidden />
        </div>
        <div>
          <div className="mb-1.5 flex flex-wrap items-center gap-3">
            <h1 className="text-[18.5px] font-bold tracking-tight text-on-surface">
              実行モニター — AI 社員の作業状況をリアルタイムで見守る場所
            </h1>
            <span className="inline-flex items-center gap-1.5 rounded-full border border-tertiary bg-tertiary-container px-2.5 py-1 text-[11px] font-bold tracking-wide text-tertiary-container-fg">
              <span
                aria-hidden
                className="h-2 w-2 rounded-full bg-tertiary animate-pulse"
              />
              リアルタイム更新中
            </span>
          </div>
          <p className="mb-md text-body-sm leading-relaxed text-on-surface-variant">
            タスクボードで再生したタスクは、
            <strong className="font-semibold text-on-surface">
              Atelier Bridge
            </strong>
            （あなたの PC で動くデスクトップアプリ）がローカル Claude Code
            を並列起動し、FastAPI 上のディスパッチャがタスクを差配します。実行は完全にあなたの
            Claude
            プラン内で完結。基本は放置で OK、橙色のセッションだけ判断が必要です。
          </p>
          <div className="grid gap-3 sm:grid-cols-3">
            {ROLE_POINTS.map((p, i) => (
              <div
                key={p.label}
                className="rounded-md border border-border bg-surface p-3"
              >
                <div className="mb-2 flex h-6 w-6 items-center justify-center rounded-full bg-primary text-[12px] font-bold text-on-primary">
                  {i + 1}
                </div>
                <div className="mb-0.5 text-[12.5px] font-bold text-on-surface">
                  {p.label}
                </div>
                <div className="text-[11.5px] leading-snug text-on-surface-variant">
                  {p.desc}
                </div>
              </div>
            ))}
          </div>
        </div>
      </section>

      {executionId ? (
        <ExecutionMonitorContainer executionId={executionId} />
      ) : (
        <p className="rounded-md border border-dashed border-border px-md py-lg text-center text-body-md text-on-surface-variant">
          実行を選択するとログをリアルタイム表示します。
        </p>
      )}
    </div>
  );
}

export default function SI03Page() {
  return (
    <Suspense
      fallback={
        <div className="p-lg text-body-md text-on-surface-variant">
          読み込み中…
        </div>
      }
    >
      <SI03Inner />
    </Suspense>
  );
}
