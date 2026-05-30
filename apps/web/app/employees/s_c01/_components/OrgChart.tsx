/**
 * S-C01 AI 社員組織図 — T-UC-06
 *
 * EmployeeIcon (Bundle C) を使った AI 社員のグルーピング表示。
 * 役割別 (executive / engineer / pm / specialist) で section 化。
 */

'use client';

import * as React from 'react';

import { EmployeeIcon, type EmployeeId } from '../../../../components/EmployeeIcon';
import { cn } from '../../../../lib/cn';

export interface OrgNode {
  readonly id: EmployeeId;
  readonly displayName: string;
  readonly role: 'executive' | 'engineer' | 'pm' | 'specialist';
}

export interface OrgChartProps {
  readonly nodes: readonly OrgNode[];
  readonly onSelect?: (id: EmployeeId) => void;
}

const ROLE_LABEL = {
  executive: 'エグゼクティブ',
  engineer: 'エンジニア',
  pm: 'プロジェクト マネージャー',
  specialist: 'スペシャリスト',
} as const;

export function OrgChart({ nodes, onSelect }: OrgChartProps) {
  const byRole = (Object.keys(ROLE_LABEL) as Array<keyof typeof ROLE_LABEL>).map((r) => ({
    role: r,
    members: nodes.filter((n) => n.role === r),
  }));
  return (
    <section aria-label="AI 社員組織図" className="flex flex-col gap-lg">
      {byRole.map(({ role, members }) =>
        members.length === 0 ? null : (
          <article key={role} aria-label={ROLE_LABEL[role]} className="flex flex-col gap-sm">
            <h2 className="text-label-lg font-semibold text-on-surface-variant">
              {ROLE_LABEL[role]}
            </h2>
            <ul role="list" className="flex flex-wrap gap-md">
              {members.map((n) => (
                <li key={n.id}>
                  <button
                    type="button"
                    onClick={() => onSelect?.(n.id)}
                    aria-label={`${n.displayName} の詳細`}
                    className={cn(
                      'flex flex-col items-center gap-xs rounded-md p-sm',
                      onSelect && 'hover:bg-surface-variant/40',
                    )}
                  >
                    <EmployeeIcon employeeId={n.id} size="lg" />
                    <span className="text-label-md text-on-surface">{n.displayName}</span>
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
