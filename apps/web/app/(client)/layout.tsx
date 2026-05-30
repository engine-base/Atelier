/**
 * Client portal route group layout — T-US-15
 *
 * Next.js App Router の route group (parenthesized segment) で /client/* 配下
 * (URL には現れない) を専用 layout に切る。AppShell より軽量な ClientShell を
 * デフォルト適用。
 *
 * 実際の project 情報は子ページが TanStack Query (T-US-05) で取得し、ClientShell に
 * props で流す。本 layout は最小フレームのみ。
 */

import * as React from 'react';
import type { ReactNode } from 'react';

import { ClientShell } from '../../components/client/ClientShell';

export const metadata = {
  title: 'クライアントポータル | Atelier',
  robots: { index: false, follow: false },
};

export default function ClientLayout({ children }: { children: ReactNode }) {
  return <ClientShell>{children}</ClientShell>;
}
