/**
 * T-US-03 refresh flow tests
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

import { _resetInflightForTest, refreshAccessToken } from '../../lib/auth/refresh';

afterEach(() => _resetInflightForTest());

function mockFetch(status: number, body: object | null) {
  return vi.fn<
    (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>
  >(async () => {
    const headers = new Headers({ 'content-type': 'application/json' });
    return new Response(body == null ? null : JSON.stringify(body), {
      status,
      statusText: status === 200 ? 'OK' : 'ERR',
      headers,
    });
  });
}

describe('refreshAccessToken (T-US-03)', () => {
  it('returns parsed access_token + expires_at on 200', async () => {
    const f = mockFetch(200, {
      data: { access_token: 'new', expires_at: '2026-01-01T00:00:00Z' },
    });
    const out = await refreshAccessToken({ apiBaseUrl: 'https://api.test', fetch: f });
    expect(out.access_token).toBe('new');
    expect(out.expires_at).toBe('2026-01-01T00:00:00Z');
    expect(f).toHaveBeenCalledTimes(1);
  });

  it('throws when API returns non-2xx', async () => {
    const f = mockFetch(401, { detail: 'expired' });
    await expect(
      refreshAccessToken({ apiBaseUrl: 'https://api.test', fetch: f }),
    ).rejects.toThrow(/refresh failed: 401/);
  });

  it('coalesces concurrent calls into a single fetch (storm prevention)', async () => {
    const f = mockFetch(200, {
      data: { access_token: 'X', expires_at: '2026-01-01T00:00:00Z' },
    });
    const a = refreshAccessToken({ apiBaseUrl: 'https://api.test', fetch: f });
    const b = refreshAccessToken({ apiBaseUrl: 'https://api.test', fetch: f });
    await Promise.all([a, b]);
    expect(f).toHaveBeenCalledTimes(1);
  });

  it('zod parse failure throws', async () => {
    const f = mockFetch(200, { wrong: 'shape' });
    await expect(
      refreshAccessToken({ apiBaseUrl: 'https://api.test', fetch: f }),
    ).rejects.toThrow();
  });
});
