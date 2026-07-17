/**
 * S-O01 役割カード — 画面の役割説明（静的チャプター）。
 * 06_mockups/cron/S-O01-schedule.html の .role-card に忠実。
 */

"use client";

import * as React from "react";
import { Clock } from "lucide-react";

const POINTS: ReadonlyArray<{ label: string; desc: string }> = [
  {
    label: "法令・運用は自動で動く",
    desc: "退会データ削除や整合性チェックは常時稼働（コストゼロ）",
  },
  {
    label: "実装の夜間進行は ON/OFF 可",
    desc: "着手可タスクを夜のうちに消化（Claude プラン枠を使用）",
  },
  {
    label: "ナレッジ・通知は任意",
    desc: "ティチャラのナレッジ整理や月次レポート配信を必要なだけ",
  },
];

export function ScheduleRoleCard() {
  return (
    <section className="mb-5 grid grid-cols-[56px_1fr] items-start gap-[18px] rounded-lg border border-border bg-gradient-to-br from-white to-primary-container px-6 py-5">
      <span className="flex h-14 w-14 items-center justify-center rounded-md bg-primary text-on-primary">
        <Clock size={28} />
      </span>
      <div>
        <h1 className="mb-1 text-lg font-bold tracking-tight text-on-surface">
          自動スケジュール — 決まった時間に AI 社員や裏方処理を自動起動する場所
        </h1>
        <p className="mb-3.5 text-[13px] leading-[1.7] text-on-surface-variant">
          あなたが寝ている間や離席中も、ナレッジ整理・整合性チェック・進捗レポート配信などを自動で動かせます。法令対応の自動処理（退会データ削除など）はオフにできません。
        </p>
        <div className="grid gap-3 md:grid-cols-3">
          {POINTS.map((p, i) => (
            <div
              key={p.label}
              className="rounded-md bg-white/70 px-3 py-2.5"
            >
              <span className="mb-1.5 inline-flex h-[22px] w-[22px] items-center justify-center rounded-full bg-primary text-[11px] font-bold text-on-primary">
                {i + 1}
              </span>
              <div className="mb-0.5 text-xs font-bold text-on-surface">
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
  );
}
