/**
 * S-G01 成果物ビューア — T-UC-12 / GAP-023 (presentational)
 *
 * モック(06_mockups/output/S-G01-viewer.html)準拠の 2 ペイン構成:
 *   - viewer-main : ツールバー(HTML/JSON/MD タブ + バージョン選択 + 最新版バッジ +
 *     編集/原本/DL) + プレビュー(成果物ヘッダ + 署名付き URL の iframe or テキスト)
 *   - comment-panel : コメント一覧 (対象位置チップ + 本文へジャンプ + 返信 +
 *     AI 修正提案 承認/却下) + 追加コンポーザ (対象位置ピッカー)
 *
 * GAP-023 で全要素を実 API 配線:
 *   - タブは実在する format のみ描画 (json/md 未生成のタブは出さない — Rule 10)
 *   - 「編集」= ドキュメント AI (スティーブ) への修正依頼 → 新バージョン
 *     (GAP-024 S-H01 と同型の Open Design パターン)
 *   - AI 修正提案はモックの ai-fix ブロック — 人間の明示操作で生成し、
 *     承認で新バージョン適用 / 却下で不変
 *   - 「本文へ →」は iframe の URL フラグメント (#element_id) で実ジャンプ
 * 実 API 配線は OutputViewerContainer が担う。
 */

"use client";

import * as React from "react";
import { useState } from "react";
import Link from "next/link";

import { cn } from "../../../../lib/cn";
import {
  DiffModal,
  type VersionDiffView,
} from "../../../../components/VersionDiff";

export type OutputFormat = "html" | "json" | "md";

const FORMAT_LABEL: Record<OutputFormat, string> = {
  html: "HTML",
  json: "JSON",
  md: "MD",
};

export interface OutputComment {
  readonly id: string;
  readonly author: string;
  readonly content: string;
  readonly createdAt: string;
  readonly resolved?: boolean;
  readonly isReply?: boolean;
  /** コメント対象の実要素 id (comments.target_element_id)。 */
  readonly targetElementId?: string;
  /** 対象位置の表示ラベル (anchors 由来。無ければ element id)。 */
  readonly targetLabel?: string;
  /** 楽観追加中 (サーバー未永続)。操作ボタンを出さない — 偽 id で API を叩かない。 */
  readonly pending?: boolean;
}

export interface OutputVersionItem {
  readonly id: string;
  readonly version: number;
  /** YYYY-MM-DD HH:mm 済み表示文字列 */
  readonly createdAt: string;
  readonly current: boolean;
  /** meta.author=steve → 「スティーブ（更新）」 */
  readonly author?: string;
}

export interface OutputAnchorItem {
  readonly elementId: string;
  readonly label: string;
}

export interface OutputFixProposalItem {
  readonly id: string;
  readonly commentId: string;
  readonly proposal: string;
  readonly status: "pending" | "approved" | "rejected";
  /** approved 時の適用先バージョン表示 (例: "v2")。 */
  readonly appliedVersionLabel?: string;
  /** approved 時の適用先へのリンク。 */
  readonly appliedHref?: string;
}

function authorInitial(author: string): string {
  const trimmed = author.trim();
  return trimmed ? Array.from(trimmed)[0]! : "?";
}

