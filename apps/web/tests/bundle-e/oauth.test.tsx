/**
 * GAP-020 — S-A01 OAuth ボタン + /auth/oauth-complete のテスト
 *
 *   - providers 空 → ボタンも divider も描画しない (死にボタン禁止)
 *   - 有効プロバイダのみ描画 / クリックで API の start URL へ遷移
 *   - oauth-complete: フラグメントのトークンを既存 signin と同一 cookie に格納 → /projects
 *   - oauth-complete: ?error= は誠実にエラー表示 + サインインへ戻る導線
 */

// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest';

import * as React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const nav = vi.hoisted(() => ({
  replace: vi.fn(),
  refresh: vi.fn(),
  push: vi.fn(),
  search: '',
}));

// window.location.replace は jsdom 未実装 (Not implemented: navigation) のため
// 差し替えてスパイする (実装は完全遷移 = location.replace を使う)
const locationReplace = vi.fn();

vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace: nav.replace, refresh: nav.refresh, push: nav.push }),
  useSearchParams: () => new URLSearchParams(nav.search),
}));

import { OAuthButtons, type OAuthProviderInfo } from '../../app/auth/s_a01/_components/OAuthButtons';
import { OAuthCompleteInner } from '../../app/auth/oauth-complete/page';
import { API_BASE } from '../../lib/auth/connector';

const BOTH: OAuthProviderInfo[] = [
  { id: 'github', display_name: 'GitHub' },
  { id: 'google', display_name: 'Google' },
];

beforeEach(() => {
  const original = window.location;
  Object.defineProperty(window, 'location', {
    configurable: true,
    value: Object.assign(Object.create(Object.getPrototypeOf(original)), original, {
      replace: locationReplace,
    }),
  });
});

afterEach(() => {
  vi.clearAllMocks();
  nav.search = '';
  window.location.hash = '';
});

describe('OAuthButtons (GAP-020)', () => {
  it('renders nothing when no provider is enabled (no dead buttons, no divider)', async () => {
    const fetchProviders = vi.fn(async (): Promise<OAuthProviderInfo[]> => []);
    render(<OAuthButtons fetchProviders={fetchProviders} />);
    await waitFor(() => expect(fetchProviders).toHaveBeenCalled());
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
    expect(screen.queryByText('または')).not.toBeInTheDocument();
    expect(screen.queryByTestId('oauth-block')).not.toBeInTheDocument();
  });

  it('renders nothing when the providers API fails (honest degradation)', async () => {
    const fetchProviders = vi.fn(async (): Promise<OAuthProviderInfo[]> => {
      throw new Error('network');
    });
    render(<OAuthButtons fetchProviders={fetchProviders} />);
    await waitFor(() => expect(fetchProviders).toHaveBeenCalled());
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });

  it('renders one button per enabled provider with the divider (mock .oauth-row)', async () => {
    render(<OAuthButtons fetchProviders={async () => BOTH} />);
    expect(
      await screen.findByRole('button', { name: /GitHub でサインイン/ }),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Google でサインイン/ })).toBeInTheDocument();
    expect(screen.getByText('または')).toBeInTheDocument();
  });

  it('renders only the enabled provider', async () => {
    render(
      <OAuthButtons fetchProviders={async () => [{ id: 'google', display_name: 'Google' }]} />,
    );
    expect(
      await screen.findByRole('button', { name: /Google でサインイン/ }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: /GitHub でサインイン/ }),
    ).not.toBeInTheDocument();
  });

  it('clicking a provider navigates to the API start URL', async () => {
    const navigate = vi.fn();
    render(<OAuthButtons fetchProviders={async () => BOTH} navigate={navigate} />);
    fireEvent.click(await screen.findByRole('button', { name: /GitHub でサインイン/ }));
    expect(navigate).toHaveBeenCalledWith(`${API_BASE}/auth/oauth/github/start`);
    fireEvent.click(screen.getByRole('button', { name: /Google でサインイン/ }));
    expect(navigate).toHaveBeenCalledWith(`${API_BASE}/auth/oauth/google/start`);
  });
});

describe('/auth/oauth-complete (GAP-020)', () => {
  beforeEach(() => {
    // 前テストの cookie を無効化
    document.cookie = 'atelier_access=; path=/; expires=Thu, 01 Jan 1970 00:00:00 GMT';
  });

  it('stores the fragment token in the atelier_access cookie and redirects to /projects', async () => {
    window.location.hash =
      '#access_token=tok-abc.def.ghi&expires_at=2999-01-01T00%3A00%3A00%2B00%3A00&user_id=u-1&email=a%40example.com&display_name=A';
    render(<OAuthCompleteInner />);
    await waitFor(() => expect(locationReplace).toHaveBeenCalledWith('/projects'));
    expect(document.cookie).toContain('atelier_access=tok-abc.def.ghi');
    // 成功時は「サインインしています…」のみ (偽のエラーを出さない)
    expect(screen.getByRole('status')).toHaveTextContent('サインインしています');
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('shows an honest error for ?error=access_denied with a way back to signin', () => {
    nav.search = 'error=access_denied';
    render(<OAuthCompleteInner />);
    expect(screen.getByRole('alert')).toHaveTextContent('認可がキャンセルされました');
    const back = screen.getByRole('link', { name: 'サインインへ戻る' });
    expect(back).toHaveAttribute('href', '/auth/s_a01');
    expect(locationReplace).not.toHaveBeenCalled();
    expect(document.cookie).not.toContain('atelier_access=tok');
  });

  it('surfaces unknown error codes verbatim instead of hiding them', () => {
    nav.search = 'error=exchange_failed';
    render(<OAuthCompleteInner />);
    expect(screen.getByRole('alert')).toHaveTextContent('プロバイダとの通信に失敗しました');
  });

  it('shows an error when no token is present (no fake success)', () => {
    window.location.hash = '';
    render(<OAuthCompleteInner />);
    expect(screen.getByRole('alert')).toHaveTextContent('トークンを受け取れませんでした');
    expect(locationReplace).not.toHaveBeenCalled();
  });
});
