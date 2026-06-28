/**
 * S-B04 シークレットへの登録フォーム。name / kind / value を入力。
 * value は登録時にのみ送信し、保存後は二度と画面に保持しない。
 */

'use client';

import * as React from 'react';
import { useState } from 'react';

export interface CredentialInput {
  readonly name: string;
  readonly kind: string;
  readonly value: string;
}

const KINDS: ReadonlyArray<{ value: string; label: string }> = [
  { value: 'api_key', label: 'API キー' },
  { value: 'password', label: 'パスワード' },
  { value: 'token', label: 'トークン' },
  { value: 'connection_string', label: '接続文字列' },
  { value: 'other', label: 'その他' },
];

interface CredentialFormProps {
  readonly onSubmit: (input: CredentialInput) => Promise<void>;
}

export function CredentialForm({ onSubmit }: CredentialFormProps) {
  const [name, setName] = useState('');
  const [kind, setKind] = useState('other');
  const [value, setValue] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault();
    setError(null);
    if (!name.trim() || !value) {
      setError('名前と値は必須です。');
      return;
    }
    setBusy(true);
    try {
      await onSubmit({ name: name.trim(), kind, value });
      setName('');
      setKind('other');
      setValue('');
    } catch (err) {
      setError(err instanceof Error ? err.message : '保存に失敗しました');
    } finally {
      setBusy(false);
    }
  };

  return (
    <form
      onSubmit={(e) => void submit(e)}
      className="flex flex-col gap-sm rounded-md border border-surface-variant bg-surface p-md"
    >
      <h2 className="text-label-lg font-semibold text-on-surface">新しいクレデンシャルを保管</h2>
      {error ? (
        <div role="alert" className="text-body-sm text-error">
          {error}
        </div>
      ) : null}
      <label className="flex flex-col gap-xs text-label-md text-on-surface-variant">
        名前
        <input
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="例: 顧客Slack Bot Token"
          className="rounded-sm border border-surface-variant bg-surface px-sm py-xs text-on-surface"
        />
      </label>
      <label className="flex flex-col gap-xs text-label-md text-on-surface-variant">
        種別
        <select
          value={kind}
          onChange={(e) => setKind(e.target.value)}
          className="rounded-sm border border-surface-variant bg-surface px-sm py-xs text-on-surface"
        >
          {KINDS.map((k) => (
            <option key={k.value} value={k.value}>
              {k.label}
            </option>
          ))}
        </select>
      </label>
      <label className="flex flex-col gap-xs text-label-md text-on-surface-variant">
        値（保存後は表示時のみ復号されます）
        <input
          type="password"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          autoComplete="off"
          className="rounded-sm border border-surface-variant bg-surface px-sm py-xs font-mono text-on-surface"
        />
      </label>
      <button
        type="submit"
        disabled={busy}
        className="mt-xs self-start rounded-md bg-primary px-md py-xs text-label-lg font-semibold text-primary-fg disabled:opacity-50"
      >
        {busy ? '保管中…' : '保管する'}
      </button>
    </form>
  );
}
