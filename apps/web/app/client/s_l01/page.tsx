'use client';

import * as React from 'react';

import { InvitationsList, type Invitation } from './_components/InvitationsList';

const INVS: Invitation[] = [
  {
    id: 'i1',
    email: 'client@example.com',
    status: 'pending',
    expires_at: '2026-06-30',
  },
];

export default function SL01Page() {
  return (
    <div className="mx-auto w-full max-w-4xl px-md py-lg">
      <h1 className="mb-md text-headline-md font-bold text-on-surface">クライアント招待管理</h1>
      <InvitationsList
        invitations={INVS}
        onIssue={() => undefined}
        onRevoke={() => undefined}
        onResend={() => undefined}
      />
    </div>
  );
}
