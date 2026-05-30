/**
 * S-L01 クライアント招待管理 — T-UC-20
 *
 * client_invitations の管理。発行 / 失効 / 再送。R-T08 関連: 招待トークンは
 * 発行時にしか平文表示せず token_hash で保存。
 */

'use client';

import * as React from 'react';
import { useState } from 'react';

import { DataTable, type ColumnDef } from '../../../../components/data-table/DataTable';

export type InvitationStatus = 'pending' | 'used' | 'revoked' | 'expired';

export interface Invitation {
  readonly id: string;
  readonly email: string;
  readonly status: InvitationStatus;
  readonly expires_at: string;
}

const STATUS_LABEL: Record<InvitationStatus, string> = {
  pending: '未使用',
  used: '使用済',
  revoked: '失効',
  expired: '期限切れ',
};

export interface InvitationsListProps {
  readonly invitations: readonly Invitation[];
  readonly onIssue: (email: string) => void;
  readonly onRevoke: (id: string) => void;
  readonly onResend: (id: string) => void;
}

export function InvitationsList({
  invitations,
  onIssue,
  onRevoke,
  onResend,
}: InvitationsListProps) {
  const [email, setEmail] = useState('');

  const cols: ColumnDef<Invitation>[] = [
    { id: 'email', header: 'メール', cell: (r) => r.email },
    { id: 'status', header: '状態', cell: (r) => STATUS_LABEL[r.status] },
    { id: 'expires', header: '有効期限', cell: (r) => r.expires_at, align: 'right' },
    {
      id: 'actions',
      header: 'アクション',
      cell: (r) => (
        <div className="flex gap-xs">
          {r.status === 'pending' ? (
            <button
              type="button"
              onClick={() => onResend(r.id)}
              aria-label={`${r.email} に再送`}
              className="inline-flex h-8 items-center rounded-sm border border-surface-variant px-sm text-label-md text-on-surface"
            >
              再送
            </button>
          ) : null}
          {r.status === 'pending' ? (
            <button
              type="button"
              onClick={() => onRevoke(r.id)}
              aria-label={`${r.email} を失効`}
              className="inline-flex h-8 items-center rounded-sm border border-error px-sm text-label-md text-error"
            >
              失効
            </button>
          ) : null}
        </div>
      ),
      align: 'right',
    },
  ];

  return (
    <section className="flex flex-col gap-md">
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (!email) return;
          onIssue(email);
          setEmail('');
        }}
        className="flex items-end gap-sm"
      >
        <label className="flex flex-1 flex-col gap-xs">
          <span className="text-label-md text-on-surface">招待メールアドレス</span>
          <input
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            className="h-10 rounded-md border border-surface-variant bg-surface px-sm text-body-md text-on-surface"
          />
        </label>
        <button
          type="submit"
          disabled={!email}
          className="inline-flex h-10 items-center rounded-md bg-primary px-md text-label-lg text-primary-fg disabled:opacity-50"
        >
          招待を発行
        </button>
      </form>
      <DataTable
        caption="招待一覧"
        columns={cols}
        rows={invitations}
        rowKey={(r) => r.id}
        emptyMessage="招待がありません"
      />
    </section>
  );
}
