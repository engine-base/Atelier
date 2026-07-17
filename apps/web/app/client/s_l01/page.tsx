/**
 * S-L01 クライアント招待管理画面 — T-UC-20
 *
 * 実 client-invitations API に配線。projectId は URL ?project=。
 * F-VIS 是正: 本文をモック 06_mockups/client/S-L01-invite-mgmt.html に忠実再構築
 * (page-header / セキュリティ notice / 発行フォーム / アクティブ・履歴テーブル)。
 */

"use client";

import * as React from "react";
import { Suspense } from "react";
import { useSearchParams } from "next/navigation";

import { QueryProvider } from "../../../providers/query-provider";
import { InvitationsListContainer } from "./_components/InvitationsListContainer";

function ShieldCheckIcon() {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 24 24"
      className="mt-0.5 h-5 w-5 shrink-0"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
      <path d="m9 12 2 2 4-4" />
    </svg>
  );
}

function SL01Inner() {
  const params = useSearchParams();
  const projectId = params.get("project");

  return (
    <div className="mx-auto w-full max-w-[1200px] px-md py-lg">
      <header className="mb-6">
        <p className="text-[11px] font-bold uppercase tracking-[0.14em] text-on-surface-variant">
          Client Invitation
        </p>
        <h1 className="mt-1 text-3xl font-bold tracking-tight text-on-surface">
          クライアント招待
        </h1>
        <p className="mt-1 text-body-md text-on-surface-variant">
          1 招待 = 1 メール（個別 JWT 経路）。閲覧 + コメントのみ可能。
        </p>
      </header>

      <div className="mb-6 flex items-start gap-2 rounded-md border-l-[3px] border-tertiary bg-tertiary-container p-3 text-body-sm text-tertiary-container-fg">
        <ShieldCheckIcon />
        <p>
          <strong className="font-semibold">セキュリティ：</strong>
          クライアントは別 JWT 経路（
          <code className="rounded-sm bg-white/50 px-1 py-0.5 font-mono text-[12px]">
            role=client_portal
          </code>
          ）で完全分離。通常ユーザーのテーブルには一切アクセスできません（R-T08
          致命級リスク対策）。
        </p>
      </div>

      {projectId ? (
        <InvitationsListContainer projectId={projectId} />
      ) : (
        <p className="text-body-md text-on-surface-variant">
          プロジェクトを選択すると招待を管理できます。
        </p>
      )}
    </div>
  );
}

export default function SL01Page() {
  return (
    <QueryProvider>
      <Suspense
        fallback={
          <div className="p-lg text-body-md text-on-surface-variant">
            読み込み中…
          </div>
        }
      >
        <SL01Inner />
      </Suspense>
    </QueryProvider>
  );
}
