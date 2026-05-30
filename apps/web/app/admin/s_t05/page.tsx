'use client';

import * as React from 'react';

import { AuditLogTable, type AuditEntry } from './_components/AuditLogTable';

const ENTRIES: AuditEntry[] = [
  {
    id: 'a1',
    action: 'auth.signin',
    actor_type: 'user',
    actor_id: 'u1',
    target_type: 'user',
    target_id: 'u1',
    ip_address: '198.51.100.1',
    created_at: '2026-05-30T05:00:00Z',
  },
];

export default function ST05Page() {
  return (
    <div className="bg-on-surface min-h-dvh p-lg">
      <h1 className="mb-md text-headline-md font-bold text-surface">監査ログ</h1>
      <AuditLogTable entries={ENTRIES} />
    </div>
  );
}
