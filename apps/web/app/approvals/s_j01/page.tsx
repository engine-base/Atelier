/**
 * S-J01 承認待ち（5 種統合）— T-UC-17
 *
 * 実 approval-inbox API に配線。本人の承認待ちを取得し承認 / 差戻する。
 * モック S-J01-list.html 準拠: 役割カード → KPI → カテゴリチップ → リスト + 詳細ペイン。
 */

"use client";

import * as React from "react";
import { Inbox } from "lucide-react";

import { QueryProvider } from "../../../providers/query-provider";
import { ApprovalsContainer } from "./_components/ApprovalsContainer";

const ROLE_POINTS = [
  {
    num: 1,
    label: "緊急（赤枠）を先に",
    desc: "仕様変更の取り込み判断は他工程をブロックします",
  },
  {
    num: 2,
    label: "通常の承認は素早く",
    desc: "スコアと要約だけ見て承認 / 差し戻しを即決",
  },
  {
    num: 3,
    label: "提案系は判断を保留可",
    desc: "ナレッジ昇格や次工程進行は「後で判断」も OK",
  },
] as const;

export default function SJ01Page() {
  return (
    <div className="mx-auto flex w-full max-w-[1400px] flex-col gap-4 px-md py-lg">
      <h1 className="sr-only">承認待ち</h1>

      {/* 役割カード (モック .role-card) */}
      <section
        aria-label="この画面の役割"
        className="grid grid-cols-[56px_1fr] items-start gap-[18px] rounded-lg border border-border bg-gradient-to-br from-white to-primary-container px-6 py-5"
      >
        <div className="flex h-14 w-14 items-center justify-center rounded-md bg-primary text-on-primary">
          <Inbox className="h-7 w-7" aria-hidden="true" />
        </div>
        <div>
          <h2 className="mb-1 text-[18px] font-bold tracking-[-0.01em] text-on-surface">
            承認待ち — あなたの判断を待っている案件をまとめて処理する場所
          </h2>
          <p className="mb-3.5 text-[13px] leading-[1.7] text-on-surface-variant">
            AI 社員が自走している中で、人間の判断が必要になったものだけがここに集まります。上から順に処理すれば、迷子になりません。
          </p>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            {ROLE_POINTS.map((p) => (
              <div key={p.num} className="rounded-md bg-white/70 px-3 py-2.5">
                <span
                  aria-hidden="true"
                  className="mb-1.5 inline-flex h-[22px] w-[22px] items-center justify-center rounded-full bg-primary text-[11px] font-bold text-on-primary"
                >
                  {p.num}
                </span>
                <div className="mb-0.5 text-[12px] font-bold text-on-surface">
                  {p.label}
                </div>
                <div className="text-[11.5px] leading-[1.55] text-on-surface-variant">
                  {p.desc}
                </div>
              </div>
            ))}
          </div>
        </div>
      </section>

      <QueryProvider>
        <ApprovalsContainer />
      </QueryProvider>
    </div>
  );
}
