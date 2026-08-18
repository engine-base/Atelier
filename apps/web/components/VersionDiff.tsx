/**
 * GAP-155: バージョン間差分の共有 UI (モック S-H01 / 成果物 S-G01 共通)。
 *
 * サーバ側 (difflib) が実 HTML 2 版から計算した unified diff の実値を
 * 行単位で色分け表示する。クライアントでの再計算・近似はしない。
 */

"use client";

import * as React from "react";

/** サーバ計算の unified diff (GET /{mocks,outputs}/{id}/diff/{other_id})。 */
export interface VersionDiffView {
  readonly fromVersion: number;
  readonly toVersion: number;
  readonly added: number;
  readonly removed: number;
  readonly identical: boolean;
  readonly diff: string;
}

/** unified diff を行単位で色分け表示する (追加=緑系 / 削除=赤系 / hunk=青系)。 */
export function DiffLines({ diff }: { readonly diff: string }) {
  return (
    <pre
      aria-label="差分本文"
      className="overflow-x-auto whitespace-pre rounded-md border border-border bg-surface p-3 text-[11.5px] leading-relaxed text-on-surface"
    >
      {diff.split("\n").map((ln, i) => {
        const cls = ln.startsWith("@@")
          ? "text-primary"
          : ln.startsWith("+++") || ln.startsWith("---")
            ? "font-bold text-on-surface-variant"
            : ln.startsWith("+")
              ? "bg-tertiary-container/60 text-on-surface"
              : ln.startsWith("-")
                ? "bg-error/10 text-error"
                : "text-on-surface-variant";
        return (
          <span key={i} className={`block px-1 ${cls}`}>
            {ln === "" ? " " : ln}
          </span>
        );
      })}
    </pre>
  );
}

export interface DiffModalProps {
  readonly view: VersionDiffView;
  readonly onClose?: () => void;
}

/** 差分モーダル (ヘッダー: v{from} → v{to} + 追加/削除行数、本文: DiffLines)。 */
export function DiffModal({ view, onClose }: DiffModalProps) {
  return (
    <div
      role="dialog"
      aria-label="バージョン間差分"
      className="fixed inset-0 z-[600] flex items-center justify-center bg-black/50 p-6"
    >
      <div className="flex max-h-[85vh] w-full max-w-[880px] flex-col overflow-hidden rounded-lg border border-border bg-surface shadow-lg">
        <div className="flex items-center gap-3 border-b border-border px-md py-3">
          <h2 className="text-[13.5px] font-bold text-on-surface">
            v{view.fromVersion} → v{view.toVersion} の差分
          </h2>
          {view.identical ? (
            <span className="inline-flex items-center rounded-sm bg-tertiary-container px-2 py-0.5 text-[10.5px] font-semibold text-tertiary-container-fg">
              内容は同一です
            </span>
          ) : (
            <span className="text-[11.5px] tabular-nums text-on-surface-variant">
              <span className="font-semibold text-tertiary">+{view.added}</span>{" "}
              / <span className="font-semibold text-error">−{view.removed}</span>{" "}
              行
            </span>
          )}
          {onClose ? (
            <button
              type="button"
              onClick={onClose}
              aria-label="差分を閉じる"
              className="ml-auto rounded-md px-2.5 py-1 text-[12px] font-semibold text-on-surface-variant hover:bg-surface-variant"
            >
              閉じる ✕
            </button>
          ) : null}
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto p-md">
          {view.identical ? (
            <p className="py-lg text-center text-body-sm text-on-surface-variant">
              この 2 つのバージョンの本文は同一です（複製・復元などで内容が変わっていません）。
            </p>
          ) : (
            <DiffLines diff={view.diff} />
          )}
        </div>
      </div>
    </div>
  );
}
