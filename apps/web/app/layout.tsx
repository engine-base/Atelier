import * as React from 'react';
import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import { Noto_Sans_JP } from 'next/font/google';

import { ConditionalAppShell } from '../components/layout/ConditionalAppShell';
import { ObservabilityProvider } from '../providers/observability-provider';
import './globals.css';

// モック(_shared/atelier.css)は Noto Sans JP を Google Fonts から読み込む。
// 実装はフォント宣言のみで実体を読み込んでおらず system font にフォールバックしていたため、
// タイポグラフィがモックと別物になっていた (F-VIS: フォント未ロード)。next/font で実ロードする。
const notoSansJP = Noto_Sans_JP({
  subsets: ['latin'],
  weight: ['400', '500', '600', '700', '900'],
  variable: '--font-noto',
  display: 'swap',
});

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
    <html lang="ja" className={notoSansJP.variable}>
      <body>
        {/* T-F-42: Sentry browser SDK の実初期化。ここが唯一の呼び出し元。 */}
        <ObservabilityProvider>
          <ConditionalAppShell>{children}</ConditionalAppShell>
        </ObservabilityProvider>
      </body>
    </html>
  );
}
