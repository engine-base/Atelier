/**
 * S-T01 運営ダッシュボード (ダーク) — T-UC-30
 *
 * AdminShell (Bundle B) 配下に置く想定の dashboard。KPI tiles + 最近のアクティビティ。
 */

'use client';

import * as React from 'react';

import { cn } from '../../../../lib/cn';

export interface AdminKpi {
  readonly id: string;
  readonly label: string;
  readonly value: number | string;
}

export interface AdminActivity {
  readonly id: string;
  readonly ts: string;
  readonly action: string;
  readonly actor: string;
}

export interface AdminDashboardProps {
  readonly kpis: readonly AdminKpi[];
  readonly recent: readonly AdminActivity[];
}

export function AdminDashboard({ kpis, recent }: AdminDashboardProps) {
  return (
    <section className="flex flex-col gap-lg">
      <h1 className="text-headline-md font-bold text-surface">運営ダッシュボード</h1>
      <section aria-label="KPI" className="grid grid-cols-2 gap-md md:grid-cols-4">
        {kpis.map((k) => (
          <article
            key={k.id}
            className={cn(
              'flex flex-col gap-xs rounded-md bg-surface/10 p-md text-surface',
            )}
          >
            <span className="text-label-md text-surface-variant">{k.label}</span>
            <span className="text-headline-md font-bold">{k.value}</span>
          </article>
        ))}
      </section>
      <section aria-label="最近のアクティビティ">
        <h2 className="text-label-lg font-semibold text-surface">最近のアクティビティ</h2>
        <ul role="list" className="mt-sm flex flex-col gap-xs">
          {recent.length === 0 ? (
            <li className="text-label-md text-surface-variant">アクティビティはまだありません</li>
          ) : (
            recent.map((a) => (
              <li
                key={a.id}
                className="flex gap-md rounded-sm border-b border-surface-variant/20 py-xs text-body-sm text-surface"
              >
                <time className="text-surface-variant">{a.ts}</time>
                <span className="font-semibold">{a.actor}</span>
                <span>{a.action}</span>
              </li>
            ))
          )}
        </ul>
      </section>
    </section>
  );
}
