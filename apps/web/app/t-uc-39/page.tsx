/**
 * 横断: プロジェクト切替画面 — T-UC-39
 *
 * 現在 WS 内の project 一覧を実 projects API から取得し、選択を localStorage 永続化する。
 */

"use client";

import * as React from "react";

import { QueryProvider } from "../../providers/query-provider";
import { ProjectSwitcherContainer } from "./_components/ProjectSwitcherContainer";

export default function UC39Page() {
  return (
    <QueryProvider>
      <div className="mx-auto flex w-full max-w-xl flex-col gap-md px-md py-lg">
        <h1 className="text-headline-md font-bold text-on-surface">
          プロジェクト切替
        </h1>
        <p className="text-body-md text-on-surface-variant">
          ワークスペース内のプロジェクトを切り替えます。
        </p>
        <ProjectSwitcherContainer />
      </div>
    </QueryProvider>
  );
}
