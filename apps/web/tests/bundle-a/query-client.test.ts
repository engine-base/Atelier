/**
 * T-US-05: TanStack Query 設定 + キャッシュ戦略 (テスト)
 */

import { describe, expect, it } from 'vitest';

import { ApiError } from '@atelier/api-client';

import { _internal, createQueryClient } from '../../lib/query-client';

describe('createQueryClient (T-US-05)', () => {
  const c = createQueryClient();
  const opts = c.getDefaultOptions();

  it('staleTime is 30s', () => {
    expect(opts.queries?.staleTime).toBe(30 * 1000);
  });
  it('gcTime is 5min', () => {
    expect(opts.queries?.gcTime).toBe(5 * 60 * 1000);
  });
  it('refetchOnWindowFocus is disabled', () => {
    expect(opts.queries?.refetchOnWindowFocus).toBe(false);
  });
  it('refetchOnReconnect is enabled', () => {
    expect(opts.queries?.refetchOnReconnect).toBe(true);
  });
});

describe('_internal.shouldRetry (T-US-05 retry policy)', () => {
  const e401 = new ApiError({
    status: 401,
    statusText: 'Unauthorized',
    payload: null,
    path: '/x',
    method: 'get',
  });
  const e500 = new ApiError({
    status: 500,
    statusText: 'Internal',
    payload: null,
    path: '/x',
    method: 'get',
  });
  const generic = new Error('network');

  it('never retries 4xx ApiError', () => {
    expect(_internal.shouldRetry(0, e401)).toBe(false);
  });
  it('retries 5xx ApiError up to 2 times', () => {
    expect(_internal.shouldRetry(0, e500)).toBe(true);
    expect(_internal.shouldRetry(1, e500)).toBe(true);
    expect(_internal.shouldRetry(2, e500)).toBe(false);
  });
  it('retries generic errors up to 2 times', () => {
    expect(_internal.shouldRetry(0, generic)).toBe(true);
    expect(_internal.shouldRetry(2, generic)).toBe(false);
  });
});
