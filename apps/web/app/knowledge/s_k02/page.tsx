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
import { readAccessToken } from "../../../lib/auth/connector";
import { decodeJwtUnsafe } from "../../../lib/auth/cookie";
import { PromotionReviewContainer } from "./_components/PromotionReviewContainer";

function SK02Inner() {
  const params = useSearchParams();
  const workspaceId = params.get("workspace");
  // cookie 読みは client 専用。render 中に直接呼ぶと SSR(null)≠CSR(値) で
  // hydration mismatch になる実バグが axe/E2E 実機で出たため effect で読む。
  const [accountId, setAccountId] = React.useState<string | null>(null);
  React.useEffect(() => {
    const token = readAccessToken();
    setAccountId(token ? (decodeJwtUnsafe(token)?.sub ?? null) : null);
  }, []);

  return (
    <div className="mx-auto w-full max-w-3xl px-md py-lg">
      <h1 className="mb-md text-headline-md font-bold text-on-surface">
        ナレッジ昇格レビュー
      </h1>
      {accountId && workspaceId ? (
        <PromotionReviewContainer
          accountId={accountId}
          targetWorkspaceId={workspaceId}
        />
      ) : (
        <p className="text-body-md text-on-surface-variant">
          昇格先ワークスペースを選択するとレビューを開始できます。
        </p>
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
