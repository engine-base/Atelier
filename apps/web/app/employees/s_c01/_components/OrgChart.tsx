/**
 * S-C01 AI 社員組織図 — T-UC-06 / F-VIS 是正
 *
 * モック 06_mockups/employee/S-C01-org.html に忠実な組織図で描画する。
 *   - COO(executive) を中央の primary-container カードで最上段に配置
 *   - 5 部署(営業/プロダクト/アーキ/デザイン/開発QA)を横並びグリッドの列グループに
 *   - 全社横断(cross_functional) を最下段の surface-variant カードで中央配置
 * 各カードは avatar(EmployeeIcon) + 表示名。実 API データ(props)にバインドし、
 * ダミー値はハードコードしない。department で section 化する。
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
  /** EmployeeIcon 用の persona キー (name)。表示専用で API の id ではない。 */
  readonly id: EmployeeId;
  /** 遷移/API 用の実 UUID。onSelect にはこちらを渡す。 */
  readonly selectId: string;
  readonly displayName: string;
  readonly department: Department;
}

export interface OrgChartProps {
  readonly nodes: readonly OrgNode[];
  /** 実 UUID (OrgNode.selectId) を受け取る。 */
  readonly onSelect?: (id: string) => void;
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

/** モックの中央 5 列グリッドに並ぶ部署(COO/横断を除く)。 */
const LINE_DEPTS: readonly Department[] = [
  "sales",
  "product",
  "architecture",
  "design",
  "dev_qa",
];

const CARD_BASE =
  "flex w-full min-w-[180px] flex-col items-center gap-2.5 rounded-lg border px-5 py-4 text-center transition-all duration-150";

type CardTone = "coo" | "member" | "cross";

const TONE_CLASS: Record<CardTone, { surface: string; name: string }> = {
  coo: {
    surface: "border-primary bg-primary-container",
    name: "text-primary-container-fg",
  },
  member: {
    surface: "border-border bg-white",
    name: "text-on-surface",
  },
  cross: {
    surface: "border-border bg-surface-variant",
    name: "text-on-surface",
  },
};

interface EmployeeCardProps {
  readonly node: OrgNode;
  readonly tone: CardTone;
  readonly size?: "md" | "lg";
  readonly onSelect?: (id: string) => void;
}

function EmployeeCard({ node, tone, size = "md", onSelect }: EmployeeCardProps) {
  const t = TONE_CLASS[tone];
  return (
    <button
      type="button"
      onClick={() => onSelect?.(node.selectId)}
      aria-label={`${node.displayName} の詳細`}
      className={cn(
        CARD_BASE,
        t.surface,
        onSelect &&
          "cursor-pointer hover:-translate-y-px hover:border-primary hover:shadow-sm",
      )}
    >
      <EmployeeIcon employeeId={node.id} size={size} />
      <span className={cn("text-[15px] font-bold leading-tight", t.name)}>
        {node.displayName}
      </span>
    </button>
  );
}

export function OrgChart({ nodes, onSelect }: OrgChartProps) {
  const membersOf = (d: Department) => nodes.filter((n) => n.department === d);

  const executives = membersOf("executive");
  const crossFunctional = membersOf("cross_functional");
  const lineGroups = LINE_DEPTS.map((department) => ({
    department,
    members: membersOf(department),
  })).filter((g) => g.members.length > 0);

  return (
    <section aria-label="AI 社員組織図" className="flex flex-col gap-8">
      {/* COO — 中央 */}
      {executives.length > 0 && (
        <article
          aria-label={DEPT_LABEL.executive}
          className="flex justify-center"
        >
          <ul role="list" className="flex flex-wrap justify-center gap-4">
            {executives.map((n) => (
              <li key={n.selectId} className="flex">
                <EmployeeCard
                  node={n}
                  tone="coo"
                  size="lg"
                  onSelect={onSelect}
                />
              </li>
            ))}
          </ul>
        </article>
      )}

      {/* 5 部署 — 横並びグリッド */}
      {lineGroups.length > 0 && (
        <div
          className={cn(
            "grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-5",
            executives.length > 0 && "border-t border-border pt-8",
          )}
        >
          {lineGroups.map(({ department, members }) => (
            <article
              key={department}
              aria-label={DEPT_LABEL[department]}
              className="flex flex-col gap-3"
            >
              <h2 className="border-b border-border pb-2 text-center text-[11px] font-bold uppercase tracking-[0.14em] text-on-surface-variant">
                {DEPT_LABEL[department]}
              </h2>
              <ul role="list" className="flex flex-col gap-3">
                {members.map((n) => (
                  <li key={n.selectId} className="flex">
                    <EmployeeCard node={n} tone="member" onSelect={onSelect} />
                  </li>
                ))}
              </ul>
            </article>
          ))}
        </div>
      )}

      {/* 全社横断 — 中央 */}
      {crossFunctional.length > 0 && (
        <article
          aria-label={DEPT_LABEL.cross_functional}
          className="flex flex-col items-center gap-3"
        >
          <div className="text-[11px] font-bold uppercase tracking-[0.14em] text-on-surface-variant">
            全社横断
          </div>
          <ul role="list" className="flex flex-wrap justify-center gap-4">
            {crossFunctional.map((n) => (
              <li key={n.selectId} className="flex max-w-[280px]">
                <EmployeeCard node={n} tone="cross" onSelect={onSelect} />
              </li>
            ))}
          </ul>
        </article>
      )}
    </section>
  );
}
