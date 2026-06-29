"use client";

import * as React from "react";

import { QueryProvider } from "../../../providers/query-provider";
import { KnowledgeExplorer } from "./_components/KnowledgeExplorer";

export default function SK01Page() {
  return (
    <div className="min-h-dvh bg-surface px-md py-lg">
      <h1 className="mb-md text-headline-md font-bold text-on-surface">
        ナレッジエクスプローラ
      </h1>
      <QueryProvider>
        <KnowledgeExplorer />
      </QueryProvider>
    </div>
  );
}
