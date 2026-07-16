import type { Metadata } from 'next';
import type { ReactNode } from 'react';

import { ConditionalAppShell } from '../components/layout/ConditionalAppShell';
import './globals.css';

export const metadata: Metadata = {
  title: {
    default: 'Atelier',
    template: '%s | Atelier',
  },
  description: 'AI 社員常駐型プロジェクト管理 SaaS',
  robots: {
    index: false,
    follow: false,
  },
};

interface RootLayoutProps {
  children: ReactNode;
}

export default function RootLayout({ children }: RootLayoutProps) {
  return (
    <html lang="ja">
      <body>
        <ConditionalAppShell>{children}</ConditionalAppShell>
      </body>
    </html>
  );
}
