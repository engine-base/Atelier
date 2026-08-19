/**
 * S-T07 運営 既定デザインテンプレ — GAP-159
 *
 * 経営者指示「初めのデフォルトはこちらの管理側で設定しているものでいい」
 * 「管理側でも全く同じように更新や追加変更などできる状態に」。
 * ユーザー側 /templates と同一コンポーネントを mode="platform" で使う
 * (作り・操作・見た目を完全に共通化する)。
 */

"use client";

import * as React from "react";

import { QueryProvider } from "../../../providers/query-provider";
import { DesignTemplateStudio } from "../../templates/_components/DesignTemplateStudio";

export default function ST07Page() {
  return (
    <div className="min-h-dvh bg-surface">
      <QueryProvider>
        <DesignTemplateStudio mode="platform" />
      </QueryProvider>
    </div>
  );
}
