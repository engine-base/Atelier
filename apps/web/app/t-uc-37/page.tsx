/**
 * 横断: ユーザープロフィール画面 — T-UC-37
 *
 * 実 /me API に配線。email 表示 + display_name 変更フォーム。
 */

"use client";

import * as React from "react";

import { QueryProvider } from "../../providers/query-provider";
import { ProfileContainer } from "./_components/ProfileContainer";

export default function UC37Page() {
  return (
    <QueryProvider>
      <div className="mx-auto flex w-full max-w-xl flex-col gap-lg px-md py-lg">
        <ProfileContainer />
      </div>
    </QueryProvider>
  );
}
