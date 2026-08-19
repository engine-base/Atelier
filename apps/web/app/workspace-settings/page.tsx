/**
 * ワークスペース設定 — GAP-154
 *
 * ナビの「WS設定」の実体 (従来はリンク先未実装だった)。現在は
 * 出力テンプレート (workspace 単位・種類ごと自作 → AI 生成時に必ず注入) を管理する。
 */

"use client";

import * as React from "react";

import { QueryProvider } from "../../providers/query-provider";
import { OutputTemplatesContainer } from "./_components/OutputTemplatesContainer";

export default function WorkspaceSettingsPage() {
  return (
    <QueryProvider>
      <div className="mx-auto flex w-full max-w-4xl flex-col gap-lg px-md py-lg">
        <OutputTemplatesContainer />
      </div>
    </QueryProvider>
  );
}
