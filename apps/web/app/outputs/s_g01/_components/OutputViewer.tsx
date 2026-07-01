/**
 * S-G01 成果物ビューア — T-UC-12
 *
 * 成果物 HTML を署名付き URL の iframe で安全に表示し、コメントを一覧表示する。
 * モック(06_mockups/output/S-G01-viewer.html)準拠: コメント件数ヘッダ + 各コメントの
 * 投稿者/時刻 + 追加用 textarea。座標ピン/スレッド返信/承認却下は API 非対応のため対象外。
 * presentational（props 駆動）。実 API 配線は OutputViewerContainer が担う。
 */

"use client";

import * as React from "react";
import { useState } from "react";

import { cn } from "../../../../lib/cn";

export interface OutputComment {
  readonly id: string;
  readonly author: string;
  readonly content: string;
  readonly createdAt: string;
}

export interface OutputViewerProps {
  readonly title: string;
  readonly contentUrl: string;
  readonly comments: readonly OutputComment[];
  /** コメント追加。未指定なら追加フォームを出さない。 */
  readonly onAddComment?: (content: string) => void;
  readonly className?: string;
}

export function OutputViewer({
  title,
  contentUrl,
  comments,
  onAddComment,
  className,
}: OutputViewerProps) {
  const [draft, setDraft] = useState("");

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
          コメント（{comments.length}）
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
                <p className="text-label-sm text-on-surface-variant">
                  {c.author}・{c.createdAt}
                </p>
                <p className="text-body-sm text-on-surface">{c.content}</p>
              </li>
            ))}
          </ul>
        )}
        {onAddComment ? (
          <form
            className="flex flex-col gap-xs"
            onSubmit={(e) => {
              e.preventDefault();
              const text = draft.trim();
              if (!text) return;
              onAddComment(text);
              setDraft("");
            }}
          >
            <label className="flex flex-col gap-xs">
              <span className="sr-only">コメントを追加</span>
              <textarea
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                rows={2}
                placeholder="コメントを追加…"
                className="w-full rounded-md border border-surface-variant bg-surface px-sm py-xs text-body-sm text-on-surface"
              />
            </label>
            <button
              type="submit"
              disabled={!draft.trim()}
              className="inline-flex h-8 w-fit items-center rounded-md bg-primary px-md text-label-md text-primary-fg disabled:opacity-50"
            >
              コメント
            </button>
          </form>
        ) : null}
      </section>
    </article>
  );
}
