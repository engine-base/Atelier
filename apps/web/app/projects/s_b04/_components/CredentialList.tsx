/**
 * S-B04 シークレット一覧 — 値はマスク表示 (●●●●last4)。
 * 「表示」で reveal API を叩いて一時的に平文を見せる (クリップボードコピー可)。
 */

"use client";

import * as React from "react";
import { useState } from "react";

import { cn } from "../../../../lib/cn";

export interface CredentialRow {
  readonly id: string;
  readonly name: string;
  readonly kind: string;
  readonly last4: string | null;
  readonly created_at: string;
}

const KIND_LABEL: Record<string, string> = {
  api_key: "API キー",
  password: "パスワード",
  token: "トークン",
  connection_string: "接続文字列",
  other: "その他",
};

interface CredentialListProps {
  readonly rows: readonly CredentialRow[];
  readonly onReveal: (id: string) => Promise<string>;
  readonly onDelete: (id: string) => void;
}

export function CredentialList({
  rows,
  onReveal,
  onDelete,
}: CredentialListProps) {
  const [revealed, setRevealed] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);

  const reveal = async (id: string): Promise<void> => {
    setBusy(id);
    try {
      const value = await onReveal(id);
      setRevealed((p) => ({ ...p, [id]: value }));
    } finally {
      setBusy(null);
    }
  };

  const hide = (id: string): void =>
    setRevealed((p) => {
      const next = { ...p };
      delete next[id];
      return next;
    });

  if (rows.length === 0) {
    return (
      <p className="text-on-surface-variant">まだ何も保管されていません。</p>
    );
  }

  return (
    <ul className="flex flex-col gap-sm">
      {rows.map((r) => {
        const shown = revealed[r.id];
        return (
          <li
            key={r.id}
            className="flex items-center justify-between gap-md rounded-md border border-surface-variant bg-surface px-md py-sm"
          >
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-sm">
                <span className="truncate font-semibold text-on-surface">
                  {r.name}
                </span>
                <span className="rounded-sm bg-surface-variant px-xs text-label-sm text-on-surface-variant">
                  {KIND_LABEL[r.kind] ?? r.kind}
                </span>
              </div>
              <code className="mt-xs block truncate text-body-sm text-on-surface-variant">
                {shown ?? `••••••••${r.last4 ?? ""}`}
              </code>
            </div>
            <div className="flex shrink-0 items-center gap-xs">
              {shown ? (
                <>
                  <button
                    type="button"
                    onClick={() => void navigator.clipboard?.writeText(shown)}
                    className="rounded-sm px-sm py-xs text-label-md text-primary hover:bg-surface-variant"
                  >
                    コピー
                  </button>
                  <button
                    type="button"
                    onClick={() => hide(r.id)}
                    className="rounded-sm px-sm py-xs text-label-md text-on-surface-variant hover:bg-surface-variant"
                  >
                    隠す
                  </button>
                </>
              ) : (
                <button
                  type="button"
                  disabled={busy === r.id}
                  onClick={() => void reveal(r.id)}
                  className={cn(
                    "rounded-sm px-sm py-xs text-label-md text-primary hover:bg-surface-variant",
                    busy === r.id && "opacity-50",
                  )}
                >
                  {busy === r.id ? "復号中…" : "表示"}
                </button>
              )}
              <button
                type="button"
                onClick={() => onDelete(r.id)}
                className="rounded-sm px-sm py-xs text-label-md text-error hover:bg-surface-variant"
              >
                削除
              </button>
            </div>
          </li>
        );
      })}
    </ul>
  );
}
