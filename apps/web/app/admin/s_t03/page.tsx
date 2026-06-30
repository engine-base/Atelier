/**
 * S-T03 AI 社員テンプレ画面 — T-UC-32
 *
 * 実 admin API (GET /admin/ai-employee-templates) に配線。運営 admin 専用・read-only。
 */

"use client";

import * as React from "react";

import { QueryProvider } from "../../../providers/query-provider";
import { TemplateListContainer } from "./_components/TemplateListContainer";

export default function ST03Page() {
  return (
    <div className="bg-on-surface min-h-dvh p-lg">
      <h1 className="mb-md text-headline-md font-bold text-surface">
        AI 社員テンプレ
      </h1>
      <QueryProvider>
        <TemplateListContainer />
      </QueryProvider>
    </div>
  );
}
