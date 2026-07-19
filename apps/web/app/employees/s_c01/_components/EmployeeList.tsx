/**
 * S-C01 AI 社員リストビュー — 組織図トグルの「リスト」実体
 *
 * モックの view-toggle にあるリスト表示。組織図と同じ実データを表形式で描画する。
 * 行クリックで onSelect (S-C02 編集へ)。tone_preset ラベルも実データ。
 */

"use client";

import * as React from "react";

import {
  EmployeeIcon,
  EMPLOYEE_IDS,
  type EmployeeId,
} from "../../../../components/EmployeeIcon";
import { DEPT_LABEL, type OrgNode } from "./OrgChart";

export interface EmployeeListRow extends OrgNode {
  readonly tonePreset?: string;
}

const TONE_LABEL: Record<string, string> = {
  polite: "丁寧",
  friendly: "フレンドリー",
  casual: "カジュアル",
  concise: "簡潔",
  coaching: "コーチング",
};

export interface EmployeeListProps {
  readonly rows: readonly EmployeeListRow[];
  readonly onSelect?: (id: string) => void;
}

function isEmployeeId(v: string): v is EmployeeId {
  return (EMPLOYEE_IDS as readonly string[]).includes(v);
}

export function EmployeeList({ rows, onSelect }: EmployeeListProps) {
  return (
    <section aria-label="AI 社員リスト" className="overflow-x-auto rounded-lg border border-border bg-white">
      <table className="w-full min-w-[720px] border-collapse text-left">
        <thead>
          <tr className="border-b border-border bg-surface-variant text-[11.5px] font-bold tracking-[0.04em] text-on-surface-variant">
            <th scope="col" className="px-4 py-2.5">社員</th>
            <th scope="col" className="px-4 py-2.5">部署</th>
            <th scope="col" className="px-4 py-2.5">役割</th>
            <th scope="col" className="px-4 py-2.5">装着スキル</th>
            <th scope="col" className="px-4 py-2.5">口調</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr
              key={r.selectId}
              className="border-b border-border transition-colors last:border-b-0 hover:bg-surface-variant"
            >
              <td className="px-4 py-3">
                <button
                  type="button"
                  onClick={() => onSelect?.(r.selectId)}
                  aria-label={`${r.displayName} の詳細`}
                  className="flex items-center gap-2.5 text-left hover:text-primary"
                >
                  {isEmployeeId(r.id) ? (
                    <EmployeeIcon
                      employeeId={r.id}
                      size="sm"
                      {...(r.iconName ? { iconName: r.iconName } : {})}
                    />
                  ) : null}
                  <span>
                    <span className="block text-[13.5px] font-bold text-on-surface">
                      {r.displayName}
                    </span>
                    {r.enName ? (
                      <span className="block text-[10.5px] italic text-on-surface-variant">
                        {r.enName}
                      </span>
                    ) : null}
                  </span>
                </button>
              </td>
              <td className="px-4 py-3 text-[12.5px] text-on-surface">
                {DEPT_LABEL[r.department]}
              </td>
              <td className="px-4 py-3 text-[12.5px] font-semibold text-on-surface">
                {r.roleLabel ?? "—"}
              </td>
              <td className="max-w-[280px] px-4 py-3 text-[12px] text-on-surface-variant">
                {r.skills && r.skills.length > 0 ? r.skills.join(", ") : "スキル未装着"}
              </td>
              <td className="px-4 py-3 text-[12.5px] text-on-surface">
                {r.tonePreset ? (TONE_LABEL[r.tonePreset] ?? r.tonePreset) : "—"}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}
