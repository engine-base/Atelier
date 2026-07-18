"use client";

import * as React from "react";
import { Suspense } from "react";
import { PlayCircle } from "lucide-react";

import { QueryProvider } from "../../../providers/query-provider";
import { useProjectId } from "../../../lib/useProjectId";
import { TaskBoardContainer } from "./_components/TaskBoardContainer";

/** モックの「役割カード」— AI 社員に作業を任せる場所であることの説明。 */
const ROLE_STEPS: readonly { label: string; desc: string }[] = [
  {
    label: "タスクを選ぶ",
    desc: "カードをクリックして 1 件、またはまとめて複数選択します",
  },
  {
    label: "再生する",
    desc: "画面上部の青いボタンで AI 社員に作業を開始させます",
  },
  {
    label: "承認待ちに進むのを待つ",
    desc: "自動で実装 → 検証 → 承認待ちまで進みます",
  },
];

function RoleCard() {
  return (
    <section className="grid grid-cols-[56px_1fr] items-start gap-[18px] rounded-lg border border-border bg-gradient-to-br from-white to-primary-container p-5">
      <div className="flex h-14 w-14 items-center justify-center rounded-md bg-primary text-primary-fg">
        <PlayCircle aria-hidden="true" className="h-7 w-7" />
      </div>
      <div>
        <h2 className="mb-1 text-lg font-bold tracking-tight text-on-surface">
          タスクボード — AI 社員に作業を任せる場所
        </h2>
        <p className="mb-3.5 text-[13px] text-on-surface-variant">
          タスクを選んで「再生」を押すと、Atelier Bridge があなたの PC でローカル
          Claude Code を並列起動し、AI 社員が自動で実装・自己検証を進めます。
          タスクは{" "}
          <strong className="font-bold text-on-surface">
            準備中 → 着手可 → 実装中 → （要対応） → 承認待ち → 完了
          </strong>{" "}
          の流れで進みます。
        </p>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          {ROLE_STEPS.map((step, i) => (
            <div key={step.label} className="rounded-md bg-white/70 px-3 py-2.5">
              <span className="mb-1.5 inline-flex h-[22px] w-[22px] items-center justify-center rounded-full bg-primary text-[11px] font-bold text-primary-fg">
                {i + 1}
              </span>
              <p className="mb-0.5 text-xs font-bold text-on-surface">
                {step.label}
              </p>
              <p className="text-[11.5px] leading-relaxed text-on-surface-variant">
                {step.desc}
              </p>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

/** モックのレーン凡例。状態レーンの意味を色ドットで示す。 */
const LEGEND_ITEMS: readonly { dot: string; label: string }[] = [
  { dot: "bg-neutral", label: "準備中（仕様未確定）" },
  { dot: "bg-on-surface-variant", label: "着手可（再生待ち）" },
  { dot: "bg-primary", label: "実装中（AI が稼働中）" },
  { dot: "bg-error", label: "要対応（再試行 / 判断必要）" },
  { dot: "bg-secondary", label: "承認待ち（人間判断）" },
  { dot: "bg-tertiary", label: "完了" },
];

function LaneLegend() {
  return (
    <section className="flex flex-wrap items-center gap-x-[18px] gap-y-2 rounded-md bg-surface-variant px-4 py-3 text-xs text-on-surface-variant">
      <span className="font-bold text-on-surface">レーンの意味</span>
      {LEGEND_ITEMS.map((item) => (
        <span key={item.label} className="flex items-center gap-1.5">
          <span
            aria-hidden="true"
            className={`h-2.5 w-2.5 rounded-full ${item.dot}`}
          />
          {item.label}
        </span>
      ))}
    </section>
  );
}

function SI01Inner() {
  const projectId = useProjectId();

  return (
    <div className="mx-auto flex w-full max-w-[1200px] flex-col gap-4 px-md py-lg">
      <h1 className="text-headline-md font-bold text-on-surface">
        タスクボード
      </h1>
      {projectId ? (
        <>
          <RoleCard />
          <LaneLegend />
          <TaskBoardContainer projectId={projectId} />
        </>
      ) : (
        <p className="text-body-md text-on-surface-variant">
          プロジェクトを選択するとタスクボードを表示します。
        </p>
      )}
    </div>
  );
}

export default function SI01Page() {
  return (
    <QueryProvider>
      <Suspense
        fallback={
          <div className="p-lg text-body-md text-on-surface-variant">
            読み込み中…
          </div>
        }
      >
        <SI01Inner />
      </Suspense>
    </QueryProvider>
  );
}
