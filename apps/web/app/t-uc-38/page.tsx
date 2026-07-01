/**
 * 横断: ワークスペース切替画面 — T-UC-38
 *
 * 所属 WS 一覧を実 workspaces API から取得し、選択を localStorage に永続化する。
 */

"use client";

import * as React from "react";

import { QueryProvider } from "../../providers/query-provider";
import { WorkspaceSwitcherContainer } from "./_components/WorkspaceSwitcherContainer";
import { t } from "../../lib/i18n";

export default function UC38Page() {
  return (
    <QueryProvider>
      <div className="mx-auto flex w-full max-w-xl flex-col gap-md px-md py-lg">
        <h1 className="text-headline-md font-bold text-on-surface">
          ワークスペース切替
        </h1>
        <p className="text-body-md text-on-surface-variant">
          所属する {t("nav.projects")} を切り替えます。
        </p>
        <WorkspaceSwitcherContainer />
      </div>
    </QueryProvider>
  );
}
