'use client';

import * as React from 'react';

import { UserAdminList, type AdminUser } from './_components/UserAdminList';

const USERS: AdminUser[] = [
  { id: 'u1', email: 'alice@example.com', state: 'active', last_login: '5 分前' },
  { id: 'u2', email: 'bob@example.com', state: 'suspended', last_login: null },
];

export default function ST04Page() {
  return (
    <div className="bg-on-surface min-h-dvh p-lg">
      <h1 className="mb-md text-headline-md font-bold text-surface">ユーザー管理</h1>
      <UserAdminList users={USERS} onSuspend={() => undefined} onRestore={() => undefined} />
    </div>
  );
}