export interface OutputViewerProps {
  readonly title: string;
  /** HTML の署名付き閲覧 URL (iframe / 原本 / 本文へジャンプの実体)。
   *  null = 本文ファイルを持たない成果物 (営業ドラフト等 — journey v2 検出の
   *  是正: プレビューは無くてもコメント/バージョンは扱えるようにする)。 */
  readonly contentUrl: string | null;
  /** 実在する format のみ (存在しないタブは出さない — Rule 10)。 */
  readonly formats?: readonly OutputFormat[];
  readonly activeFormat?: OutputFormat;
  readonly onSelectFormat?: (format: OutputFormat) => void;
  /** JSON/MD タブの実テキスト (取得中は undefined)。 */
  readonly textContent?: string;
  readonly textLoading?: boolean;
  /** バージョン選択 (実 /outputs/{id}/versions)。 */
  readonly versions?: readonly OutputVersionItem[];
  readonly onSelectVersion?: (outputId: string) => void;
  /** 現在の format をダウンロード。 */
  readonly onDownload?: () => void;
  /** GAP-162: 共有リンク + 書き出しパネル (クライアントに渡す)。 */
  readonly shareSlot?: React.ReactNode;
  /** 「編集」= ドキュメント AI (スティーブ) への修正依頼。 */
  readonly onRevise?: (instruction: string) => void;
  readonly revising?: boolean;
  /** GAP-155: 前版との差分を開く (引数 = 比較相手の output id)。 */
  readonly onShowDiff?: (otherId: string) => void;
  /** GAP-155: 開いている差分 (null = 閉)。 */
  readonly diffView?: VersionDiffView | null;
  readonly diffLoading?: boolean;
  readonly onCloseDiff?: () => void;
  /** GAP-155: 表示中の旧版を新バージョンとして復元 (最新版表示中は出さない)。 */
  readonly onRestore?: () => void;
  readonly restoring?: boolean;
  readonly actionNotice?: string;
  readonly actionError?: string;
  readonly comments: readonly OutputComment[];
  /** コメント追加 (対象位置は anchors から任意選択)。 */
  readonly onAddComment?: (content: string, targetElementId?: string) => void;
  /** コメント対象位置の候補 (実 HTML の id 要素 — /outputs/{id}/anchors)。 */
  readonly anchors?: readonly OutputAnchorItem[];
  readonly onResolve?: (id: string) => void;
  /** スレッド返信 (parent_comment_id 付き POST /comments)。 */
  readonly onReply?: (parentCommentId: string, content: string) => void;
  /** AI 修正提案 (comment_id → 提案)。 */
  readonly proposals?: readonly OutputFixProposalItem[];
  /** 「スティーブに修正提案を依頼」。 */
  readonly onRequestProposal?: (commentId: string) => void;
  /** 依頼実行中の commentId。 */
  readonly proposalRequestingFor?: string;
  readonly onApproveProposal?: (proposalId: string) => void;
  readonly onRejectProposal?: (proposalId: string) => void;
  /** 提案の承認/却下 実行中の proposalId。 */
  readonly proposalResolving?: string;
  readonly className?: string;
}

