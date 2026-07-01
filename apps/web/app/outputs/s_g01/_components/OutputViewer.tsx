/**
 * S-G01 成果物ビューア — T-UC-12
 *
 * 成果物 HTML を署名付き URL の iframe で安全に表示し、コメントを一覧表示する。
 * （旧: dangerouslySetInnerHTML + 座標ピン。コメント API に座標が無いため一覧型に変更）
 * presentational（props 駆動）。実 API 配線は OutputViewerContainer が担う。
 */

"use client";

import * as React from "react";

import { cn } from "../../../../lib/cn";

export interface OutputComment {
  readonly id: string;
  readonly author: string;
  readonly content: string;
}

export interface OutputViewerProps {
  readonly title: string;
  readonly contentUrl: string;
  readonly comments: readonly OutputComment[];
  readonly className?: string;
}

export function OutputViewer({
  title,
  contentUrl,
  comments,
  className,
}: OutputViewerProps) {
  return (
    <article className={cn("flex flex-col gap-md", className)}>
      <h1 className="text-headline-md font-bold text-on-surface">{title}</h1>
      <div className="overflow-hidden rounded-md bg-surface shadow-[var(--shadow-e1)]">
        <iframe
          title={title}
          src={contentUrl}
          className="h-[600px] w-full border-0 bg-surface"
        />
      </div>
      <section aria-label="コメント" className="flex flex-col gap-sm">
        <h2 className="text-label-lg font-semibold text-on-surface">
          コメント
        </h2>
        {comments.length === 0 ? (
          <p className="text-body-sm text-on-surface-variant">
            コメントはまだありません。
          </p>
        ) : (
          <ul
            role="list"
            aria-label="コメント一覧"
            className="flex flex-col gap-sm"
          >
            {comments.map((c) => (
              <li
                key={c.id}
                className="rounded-md border border-surface-variant px-md py-sm"
              >
                <p className="text-label-md font-semibold text-on-surface">
                  {c.author}
                </p>
                <p className="text-body-sm text-on-surface">{c.content}</p>
              </li>
            ))}
          </ul>
        )}
      </section>
    </article>
  );
}
