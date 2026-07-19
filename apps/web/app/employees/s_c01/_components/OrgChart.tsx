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
  /** 英名表記 (name の capitalize)。モックの .org-en。 */
  readonly enName?: string;
  /** 役割ライン (COO · 全社統括 / 部長 / メンバー / ナレッジ統括)。モックの .org-role。 */
  readonly roleLabel?: string;
  /** 装着スキル名 (実 attached_skills を /skills で名前解決したもの)。 */
  readonly skills?: readonly string[];
  /** ai_employees.icon (S-C02 で選んだ lucide 名)。頭文字の代わりに描画。 */
  readonly iconName?: string;
}

export interface OrgChartProps {
  readonly nodes: readonly OrgNode[];
  /** 実 UUID (OrgNode.selectId) を受け取る。 */
  readonly onSelect?: (id: string) => void;
}

/** モック S-C01-org.html の部署名に一致させる (dept-name)。 */
export const DEPT_LABEL = {
  executive: "経営",
  sales: "営業・契約部",
  product: "プロダクト企画部",
  architecture: "設計部",
  design: "デザイン部",
  dev_qa: "開発・検証部",
  cross_functional: "全社横断",
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
  const skillsLine =
    node.skills === undefined
      ? null
      : node.skills.length === 0
        ? "スキル未装着"
        : `${node.skills.length} skills · ${node.skills.slice(0, 3).join(", ")}${node.skills.length > 3 ? ` +${node.skills.length - 3}` : ""}`;
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
      <EmployeeIcon
        employeeId={node.id}
        size={size}
        {...(node.iconName ? { iconName: node.iconName } : {})}
      />
      <span className={cn("text-[15px] font-bold leading-tight", t.name)}>
        {node.displayName}
      </span>
      {node.enName ? (
        <span className="-mt-1 text-[11px] italic text-on-surface-variant">
          {node.enName}
        </span>
      ) : null}
      {node.roleLabel ? (
        <span
          className={cn(
            "text-[11px] font-semibold",
            tone === "coo" || node.roleLabel !== "メンバー"
              ? "text-primary"
              : "text-on-surface",
            tone === "cross" && "text-tertiary",
          )}
        >
          {node.roleLabel}
        </span>
      ) : null}
      {skillsLine ? (
        <span className="text-[10.5px] leading-snug text-on-surface-variant">
          {skillsLine}
        </span>
      ) : null}
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
