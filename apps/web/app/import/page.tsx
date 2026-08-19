/**
 * 既存資料の取り込み — GAP-156
 *
 * 既存プロジェクトを途中からツールに載せる: ローカルの HTML/MD/画像/PPTX 等を
 * 一括アップロード → モック/成果物へ自動仕分け → 完了済み工程の提案 →
 * ユーザー確定でフローの現在地を合わせる。
 */

"use client";

import * as React from "react";
import { Suspense } from "react";

import { useProjectId } from "../../lib/useProjectId";
import { QueryProvider } from "../../providers/query-provider";
import { ImportContainer } from "./_components/ImportContainer";

function ImportInner() {
  const projectId = useProjectId();
  return (
    <div className="mx-auto w-full max-w-[900px] px-md py-lg">
      {projectId ? (
        <QueryProvider>
          <ImportContainer projectId={projectId} />
        </QueryProvider>
      ) : (
        <p className="rounded-md border-l-[3px] border-primary bg-primary-container px-4 py-3 text-body-md text-primary-container-fg">
          プロジェクトを選択すると既存資料を取り込めます。
        </p>
      )}
    </div>
  );
}

export default function ImportPage() {
  return (
    <Suspense fallback={null}>
      <ImportInner />
    </Suspense>
  );
}
