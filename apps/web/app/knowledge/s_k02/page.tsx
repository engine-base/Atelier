/**
 * S-K02 ナレッジ昇格レビュー画面 — T-UC-19
 *
 * 実 knowledge API に配線。本人(JWT sub)の user-scope ナレッジを昇格候補として表示し、
 * 昇格先 workspace は URL ?workspace= で受ける。
 */

"use client";

import * as React from "react";
import { Suspense } from "react";
import { useSearchParams } from "next/navigation";

import { QueryProvider } from "../../../providers/query-provider";
import { getJson, readAccessToken } from "../../../lib/auth/connector";
import { decodeJwtUnsafe } from "../../../lib/auth/cookie";
import { readCurrentWorkspace } from "../../../lib/currentWorkspace";
import { PromotionReviewContainer } from "./_components/PromotionReviewContainer";

function SK02Inner() {
  const params = useSearchParams();
  const explicitWs = params.get("workspace") ?? readCurrentWorkspace();
  // cookie 読みは client 専用。render 中に直接呼ぶと SSR(null)≠CSR(値) で
  // hydration mismatch になる実バグが axe/E2E 実機で出たため effect で読む。
  const [accountId, setAccountId] = React.useState<string | null>(null);
  // WS 未選択でも所属 WS の先頭へ自動フォールバック (S-K01 と同じ是正)。
  const [fallbackWs, setFallbackWs] = React.useState<string | undefined>();
  React.useEffect(() => {
    const token = readAccessToken();
    setAccountId(token ? (decodeJwtUnsafe(token)?.sub ?? null) : null);
  }, []);
  React.useEffect(() => {
    if (explicitWs) return;
    let cancelled = false;
    getJson<readonly { id: string }[]>("/workspaces")
      .then((res) => {
        if (!cancelled) setFallbackWs(res.data[0]?.id);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [explicitWs]);
  const workspaceId = explicitWs ?? fallbackWs;

  return (
    <div className="mx-auto w-full max-w-[1200px] px-md py-lg">
      <h1 className="mb-md text-3xl font-bold tracking-tight text-on-surface">
        ナレッジ昇格レビュー
      </h1>
      {accountId && workspaceId ? (
        <PromotionReviewContainer
          accountId={accountId}
          targetWorkspaceId={workspaceId}
        />
      ) : (
        <p className="text-body-md text-on-surface-variant">読み込み中…</p>
      )}
    </div>
  );
}

export default function SK02Page() {
  return (
    <QueryProvider>
      <Suspense
        fallback={
          <div className="p-lg text-body-md text-on-surface-variant">
            読み込み中…
          </div>
        }
      >
        <SK02Inner />
      </Suspense>
    </QueryProvider>
  );
}
