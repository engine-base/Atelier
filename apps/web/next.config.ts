import type { NextConfig } from 'next';

import { ROUTE_MAP } from './lib/routes';

const nextConfig: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  // GAP-204: **本番でソースマップを配らない**。
  // 配ると元の TypeScript がまるごとダウンロードでき、画面の作りだけでなく
  // 変数名・コメント・分岐の意図まで読まれる。Next.js の既定も false だが、
  // 1 行の変更で事故になるため明示し、CI (scripts/ci/check-client-leak.py) で
  // 設定と成果物の両方を毎回検査する。
  productionBrowserSourceMaps: false,
  // typedRoutes は rewrites 経由の意味的URL(/projects 等)を「未知ルート」として型エラーに
  // するため無効化 (F-VIS 段3: 内部ID非露出の意味的URLを採用)。
  transpilePackages: ['@atelier/shared'],
  // 意味的URL → 実ルート(タスクID命名のディレクトリ)を serve。URL バーは意味的パスのまま。
  async rewrites() {
    return ROUTE_MAP.map(([clean, internal]) => ({ source: clean, destination: internal }));
  },
  // 実ルート直アクセスは意味的URLへ 308 で統一 (bookmark/古いリンク対策)。
  async redirects() {
    return ROUTE_MAP.map(([clean, internal]) => ({
      source: internal,
      destination: clean,
      permanent: true,
    }));
  },
  async headers() {
    return [
      {
        source: '/(.*)',
        headers: [
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'X-Frame-Options', value: 'DENY' },
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
          {
            key: 'Permissions-Policy',
            value: 'camera=(), microphone=(), geolocation=()',
          },
          {
            key: 'Strict-Transport-Security',
            value: 'max-age=31536000; includeSubDomains; preload',
          },
        ],
      },
    ];
  },
};

export default nextConfig;
