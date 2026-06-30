/**
 * S-C01 AI 社員組織図 — T-UC-06
 *
 * EmployeeIcon を使った AI 社員のグルーピング表示。
 * 実 API の department（経営/営業/プロダクト/アーキ/デザイン/開発QA/横断）で section 化する。
 */

"use client";

import * as React from "react";

import {
  EmployeeIcon,
  type EmployeeId,
} from "../../../../components/EmployeeIcon";
import { cn } from "../../../../lib/cn";

export type Department =
  | "executive"
  | "sales"
  | "product"
  | "architecture"
  | "design"
  | "dev_qa"
  | "cross_functional";

export interface OrgNode {
  readonly id: EmployeeId;
  readonly displayName: string;
  readonly department: Department;
}

export interface OrgChartProps {
  readonly nodes: readonly OrgNode[];
  readonly onSelect?: (id: EmployeeId) => void;
}

const DEPT_LABEL = {
  executive: "経営",
  sales: "営業",
  product: "プロダクト",
  architecture: "アーキテクチャ",
  design: "デザイン",
  dev_qa: "開発・QA",
  cross_functional: "横断",
} as const;

export function OrgChart({ nodes, onSelect }: OrgChartProps) {
  const byDept = (
    Object.keys(DEPT_LABEL) as Array<keyof typeof DEPT_LABEL>
  ).map((d) => ({
    department: d,
    members: nodes.filter((n) => n.department === d),
  }));
  return (
    <section aria-label="AI 社員組織図" className="flex flex-col gap-lg">
      {byDept.map(({ department, members }) =>
        members.length === 0 ? null : (
          <article
            key={department}
            aria-label={DEPT_LABEL[department]}
            className="flex flex-col gap-sm"
          >
            <h2 className="text-label-lg font-semibold text-on-surface-variant">
              {DEPT_LABEL[department]}
            </h2>
            <ul role="list" className="flex flex-wrap gap-md">
              {members.map((n) => (
                <li key={n.id}>
                  <button
                    type="button"
                    onClick={() => onSelect?.(n.id)}
                    aria-label={`${n.displayName} の詳細`}
                    className={cn(
                      "flex flex-col items-center gap-xs rounded-md p-sm",
                      onSelect && "hover:bg-surface-variant/40",
                    )}
                  >
                    <EmployeeIcon employeeId={n.id} size="lg" />
                    <span className="text-label-md text-on-surface">
                      {n.displayName}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          </article>
        ),
      )}
    </section>
  );
}
