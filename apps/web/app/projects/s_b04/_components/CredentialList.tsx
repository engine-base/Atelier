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
      <p className="py-12 text-center text-on-surface-variant">
        まだ何も保管されていません。
      </p>
    );
  }

  const thClass =
    "border-b border-border px-3 py-2.5 text-left text-xs font-semibold text-on-surface-variant";
  const tdClass = "border-b border-border px-3 py-3.5 align-middle";
  const ghostBtn =
    "inline-flex items-center gap-1 rounded-sm px-2 py-1 text-sm text-on-surface transition-colors hover:bg-surface-variant focus-visible:outline-2 focus-visible:outline-primary";

  return (
    <div className="overflow-x-auto">
      <table className="w-full border-collapse">
        <thead>
          <tr>
            <th className={thClass}>名称</th>
            <th className={thClass}>種別</th>
            <th className={thClass}>値</th>
            <th className={thClass}>作成日</th>
            <th className={`${thClass} text-right`}>操作</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => {
            const shown = revealed[r.id];
            return (
              <tr key={r.id} className="last:[&>td]:border-b-0 hover:bg-surface-variant/40">
                <td className={`${tdClass} text-sm font-semibold text-on-surface`}>
                  {r.name}
                </td>
                <td className={tdClass}>
                  <span className="inline-block rounded-full bg-surface-variant px-2 py-0.5 text-[11.5px] font-semibold text-on-surface">
                    {KIND_LABEL[r.kind] ?? r.kind}
                  </span>
                </td>
                <td className={tdClass}>
                  <code className="break-all font-mono text-sm tracking-wide text-on-surface-variant">
                    {shown ?? `••••••••${r.last4 ?? ""}`}
                  </code>
                </td>
                <td className={`${tdClass} whitespace-nowrap text-sm text-on-surface-variant`}>
                  {r.created_at}
                </td>
                <td className={`${tdClass} whitespace-nowrap text-right`}>
                  {shown ? (
                    <>
                      <button
                        type="button"
                        onClick={() => void navigator.clipboard?.writeText(shown)}
                        className={ghostBtn}
                      >
                        コピー
                      </button>
                      <button
                        type="button"
                        onClick={() => hide(r.id)}
                        className={cn(ghostBtn, "text-on-surface-variant")}
                      >
                        隠す
                      </button>
                    </>
                  ) : (
                    <button
                      type="button"
                      disabled={busy === r.id}
                      onClick={() => void reveal(r.id)}
                      className={cn(ghostBtn, busy === r.id && "opacity-50")}
                    >
                      <EyeIcon className="h-4 w-4" />
                      {busy === r.id ? "復号中…" : "表示"}
                    </button>
                  )}
                  <button
                    type="button"
                    aria-label="削除"
                    onClick={() => onDelete(r.id)}
                    className={cn(ghostBtn, "text-error")}
                  >
                    <TrashIcon className="h-4 w-4" />
                  </button>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function EyeIcon({ className }: { readonly className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7Z" />
      <circle cx="12" cy="12" r="3" />
    </svg>
  );
}

function TrashIcon({ className }: { readonly className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M3 6h18" />
      <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
    </svg>
  );
}
