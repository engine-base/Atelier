/**
 * S-G01 成果物ビューア — T-UC-12 / F-VIS 是正 (presentational)
 *
 * モック(06_mockups/output/S-G01-viewer.html)準拠の 2 ペイン構成で描画する:
 *   - viewer-main : ツールバー(HTML/JSON/MD タブ + バージョン + 最新版バッジ + 編集/原本)
 *                   + プレビュー(成果物ヘッダ + 署名付き URL の iframe)
 *   - comment-panel : コメント件数ヘッダ + コメントカード一覧 + 追加用コンポーザ
 * 実データ束縛は title / contentUrl / comments / onAddComment のみ。タブ・バージョン・
 * アクション等は API 非対応の視覚クロームで、モックの構成・文言に忠実に静的描画する。
 * 座標ピン/スレッド返信/承認却下は API 非対応のため対象外。
 * 実 API 配線は OutputViewerContainer が担う。
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

const FORMAT_TABS = ["HTML", "JSON", "MD"] as const;

function authorInitial(author: string): string {
  const trimmed = author.trim();
  return trimmed ? Array.from(trimmed)[0]! : "?";
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
    <article className={cn("w-full", className)}>
      <div className="overflow-hidden rounded-lg border border-border bg-white">
        <div className="grid grid-cols-1 lg:grid-cols-[1fr_320px]">
          {/* ── viewer-main ─────────────────────────────── */}
          <div className="flex min-w-0 flex-col">
            {/* viewer-toolbar */}
            <div className="flex flex-wrap items-center gap-3 border-b border-border bg-white px-lg py-3">
              {/* tabs-row */}
              <div
                role="tablist"
                aria-label="表示形式"
                className="flex gap-1 rounded-md bg-surface-variant p-1"
              >
                {FORMAT_TABS.map((tab, i) => (
                  <span
                    key={tab}
                    role="tab"
                    aria-selected={i === 0}
                    className={cn(
                      "flex items-center gap-1.5 rounded-md px-3.5 py-1.5 text-[13px] font-semibold",
                      i === 0
                        ? "bg-white text-on-surface shadow-sm"
                        : "text-on-surface-variant",
                    )}
                  >
                    {tab}
                  </span>
                ))}
              </div>

              {/* version-select */}
              <div className="flex items-center gap-1.5 rounded-md bg-surface-variant px-3 py-1.5 text-[12.5px]">
                <strong className="font-bold text-on-surface">バージョン</strong>
                <span className="text-on-surface-variant">最新</span>
                <span aria-hidden="true" className="text-on-surface-variant">
                  ▾
                </span>
              </div>

              {/* actions */}
              <div className="ml-auto flex items-center gap-2">
                <span className="inline-flex items-center rounded-sm bg-tertiary-container px-2 py-0.5 text-[10.5px] font-semibold text-tertiary-container-fg">
                  最新版
                </span>
                {/* 成果物は GET のみ(編集APIなし)。機能を偽らないよう編集は非活性。 */}
                <button
                  type="button"
                  disabled
                  title="この成果物は閲覧専用です"
                  className="cursor-not-allowed rounded-md px-3 py-1.5 text-[12px] font-semibold text-on-surface opacity-50"
                >
                  編集
                </button>
                <a
                  href={contentUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="rounded-md border border-primary px-3 py-1.5 text-[12px] font-semibold text-primary transition-colors hover:bg-primary-container"
                >
                  原本
                </a>
              </div>
            </div>

            {/* preview-wrap */}
            <div className="flex-1 overflow-auto bg-surface-variant/30 p-8">
              <div className="mx-auto max-w-[760px] rounded-lg border border-border bg-white p-8 sm:p-12">
                {/* 成果物ヘッダ(eyebrow + タイトル + メタ) */}
                <p className="mb-3 text-[11px] font-bold uppercase tracking-[0.14em] text-on-surface-variant">
                  Deliverable
                </p>
                <h1 className="mb-3.5 text-3xl font-bold tracking-tight text-on-surface">
                  {title}
                </h1>
                <div className="mb-7 border-b border-border pb-4 text-[13px] text-on-surface-variant">
                  最新版 · プレビュー
                </div>
                {/* プレビュー本体(署名付き URL) */}
                <div className="overflow-hidden rounded-md border border-border">
                  <iframe
                    title={title}
                    src={contentUrl}
                    className="h-[600px] w-full border-0 bg-white"
                  />
                </div>
              </div>
            </div>
          </div>

          {/* ── comment-panel ──────────────────────────── */}
          <aside
            aria-label="コメント"
            className="flex min-w-0 flex-col border-t border-border bg-white lg:border-l lg:border-t-0"
          >
            {/* comment-header */}
            <div className="flex items-center justify-between border-b border-border px-lg py-3.5">
              <h2 className="text-[13px] font-bold text-on-surface">
                コメント（{comments.length}）
              </h2>
              {comments.length > 0 ? (
                <span className="inline-flex items-center rounded-sm bg-secondary-container px-2 py-0.5 text-[10.5px] font-semibold text-secondary-container-fg">
                  {comments.length} 件
                </span>
              ) : null}
            </div>

            {/* comment-list */}
            <div className="flex-1 overflow-y-auto p-sm">
              {comments.length === 0 ? (
                <p className="px-md py-lg text-center text-body-sm text-on-surface-variant">
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
                      className="rounded-md bg-surface-variant p-3"
                    >
                      <div className="mb-1.5 flex items-center gap-2">
                        <span
                          aria-hidden="true"
                          className="inline-flex h-6 w-6 items-center justify-center rounded-full bg-primary text-[11px] font-bold text-on-primary"
                        >
                          {authorInitial(c.author)}
                        </span>
                        <span className="text-[12.5px] font-bold text-on-surface">
                          {c.author}
                        </span>
                        <span className="ml-auto text-[11px] tabular-nums text-on-surface-variant">
                          {c.createdAt}
                        </span>
                      </div>
                      <p className="text-[13px] leading-relaxed text-on-surface">
                        {c.content}
                      </p>
                    </li>
                  ))}
                </ul>
              )}
            </div>

            {/* comment-input */}
            {onAddComment ? (
              <div className="border-t border-border p-md">
                <form
                  className="rounded-md bg-surface-variant p-2.5"
                  onSubmit={(e) => {
                    e.preventDefault();
                    const text = draft.trim();
                    if (!text) return;
                    onAddComment(text);
                    setDraft("");
                  }}
                >
                  <label className="block">
                    <span className="sr-only">コメントを追加</span>
                    <textarea
                      value={draft}
                      onChange={(e) => setDraft(e.target.value)}
                      rows={2}
                      placeholder="コメントを追加…"
                      className="w-full resize-none border-0 bg-transparent text-[13px] text-on-surface outline-none placeholder:text-on-surface-variant"
                    />
                  </label>
                  <div className="mt-2 flex justify-end">
                    <button
                      type="submit"
                      disabled={!draft.trim()}
                      className="inline-flex items-center rounded-md bg-primary px-4 py-1.5 text-[12px] font-semibold text-on-primary transition-colors hover:bg-[#1E54D8] disabled:opacity-50"
                    >
                      コメント
                    </button>
                  </div>
                </form>
              </div>
            ) : null}
          </aside>
        </div>
      </div>
    </article>
  );
}
