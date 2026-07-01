/**
 * 横断: グローバル検索画面 — T-UC-40
 *
 * project / task / knowledge / employee を実 /search API で横断検索する。
 */

"use client";

import * as React from "react";

import { QueryProvider } from "../../providers/query-provider";
import { SearchContainer } from "./_components/SearchContainer";

export default function UC40Page() {
  return (
    <QueryProvider>
      <SearchContainer />
    </QueryProvider>
  );
}
