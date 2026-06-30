/**
 * S-L03 クライアントプロジェクトビュー — T-UC-22 (R-T08)
 *
 * クライアント向け project の限定ビュー (api/schemas/client_signin.py の
 * ClientProjectView に対応)。description / scopes / viewed_as_client_display_name を表示。
 */

"use client";

import * as React from "react";

import { cn } from "../../../../lib/cn";

export interface ClientProjectViewData {
  readonly id: string;
  readonly name: string;
  readonly description: string | null;
  readonly scopes: readonly string[];
  readonly viewed_as_client_display_name: string | null;
}

export interface ClientProjectViewProps {
  readonly data: ClientProjectViewData;
  readonly className?: string;
}

const SCOPE_LABEL: Record<string, string> = {
  view: "閲覧",
  comment: "コメント",
  approve: "承認",
};

export function ClientProjectView({ data, className }: ClientProjectViewProps) {
  return (
    <article className={cn("flex flex-col gap-md", className)}>
      <header className="flex items-baseline justify-between gap-md">
        <h1 className="text-headline-md font-bold text-on-surface">
          {data.name}
        </h1>
        {data.viewed_as_client_display_name ? (
          <span className="text-label-md text-on-surface-variant">
            {data.viewed_as_client_display_name}
          </span>
        ) : null}
      </header>
      {data.description ? (
        <p className="text-body-md text-on-surface">{data.description}</p>
      ) : null}
      <section aria-label="権限" className="flex flex-wrap gap-xs">
        {data.scopes.map((s) => (
          <span
            key={s}
            className="inline-flex items-center rounded-full bg-primary-container px-sm py-xs text-label-md text-primary-container-fg"
          >
            {SCOPE_LABEL[s] ?? s}
          </span>
        ))}
      </section>
    </article>
  );
}
