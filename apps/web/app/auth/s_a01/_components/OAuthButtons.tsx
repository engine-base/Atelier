/**
 * S-A01 OAuth サインインボタン — GAP-020
 *
 * モック 06_mockups/auth/S-A01-signin.html の .oauth-row / .divider に忠実:
 *   - GitHub / Google ボタン (縦積み, 白地 + border, hover で surface-variant)
 *   - 直後に「または」divider
 *
 * 死にボタン禁止 (CLAUDE.md): マウント時に GET /auth/oauth/providers を取得し、
 * env が設定済みの有効プロバイダのみ描画する。0 件なら divider ごと何も出さない。
 * クリックで API の /auth/oauth/{provider}/start へ遷移 (302 → プロバイダ認可画面)。
 */

'use client';

import * as React from 'react';
import { Github, Globe } from 'lucide-react';

import { API_BASE, getJson } from '../../../../lib/auth/connector';

export interface OAuthProviderInfo {
  readonly id: string;
  readonly display_name: string;
}

async function fetchProvidersDefault(): Promise<OAuthProviderInfo[]> {
  const res = await getJson<OAuthProviderInfo[]>('/auth/oauth/providers');
  return Array.isArray(res.data) ? res.data : [];
}

function providerIcon(id: string): React.ReactNode {
  // モックのアイコン対応: github → github, google → globe
  if (id === 'github') return <Github aria-hidden="true" className="h-4 w-4" />;
  return <Globe aria-hidden="true" className="h-4 w-4" />;
}

export interface OAuthButtonsProps {
  /** テスト差し替え用。既定は実 API (GET /auth/oauth/providers)。 */
  readonly fetchProviders?: () => Promise<OAuthProviderInfo[]>;
  /** テスト差し替え用。既定は API の start URL へブラウザ遷移。 */
  readonly navigate?: (url: string) => void;
}

export function OAuthButtons({
  fetchProviders = fetchProvidersDefault,
  navigate = (url) => window.location.assign(url),
}: OAuthButtonsProps) {
  const [providers, setProviders] = React.useState<OAuthProviderInfo[] | null>(null);

  React.useEffect(() => {
    let alive = true;
    fetchProviders()
      .then((list) => {
        if (alive) setProviders(list);
      })
      .catch(() => {
        // 取得失敗 = 有効プロバイダ不明 → 死にボタンを出さない (非表示)
        if (alive) setProviders([]);
      });
    return () => {
      alive = false;
    };
  }, [fetchProviders]);

  if (!providers || providers.length === 0) return null;

  return (
    <div data-testid="oauth-block">
      {/* .oauth-row */}
      <div className="mb-6 flex flex-col gap-2.5">
        {providers.map((p) => (
          <button
            key={p.id}
            type="button"
            onClick={() => navigate(`${API_BASE}/auth/oauth/${p.id}/start`)}
            className="flex w-full items-center justify-center gap-2.5 rounded-md border border-border bg-white px-4 py-3 text-sm font-semibold text-on-surface transition-colors hover:bg-surface-variant focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-container"
          >
            {providerIcon(p.id)}
            {p.display_name} でサインイン
          </button>
        ))}
      </div>
      {/* .divider — プロバイダ 0 件ならこの区切り線ごと非表示 */}
      <div className="mb-6 flex items-center gap-3" aria-hidden="true">
        <span className="h-px flex-1 bg-border" />
        <span className="text-[11px] font-semibold uppercase tracking-widest text-on-surface-variant">
          または
        </span>
        <span className="h-px flex-1 bg-border" />
      </div>
    </div>
  );
}
