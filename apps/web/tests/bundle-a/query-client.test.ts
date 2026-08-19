/**
 * T-US-05: TanStack Query 設定 + キャッシュ戦略 (テスト)
 */

import { describe, expect, it } from 'vitest';

import { ApiError } from '@atelier/api-client';

import { _internal, createQueryClient, reportQueryError } from '../../lib/query-client';
import { getToastsSnapshot } from '../../lib/toast/store';

const toastCount = (): number => getToastsSnapshot().length;

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

describe("想定内の状態は赤 toast を出さない (GAP-174)", () => {
  it("expectedErrors を宣言したクエリの失敗は toast しない", () => {
    const err = new ApiError({
      status: 409,
      statusText: "conflict",
      payload: undefined,
      path: "/outputs/{output_id}/anchors",
      method: "get",
    });
    const before = toastCount();
    // Excel/PDF 成果物の /anchors は 409 が正常応答 — 画面は位置指定 UI を
    // 出さないだけで正しく描けている。ここで赤 toast を出すと「画面は正しいのに
    // エラーが出ている」状態になる (経営者が実画面で指摘したもの)。
    reportQueryError(err, { meta: { expectedErrors: true } });
    expect(toastCount()).toBe(before);
  });

  it("宣言していないクエリの失敗は従来どおり toast する", () => {
    const err = new ApiError({
      status: 409,
      statusText: "conflict",
      payload: undefined,
      path: "/outputs/{output_id}/anchors",
      method: "get",
    });
    const before = toastCount();
    reportQueryError(err, { meta: {} });
    expect(toastCount()).toBe(before + 1);
    reportQueryError(err);
    expect(toastCount()).toBe(before + 2);
  });
});
