/**
 * Admin route group layout — T-US-16
 *
 * /admin/* 配下のページに専用ダークレイアウトを適用。Atelier 運営 (社員) 向け、
 * 一般ユーザー UI とは視覚的に明確に区別する目的。
 */

import * as React from 'react';
import type { ReactNode } from 'react';

import { AdminShell } from '../../components/admin/AdminShell';

export const metadata = {
  title: '運営 | Atelier',
  robots: { index: false, follow: false },
};

export default function AdminLayout({ children }: { children: ReactNode }) {
  return <AdminShell>{children}</AdminShell>;
}
