/**
 * S-B04 シークレットへの登録フォーム。name / kind / value を入力。
 * value は登録時にのみ送信し、保存後は二度と画面に保持しない。
 */

"use client";

import * as React from "react";
import { useState } from "react";

export interface CredentialInput {
  readonly name: string;
  readonly kind: string;
  readonly value: string;
}

const KINDS: ReadonlyArray<{ value: string; label: string }> = [
  { value: "api_key", label: "API キー" },
  { value: "password", label: "パスワード" },
  { value: "token", label: "トークン" },
  { value: "connection_string", label: "接続文字列" },
  { value: "other", label: "その他" },
];

interface CredentialFormProps {
  readonly onSubmit: (input: CredentialInput) => Promise<void>;
}

export function CredentialForm({ onSubmit }: CredentialFormProps) {
  const [name, setName] = useState("");
  const [kind, setKind] = useState("token");
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault();
    setError(null);
    if (!name.trim() || !value) {
      setError("名前と値は必須です。");
      return;
    }
    setBusy(true);
    try {
      await onSubmit({ name: name.trim(), kind, value });
      setName("");
      setKind("token");
      setValue("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "保存に失敗しました");
    } finally {
      setBusy(false);
    }
  };

  const fieldClass =
    "rounded-md border border-border bg-white px-3 py-2 text-sm text-on-surface placeholder:text-on-surface-variant focus:border-primary focus:outline-none";
  const labelClass = "text-sm font-medium text-on-surface-variant";

  return (
    <form
      onSubmit={(e) => void submit(e)}
      className="rounded-lg border border-border bg-white p-5 shadow-sm"
    >
      <h2 className="mb-4 text-base font-bold text-on-surface">新規追加</h2>
      {error ? (
        <div
          role="alert"
          className="mb-4 rounded-md border-l-[3px] border-l-error bg-error/10 p-3 text-sm text-error"
        >
          {error}
        </div>
      ) : null}

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <div className="flex flex-col gap-1.5">
          <label htmlFor="cred-name" className={labelClass}>
            名称
          </label>
          <input
            id="cred-name"
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="例: 顧客 Slack Bot Token"
            className={fieldClass}
          />
        </div>
        <div className="flex flex-col gap-1.5">
          <label htmlFor="cred-kind" className={labelClass}>
            種別
          </label>
          <select
            id="cred-kind"
            value={kind}
            onChange={(e) => setKind(e.target.value)}
            className={fieldClass}
          >
            {KINDS.map((k) => (
              <option key={k.value} value={k.value}>
                {k.label}
              </option>
            ))}
          </select>
        </div>
      </div>

      <div className="mt-4 flex flex-col gap-1.5">
        <label htmlFor="cred-value" className={labelClass}>
          値（保存後は二度と表示されません）
        </label>
        <input
          id="cred-value"
          type="password"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          autoComplete="off"
          placeholder="ここに貼り付け（保存時に暗号化）"
          className={`${fieldClass} font-mono`}
        />
      </div>

      <button
        type="submit"
        disabled={busy}
        className="mt-4 inline-flex items-center gap-2 rounded-md bg-primary px-4 py-2 text-sm font-semibold text-on-primary transition-colors hover:bg-[#1E54D8] focus-visible:outline-2 focus-visible:outline-primary disabled:opacity-50"
      >
        <KeyIcon className="h-4 w-4" />
        {busy ? "保存中…" : "暗号化して保存"}
      </button>
    </form>
  );
}

function KeyIcon({ className }: { readonly className?: string }) {
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
      <circle cx="7.5" cy="15.5" r="5.5" />
      <path d="m21 2-9.6 9.6" />
      <path d="m15.5 7.5 3 3L22 7l-3-3" />
    </svg>
  );
}