export function OutputViewer({
  title,
  contentUrl,
  formats = ["html"],
  activeFormat = "html",
  onSelectFormat,
  textContent,
  textLoading = false,
  versions,
  onSelectVersion,
  onDownload,
  shareSlot,
  onRevise,
  revising = false,
  onShowDiff,
  diffView = null,
  diffLoading = false,
  onCloseDiff,
  onRestore,
  restoring = false,
  actionNotice,
  actionError,
  comments,
  onAddComment,
  anchors,
  onResolve,
  onReply,
  proposals,
  onRequestProposal,
  proposalRequestingFor,
  onApproveProposal,
  onRejectProposal,
  proposalResolving,
  className,
}: OutputViewerProps) {
  const openCount = comments.filter((c) => !c.resolved).length;
  const [draft, setDraft] = useState("");
  const [draftAnchor, setDraftAnchor] = useState("");
  const [editOpen, setEditOpen] = useState(false);
  const [instructionDraft, setInstructionDraft] = useState("");
  const [replyFor, setReplyFor] = useState<string | null>(null);
  const [replyDraft, setReplyDraft] = useState("");
  // 「本文へ →」ジャンプ: iframe の URL フラグメントで対象要素へスクロール
  const [jumpAnchor, setJumpAnchor] = useState<string | null>(null);

  const current = versions?.find((v) => v.current);
  const maxVersion = versions?.length
    ? Math.max(...versions.map((v) => v.version))
    : undefined;
  const isLatest =
    current !== undefined && maxVersion !== undefined
      ? current.version >= maxVersion
      : true;

  const frameSrc =
    contentUrl === null
      ? null
      : jumpAnchor
        ? `${contentUrl}#${jumpAnchor}`
        : contentUrl;
  // GAP-155: 表示中バージョンの直前の版 (差分の比較相手)
  const prevVersion =
    current !== undefined && versions !== undefined
      ? [...versions]
          .filter((v) => v.version < current.version)
          .sort((a, b) => b.version - a.version)[0]
      : undefined;
  const proposalOf = (commentId: string) =>
    proposals?.find((p) => p.commentId === commentId);

  return (
    <article className={cn("w-full", className)}>
      <div className="overflow-hidden rounded-lg border border-border bg-white">
        <div className="grid grid-cols-1 lg:grid-cols-[1fr_320px]">
          {/* ── viewer-main ─────────────────────────────── */}
          <div className="flex min-w-0 flex-col">
            {/* viewer-toolbar */}
            <div className="flex flex-wrap items-center gap-3 border-b border-border bg-white px-lg py-3">
              {/* tabs-row: 実在する format のみ */}
              <div
                role="tablist"
                aria-label="表示形式"
                className="flex gap-1 rounded-md bg-surface-variant p-1"
              >
                {formats.map((f) => (
                  <button
                    key={f}
                    type="button"
                    role="tab"
                    aria-selected={f === activeFormat}
                    onClick={() => onSelectFormat?.(f)}
                    className={cn(
                      "flex items-center gap-1.5 rounded-md px-3.5 py-1.5 text-[13px] font-semibold",
                      f === activeFormat
                        ? "bg-white text-on-surface shadow-sm"
                        : "text-on-surface-variant hover:text-on-surface",
                    )}
                  >
                    {FORMAT_LABEL[f]}
                  </button>
                ))}
              </div>

              {/* version-select (実バージョン) */}
              {versions && versions.length > 0 && onSelectVersion ? (
                <label className="flex items-center gap-1.5 rounded-md bg-surface-variant px-3 py-1.5 text-[12.5px]">
                  <strong className="font-bold text-on-surface">
                    バージョン
                  </strong>
                  <select
                    aria-label="バージョン選択"
                    value={current?.id ?? versions[versions.length - 1]?.id}
                    onChange={(e) => onSelectVersion(e.target.value)}
                    className="bg-transparent text-[12.5px] text-on-surface outline-none"
                  >
                    {[...versions]
                      .sort((a, b) => b.version - a.version)
                      .map((v) => (
                        <option key={v.id} value={v.id}>
                          v{v.version} · {v.createdAt}
                          {v.author ? ` · ${v.author}` : ""}
                        </option>
                      ))}
                  </select>
                </label>
              ) : null}

              {/* actions */}
              <div className="ml-auto flex items-center gap-2">
                {isLatest ? (
                  <span className="inline-flex items-center rounded-sm bg-tertiary-container px-2 py-0.5 text-[10.5px] font-semibold text-tertiary-container-fg">
                    最新版
                  </span>
                ) : null}
                {onShowDiff && prevVersion !== undefined ? (
                  <button
                    type="button"
                    onClick={() => onShowDiff(prevVersion.id)}
                    disabled={diffLoading}
                    aria-label={`v${prevVersion.version} との差分`}
                    className="rounded-md border border-border px-3 py-1.5 text-[12px] font-semibold text-on-surface transition-colors hover:bg-surface-variant disabled:opacity-50"
                  >
                    前版との差分
                  </button>
                ) : null}
                {onRestore && !isLatest ? (
                  <button
                    type="button"
                    onClick={onRestore}
                    disabled={restoring}
                    className="rounded-md border border-border px-3 py-1.5 text-[12px] font-semibold text-on-surface transition-colors hover:bg-surface-variant disabled:opacity-50"
                  >
                    {restoring ? "復元中…" : "この版を復元"}
                  </button>
                ) : null}
                {onRevise ? (
                  <button
                    type="button"
                    onClick={() => setEditOpen((v) => !v)}
                    aria-expanded={editOpen}
                    className="rounded-md border border-primary px-3 py-1.5 text-[12px] font-semibold text-primary transition-colors hover:bg-primary-container"
                  >
                    編集
                  </button>
                ) : null}
                {contentUrl !== null ? (
                  <a
                    href={contentUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="rounded-md border border-primary px-3 py-1.5 text-[12px] font-semibold text-primary transition-colors hover:bg-primary-container"
                  >
                    原本
                  </a>
                ) : null}
                {onDownload ? (
                  <button
                    type="button"
                    onClick={onDownload}
                    className="rounded-md px-3 py-1.5 text-[12px] font-semibold text-on-surface transition-colors hover:bg-surface-variant"
                  >
                    DL
                  </button>
                ) : null}
              </div>
            </div>

            {/* 編集 = ドキュメント AI (スティーブ) への修正依頼フォーム */}
            {onRevise && editOpen ? (
              <div
                role="dialog"
                aria-label="スティーブに修正を依頼"
                className="border-b border-border bg-secondary-container/40 px-lg py-md"
              >
                <h3 className="text-[13px] font-bold text-on-surface">
                  スティーブに修正を依頼
                </h3>
                <p className="mt-0.5 text-[11.5px] text-on-surface-variant">
                  ドキュメント AI「スティーブ」が指示に従って本文を改訂し、
                  新しいバージョンを作成します。
                </p>
                <form
                  onSubmit={(e) => {
                    e.preventDefault();
                    const text = instructionDraft.trim();
                    if (!text || revising) return;
                    onRevise(text);
                  }}
                >
                  <label className="mt-2 block">
                    <span className="sr-only">修正指示</span>
                    <textarea
                      value={instructionDraft}
                      onChange={(e) => setInstructionDraft(e.target.value)}
                      rows={3}
                      maxLength={4000}
                      disabled={revising}
                      placeholder="例: 2.5 項にクライアント招待モードでの可視範囲サブセクションを追加してください"
                      className="w-full resize-y rounded-md border border-border bg-surface px-sm py-2 text-[13px] text-on-surface outline-none placeholder:text-on-surface-variant focus-visible:border-primary disabled:opacity-60"
                    />
                  </label>
                  <div className="mt-2 flex items-center justify-end gap-xs">
                    {revising ? (
                      <span
                        role="status"
                        className="mr-auto text-[12px] text-on-surface-variant"
                      >
                        スティーブが改訂中です…（数十秒かかることがあります）
                      </span>
                    ) : null}
                    <button
                      type="button"
                      onClick={() => setEditOpen(false)}
                      disabled={revising}
                      className="rounded-md px-sm py-1.5 text-label-sm font-semibold text-on-surface-variant transition-colors hover:bg-surface-variant disabled:opacity-50"
                    >
                      キャンセル
                    </button>
                    <button
                      type="submit"
                      disabled={!instructionDraft.trim() || revising}
                      className="inline-flex items-center rounded-md bg-primary px-4 py-1.5 text-[12px] font-semibold text-on-primary transition-colors hover:bg-primary-hover disabled:opacity-50"
                    >
                      修正を依頼
                    </button>
                  </div>
                </form>
              </div>
            ) : null}

            {/* 操作結果通知 */}
            {actionError ? (
              <p
                role="alert"
                className="border-b border-border bg-error/10 px-lg py-2 text-[12.5px] text-error"
              >
                {actionError}
              </p>
            ) : actionNotice ? (
              <p
                role="status"
                className="border-b border-border bg-tertiary-container px-lg py-2 text-[12.5px] text-tertiary-container-fg"
              >
                {actionNotice}
              </p>
            ) : null}

            {/* preview-wrap */}
            <div className="flex-1 overflow-auto bg-surface-variant/30 p-8">
              <div className="mx-auto max-w-[760px] rounded-lg border border-border bg-white p-8 sm:p-12">
                <p className="mb-3 text-[11px] font-bold uppercase tracking-[0.14em] text-on-surface-variant">
                  Deliverable
                </p>
                <h1 className="mb-3.5 text-3xl font-bold tracking-tight text-on-surface">
                  {title}
                </h1>
                <div className="mb-7 border-b border-border pb-4 text-[13px] text-on-surface-variant">
                  {current ? `v${current.version}` : "最新版"}
                  {current?.author ? ` · ${current.author}` : ""} ·{" "}
                  {contentUrl === null
                    ? "本文プレビューなし"
                    : `${FORMAT_LABEL[activeFormat]} プレビュー`}
                </div>
                {contentUrl === null ? (
                  <p className="rounded-md border border-border bg-surface-variant/40 p-4 text-body-sm text-on-surface-variant">
                    この成果物は本文ファイルを持ちません（営業ドラフト等の本文は生成元の画面で管理されます）。
                    コメントへの返信・バージョンの確認はこの画面で行えます。
                  </p>
                ) : activeFormat === "html" ? (
                  <div className="overflow-hidden rounded-md border border-border">
                    <iframe
                      key={frameSrc}
                      title={title}
                      src={frameSrc ?? undefined}
                      className="h-[600px] w-full border-0 bg-white"
                    />
                  </div>
                ) : textLoading ? (
                  <p role="status" className="text-body-sm text-on-surface-variant">
                    {FORMAT_LABEL[activeFormat]} を読み込み中…
                  </p>
                ) : (
                  <pre className="max-h-[600px] overflow-auto rounded-md border border-border bg-surface-variant/40 p-4 text-[12.5px] leading-relaxed text-on-surface">
                    {textContent ?? ""}
                  </pre>
                )}
              </div>
            </div>
            {/* GAP-162: クライアントに渡す (共有リンク + 書き出し) */}
            {shareSlot}
          </div>

          {/* ── comment-panel ──────────────────────────── */}
          <aside
            aria-label="コメント"
            className="flex min-w-0 flex-col border-t border-border bg-white lg:border-l lg:border-t-0"
          >
            <div className="flex items-center justify-between border-b border-border px-lg py-3.5">
              <h2 className="text-[13px] font-bold text-on-surface">
                コメント（{comments.length}）
              </h2>
              {openCount > 0 ? (
                <span className="inline-flex items-center rounded-sm bg-secondary-container px-2 py-0.5 text-[10.5px] font-semibold text-secondary-container-fg">
                  未解決 {openCount}
                </span>
              ) : comments.length > 0 ? (
                <span className="inline-flex items-center rounded-sm bg-tertiary-container px-2 py-0.5 text-[10.5px] font-semibold text-tertiary-container-fg">
                  すべて解決済み
                </span>
              ) : null}
            </div>

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
                  {comments.map((c) => {
                    const proposal = proposalOf(c.id);
                    return (
                      <li
                        key={c.id}
                        className={cn(
                          "rounded-md p-3",
                          c.resolved
                            ? "bg-tertiary-container text-tertiary-container-fg"
                            : "bg-surface-variant",
                          c.isReply && "ml-4 border-l-2 border-border",
                        )}
                      >
                        {/* 対象位置チップ + 本文へジャンプ (target_element_id) */}
                        {c.targetElementId ? (
                          <div
                            className={cn(
                              "mb-1.5 flex items-center gap-1.5 rounded-sm px-2 py-1 text-[10.5px]",
                              c.resolved
                                ? "bg-tertiary/15"
                                : "bg-secondary/15",
                            )}
                          >
                            <span className="flex-1 font-semibold text-on-surface">
                              {c.targetLabel ?? c.targetElementId}
                            </span>
                            <button
                              type="button"
                              onClick={() =>
                                setJumpAnchor(c.targetElementId ?? null)
                              }
                              className="text-[10px] font-semibold text-primary hover:underline"
                            >
                              本文へ →
                            </button>
                          </div>
                        ) : null}
                        <div className="mb-1.5 flex items-center gap-2">
                          <span
                            aria-hidden="true"
                            className="inline-flex h-6 w-6 items-center justify-center rounded-full bg-primary text-[11px] font-bold text-on-primary"
                          >
                            {authorInitial(c.author)}
                          </span>
                          <span className="text-[12.5px] font-bold">
                            {c.author}
                          </span>
                          <span className="ml-auto text-[11px] tabular-nums opacity-80">
                            {c.resolved ? "解決済み · " : ""}
                            {c.createdAt}
                          </span>
                        </div>
                        <p className="text-[13px] leading-relaxed">
                          {c.content}
                        </p>

                        {/* AI 修正提案 (モック ai-fix ブロック) */}
                        {proposal ? (
                          <div className="mt-2 rounded-md bg-primary-container px-3 py-2.5 text-[12px] text-on-primary-container">
                            <strong className="font-bold">
                              スティーブの修正提案：
                            </strong>
                            <p className="mt-1">{proposal.proposal}</p>
                            {proposal.status === "pending" &&
                            onApproveProposal &&
                            onRejectProposal ? (
                              <div className="mt-2 flex items-center gap-2">
                                {proposalResolving === proposal.id ? (
                                  <span role="status" className="text-[11px]">
                                    適用中…
                                  </span>
                                ) : (
                                  <>
                                    <button
                                      type="button"
                                      onClick={() =>
                                        onApproveProposal(proposal.id)
                                      }
                                      className="rounded-md bg-primary px-3 py-1 text-[11.5px] font-semibold text-on-primary hover:bg-primary-hover"
                                    >
                                      承認
                                    </button>
                                    <button
                                      type="button"
                                      onClick={() =>
                                        onRejectProposal(proposal.id)
                                      }
                                      className="rounded-md px-3 py-1 text-[11.5px] font-semibold text-on-primary-container hover:bg-white/40"
                                    >
                                      却下
                                    </button>
                                  </>
                                )}
                              </div>
                            ) : proposal.status === "approved" ? (
                              <p className="mt-1.5 text-[11px] font-semibold">
                                承認済み
                                {proposal.appliedHref ? (
                                  <>
                                    {" · "}
                                    <Link
                                      href={proposal.appliedHref}
                                      className="underline"
                                    >
                                      適用先 {proposal.appliedVersionLabel} を表示
                                    </Link>
                                  </>
                                ) : null}
                              </p>
                            ) : (
                              <p className="mt-1.5 text-[11px] font-semibold opacity-80">
                                却下済み（文書は変更されていません）
                              </p>
                            )}
                          </div>
                        ) : null}

                        <div className="mt-2 flex items-center justify-end gap-1">
                          {!c.pending &&
                          !c.isReply &&
                          !proposal &&
                          !c.resolved &&
                          onRequestProposal ? (
                            proposalRequestingFor === c.id ? (
                              <span
                                role="status"
                                className="mr-auto text-[11px] text-on-surface-variant"
                              >
                                スティーブが提案を作成中…
                              </span>
                            ) : (
                              <button
                                type="button"
                                onClick={() => onRequestProposal(c.id)}
                                className="mr-auto rounded-sm px-2 py-1 text-[11px] font-semibold text-primary hover:bg-primary-container"
                              >
                                スティーブに修正提案を依頼
                              </button>
                            )
                          ) : null}
                          {!c.pending && !c.isReply && onReply ? (
                            <button
                              type="button"
                              onClick={() => {
                                setReplyFor(replyFor === c.id ? null : c.id);
                                setReplyDraft("");
                              }}
                              className="rounded-sm px-2 py-1 text-[11px] font-semibold text-on-surface-variant hover:bg-white/60"
                            >
                              返信
                            </button>
                          ) : null}
                          {!c.pending && !c.resolved && onResolve ? (
                            <button
                              type="button"
                              onClick={() => onResolve(c.id)}
                              className="rounded-sm px-2 py-1 text-[11px] font-semibold text-tertiary hover:bg-white/60"
                            >
                              解決にする
                            </button>
                          ) : null}
                        </div>

                        {/* 返信コンポーザ */}
                        {onReply && replyFor === c.id ? (
                          <form
                            className="mt-2 rounded-md bg-white/70 p-2"
                            onSubmit={(e) => {
                              e.preventDefault();
                              const text = replyDraft.trim();
                              if (!text) return;
                              onReply(c.id, text);
                              setReplyFor(null);
                              setReplyDraft("");
                            }}
                          >
                            <label className="block">
                              <span className="sr-only">返信を入力</span>
                              <textarea
                                value={replyDraft}
                                onChange={(e) => setReplyDraft(e.target.value)}
                                rows={2}
                                placeholder="返信を入力…"
                                className="w-full resize-none border-0 bg-transparent text-[12.5px] text-on-surface outline-none placeholder:text-on-surface-variant"
                              />
                            </label>
                            <div className="mt-1 flex justify-end">
                              <button
                                type="submit"
                                disabled={!replyDraft.trim()}
                                className="rounded-md bg-primary px-3 py-1 text-[11.5px] font-semibold text-on-primary disabled:opacity-50"
                              >
                                返信する
                              </button>
                            </div>
                          </form>
                        ) : null}
                      </li>
                    );
                  })}
                </ul>
              )}
            </div>

            {/* comment-input (対象位置ピッカー付き) */}
            {onAddComment ? (
              <div className="border-t border-border p-md">
                <form
                  className="rounded-md bg-surface-variant p-2.5"
                  onSubmit={(e) => {
                    e.preventDefault();
                    const text = draft.trim();
                    if (!text) return;
                    onAddComment(text, draftAnchor || undefined);
                    setDraft("");
                    setDraftAnchor("");
                  }}
                >
                  {anchors && anchors.length > 0 ? (
                    <label className="mb-1.5 block">
                      <span className="sr-only">コメント対象位置</span>
                      <select
                        value={draftAnchor}
                        onChange={(e) => setDraftAnchor(e.target.value)}
                        className="w-full rounded-sm border border-border bg-white px-2 py-1 text-[11.5px] text-on-surface outline-none"
                      >
                        <option value="">対象位置を選択（任意）</option>
                        {anchors.map((a) => (
                          <option key={a.elementId} value={a.elementId}>
                            {a.label}
                          </option>
                        ))}
                      </select>
                    </label>
                  ) : null}
                  <label className="block">
                    <span className="sr-only">コメントを追加</span>
                    <textarea
                      value={draft}
                      onChange={(e) => setDraft(e.target.value)}
                      rows={2}
                      placeholder="選択箇所にコメント..."
                      className="w-full resize-none border-0 bg-transparent text-[13px] text-on-surface outline-none placeholder:text-on-surface-variant"
                    />
                  </label>
                  <div className="mt-2 flex justify-end">
                    <button
                      type="submit"
                      disabled={!draft.trim()}
                      className="inline-flex items-center rounded-md bg-primary px-4 py-1.5 text-[12px] font-semibold text-on-primary transition-colors hover:bg-primary-hover disabled:opacity-50"
                    >
                      投稿
                    </button>
                  </div>
                </form>
              </div>
            ) : null}
          </aside>
        </div>
      </div>

      {/* ── GAP-155: バージョン間差分モーダル (サーバ計算の unified diff) ── */}
      {diffView !== null ? (
        <DiffModal view={diffView} onClose={onCloseDiff} />
      ) : null}
    </article>
  );
}
