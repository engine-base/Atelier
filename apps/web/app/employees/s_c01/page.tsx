/**
 * S-C01 AI 社員組織図画面 — T-UC-06 / F-VIS 是正
 *
 * 実 ai-employees API (GET /ai-employees) に配線。社員クリックで S-C02 編集へ遷移。
 * モック 06_mockups/employee/S-C01-org.html に忠実な本文(見出し + 組織図 + 注記)で描画する。
 */

"use client";

import * as React from "react";

import { useRouter } from "next/navigation";
import { LayoutDashboard, ListChecks, Sparkles } from "lucide-react";

import { QueryProvider } from "../../../providers/query-provider";
import { OrgChartContainer } from "./_components/OrgChartContainer";

function SC01Inner() {
  const router = useRouter();
  const [view, setView] = React.useState<"org" | "list">("org");
  return (
    <div className="mx-auto w-full max-w-[1200px] px-md py-lg">
      <div className="mb-8 flex items-start justify-between gap-4">
        <div>
          <p className="text-[11px] font-bold uppercase tracking-[0.14em] text-on-surface-variant">
            AI Organization
          </p>
          <h1 className="mt-1 text-3xl font-bold tracking-tight text-on-surface">
            AI 社員組織図
          </h1>
          <p className="mt-2 text-sm text-on-surface-variant">
            10 名のデフォルト編成 · COO + 5 部署 + 横断スタッフ
          </p>
        </div>
        <div className="flex items-center gap-1 rounded-md bg-surface-variant p-1">
          <button
            type="button"
            aria-pressed={view === "org"}
            onClick={() => setView("org")}
            className={
              view === "org"
                ? "inline-flex items-center gap-1.5 rounded-[6px] bg-white px-3 py-1.5 text-xs font-semibold text-on-surface shadow-sm"
                : "inline-flex items-center gap-1.5 rounded-[6px] px-3 py-1.5 text-xs font-semibold text-on-surface-variant hover:text-on-surface"
            }
          >
            <LayoutDashboard size={12} aria-hidden="true" />
            組織図
          </button>
          <button
            type="button"
            aria-pressed={view === "list"}
            onClick={() => setView("list")}
            className={
              view === "list"
                ? "inline-flex items-center gap-1.5 rounded-[6px] bg-white px-3 py-1.5 text-xs font-semibold text-on-surface shadow-sm"
                : "inline-flex items-center gap-1.5 rounded-[6px] px-3 py-1.5 text-xs font-semibold text-on-surface-variant hover:text-on-surface"
            }
          >
            <ListChecks size={12} aria-hidden="true" />
            リスト
          </button>
        </div>
      </div>

      <OrgChartContainer
        view={view}
        onSelect={(id) => router.push(`/employees/detail?employee=${id}`)}
      />

      <div className="mt-10 flex items-start gap-3 rounded-md border-l-[3px] border-primary bg-primary-container p-3 text-sm text-primary-container-fg">
        <Sparkles size={18} aria-hidden="true" className="mt-0.5 shrink-0" />
        <p>
          AI 社員 10 名は <strong className="font-bold">運営側で全て整えられた構成</strong> です。追加・削除はできません。各社員の{" "}
          <strong className="font-bold">名前・アイコン・口調プリセット・カスタム文章</strong>{" "}
          のみユーザーが編集できます。
        </p>
      </div>
    </div>
  );
}

export default function SC01Page() {
  return (
    <QueryProvider>
      <SC01Inner />
    </QueryProvider>
  );
}
