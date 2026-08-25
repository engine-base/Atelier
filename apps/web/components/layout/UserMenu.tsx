/**
 * UserMenu — GAP-209: **出る口**をアプリ本体に用意する。
 *
 * これまでアバターは「プロフィールへのリンク 1 本」で、**サインアウトの導線が
 * アプリ本体に存在しなかった**（出られるのはクライアントポータルだけ）。
 * 共有 PC で使うと、前の人のセッションのまま次の人が使えてしまう。
 *
 * サインアウトは 3 つを必ずやる（`lib/auth/connector.ts` の `signOut`）:
 *   1. サーバー側で refresh token を失効（cookie を捨てるだけでは盗まれた
 *      token が生き続ける）
 *   2. cookie を捨てる
 *   3. localStorage も捨てる（前の人の文脈を次の人に見せない）
 */

'use client';

import * as React from 'react';
import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';
import { LogOut, User } from 'lucide-react';

import { signOut } from '../../lib/auth/connector';

const ITEM =
  'flex w-full items-center gap-2 px-3 py-2 text-left text-body-sm text-on-surface hover:bg-surface-variant';

export function UserMenu({
  label,
  onSignedOut,
}: {
  readonly label: string;
  /** テスト用に注入可能。既定はサインイン画面へ移動する。 */
  readonly onSignedOut?: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const doSignOut = async () => {
    setBusy(true);
    // **サーバーに繋がらなくても手元は片付ける**（出られない、を作らない）。
    // 失効まで完了したかは signOut の戻り値で分かるが、どちらでも画面は出る。
    await signOut();
    setOpen(false);
    setBusy(false);
    (onSignedOut ?? (() => window.location.assign('/signin')))();
  };

  return (
    <div ref={rootRef} className="relative">
      <button
        type="button"
        aria-label={`アカウント: ${label}`}
        title={label}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        className="inline-flex h-8 w-8 items-center justify-center rounded-full bg-surface-variant text-label-md font-semibold text-on-surface-variant transition-shadow hover:ring-2 hover:ring-primary-container"
      >
        {label.charAt(0).toUpperCase()}
      </button>
      {open ? (
        <div
          role="menu"
          aria-label="アカウントメニュー"
          className="absolute right-0 top-[calc(100%+6px)] z-[200] w-56 overflow-hidden rounded-md border border-border bg-surface shadow-lg"
        >
          <p className="truncate border-b border-border px-3 py-2 text-[11.5px] text-on-surface-variant">
            {label}
          </p>
          <Link
            href="/t-uc-37"
            role="menuitem"
            onClick={() => setOpen(false)}
            className={ITEM}
          >
            <User size={14} aria-hidden="true" />
            プロフィール
          </Link>
          <button
            type="button"
            role="menuitem"
            onClick={() => void doSignOut()}
            disabled={busy}
            className={`${ITEM} disabled:opacity-50`}
          >
            <LogOut size={14} aria-hidden="true" />
            {busy ? 'サインアウト中…' : 'サインアウト'}
          </button>
        </div>
      ) : null}
    </div>
  );
}
