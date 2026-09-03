/**
 * GAP-315 — ワークスペース招待リンクの受け取り画面 (/invite/<token>)。
 *
 * 未登録の相手を招待できるようにした (通し J31-08) ことで、「メールのリンクを
 * 開く → どこへの招待か分かる → 登録/サインインして参加する」という筋道が
 * 初めて成立する。リンクが切れている場合も、**理由を書いて**示す
 * (「無効です」だけだと、受け取った人は壊れているとしか思えない)。
 */

import { Suspense } from "react";

import { QueryProvider } from "../../../providers/query-provider";
import { InviteAcceptContainer } from "./_components/InviteAcceptContainer";

export default async function InvitePage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await params;
  return (
    <main className="mx-auto flex min-h-screen max-w-[520px] flex-col justify-center px-4 py-10">
      <QueryProvider>
        <Suspense fallback={null}>
          <InviteAcceptContainer token={token} />
        </Suspense>
      </QueryProvider>
    </main>
  );
}
