/**
 * T-F-39: apps/web/lib/logger.ts (Better Stack ログ送信) の検証。
 *
 * critical AC:
 * - トークン未設定 → 送らずローカル出力へフォールバック、例外なし
 * - 送信失敗 / タイムアウト → 例外を投げず false、ローカル出力は残る
 * - 秘匿値は送出ペイロードでマスクされる
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  REDACTED,
  buildLogPayload,
  redactContext,
  redactText,
  sendLog,
} from '../lib/logger';

const TOKEN_ENV = 'NEXT_PUBLIC_BETTERSTACK_SOURCE_TOKEN';
const URL_ENV = 'NEXT_PUBLIC_BETTERSTACK_INGEST_URL';

const originalFetch = globalThis.fetch;

beforeEach(() => {
  delete process.env[TOKEN_ENV];
  delete process.env[URL_ENV];
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

// ─────────────────────────────────────────────────────────────────────────────
// **apps/api/tests/test_observability_redaction.py と同一の期待値表**。
// TS/Python 間で実装を 1 本化できない以上、両側に同じ表を置いてパリティを担保する
// (T-F-48 / QA_FAIL D-FAIL-2 の是正)。片側だけ更新しないこと。
// ─────────────────────────────────────────────────────────────────────────────

/** (説明, 本文, 漏れてはいけない材料) — API 側 SECRET_CASES と同一。 */
const SECRET_CASES: readonly (readonly [string, string, string])[] = [
  // --- T-F-48 で追加した 4 形式 ---
  ['Authorization: Basic', 'Authorization: Basic dXNlcjpwYXNzd29yZA==', 'dXNlcjpwYXNzd29yZA'],
  ['redis:// のユーザ名省略形', 'cache redis://:onlypassword@cache:6379/0', 'onlypassword'],
  ['JSON の "token": "…"', '{"token": "abc123secret"}', 'abc123secret'],
  ['Set-Cookie', 'Set-Cookie: session=sess-abc-123', 'sess-abc-123'],
  // --- 既存形式 (退行検知) ---
  ['Authorization: Bearer', 'call Authorization: Bearer eyJhbGciOi.JIUzI1', 'eyJhbGciOi.JIUzI1'],
  ['Bearer 単体', 'Bearer eyJhbGciOi.JIUzI1', 'eyJhbGciOi.JIUzI1'],
  ['接続文字列', 'db postgres://u:p4ssw0rd@h/db', 'p4ssw0rd'],
  ['key=value', 'api_key=sk-abcdefghijklmnop', 'sk-abcdefghijklmnop'],
  ['password', 'password=hunter2', 'hunter2'],
  ['Stripe 鍵', 'charge sk_live_ABCdef123456789', 'sk_live_ABCdef123456789'],
];

/** 誤検知させてはいけない通常ログ — API 側 SAFE_CASES と同一。 */
const SAFE_CASES: readonly string[] = [
  'workspace created',
  'user session count is 42 items',
  'connected to postgres://localhost:5432/atelier_dev',
];

/**
 * 本 API に**実在する**エラーメッセージ。1 文字も変えてはいけない。
 * API 側 REAL_MESSAGES と同一 (QA_FAIL D-FAIL-1 の再発防止)。
 */
const REAL_MESSAGES: readonly string[] = [
  'invalid token signature',
  'token expired',
  'client portal token is not valid here',
  'bridge token not configured (set ATELIER_BRIDGE_TOKEN)',
  'refresh token is invalid or expired',
  'Supabase token endpoint failed: 500',
  'Basic authentication is disabled for this endpoint',
  '1 リクエスト分の token usage',
];

describe('redactText — API とのパリティ表 (T-F-48)', () => {
  it.each(SECRET_CASES)('%s: 秘匿材料が残らない', (_label, message, material) => {
    expect(redactText(message)).not.toContain(material);
  });

  it.each(SAFE_CASES)('通常ログ %s は無改変', (message) => {
    expect(redactText(message)).toBe(message);
  });

  it.each(REAL_MESSAGES)('実在エラーメッセージ %s は無改変', (message) => {
    expect(redactText(message)).toBe(message);
  });

  it.each([
    // Bearer は束 C どおり **無条件** (英字のみでも伏せる)。
    // 条件を課すと束 C 時点でマスクされていた形が素通しになり退行する。
    ['Bearer eyJhbGciOi.JIUzI1', 'Bearer [REDACTED]'],
    ['bearer eyJhbGciOi.JIUzI1', 'bearer [REDACTED]'],
    ['Bearer abcdefghijklmnop', 'Bearer [REDACTED]'],
    ['Bearer ABCDEFGHIJKLMNOP', 'Bearer [REDACTED]'],
    // T-F-48 で追加した Token/Digest/Basic は「資格情報の形」のときだけ
    // (8 文字以上 + 数字/記号を含む)。英単語として頻出するため。
    ['Basic dXNlcjpwYXNzd29yZA==', 'Basic [REDACTED]'],
    ['Basic authentication is disabled', 'Basic authentication is disabled'],
    ['token usage', 'token usage'],
  ])('単体スキーム規則: %s -> %s', (raw, expected) => {
    expect(redactText(raw)).toBe(expected);
  });

  it.each([
    ['Authorization: Basic dXNlcjpwYXNzd29yZA==', 'Authorization:[REDACTED]'],
    ['cache redis://:onlypassword@cache:6379/0', 'cache redis://[REDACTED]@cache:6379/0'],
    ['{"token": "abc123secret"}', '{"token": "[REDACTED]"}'],
    ['Set-Cookie: session=sess-abc-123', 'Set-Cookie:[REDACTED]'],
    ['db postgres://u:p4ssw0rd@h/db', 'db postgres://[REDACTED]@h/db'],
    ['api_key=sk-abcdefghijklmnop', 'api_key=[REDACTED]'],
  ])('出力そのものが API と一致: %s -> %s', (raw, expected) => {
    expect(redactText(raw)).toBe(expected);
  });

  it('送出ペイロードでも同じ規則が効く (sendLog の入口)', () => {
    for (const [label, message, material] of SECRET_CASES) {
      const payload = buildLogPayload({ level: 'error', message });
      expect(JSON.stringify(payload)).not.toContain(material);
      expect(label).toBeTruthy();
    }
  });
});

describe('redactContext (T-F-39)', () => {
  it('redacts by key name and recurses into nested objects', () => {
    const out = redactContext({
      ANTHROPIC_API_KEY: 'sk-realkeymaterial',
      userId: 'u1',
      nested: { authorization: 'Bearer xyz', ok: 1 },
    });
    expect(out.ANTHROPIC_API_KEY).toBe(REDACTED);
    expect(out.userId).toBe('u1');
    expect((out.nested as Record<string, unknown>).authorization).toBe(REDACTED);
    expect((out.nested as Record<string, unknown>).ok).toBe(1);
  });
});

describe('buildLogPayload (T-F-39)', () => {
  it('emits structured JSON with masked message', () => {
    const payload = buildLogPayload(
      { level: 'error', message: 'boom api_key=sk-secretvalue123', context: { userId: 'u1' } },
      new Date('2026-08-13T00:00:00.000Z'),
    );
    expect(payload.dt).toBe('2026-08-13T00:00:00.000Z');
    expect(payload.level).toBe('error');
    expect(payload.service).toBe('atelier-web');
    expect(String(payload.message)).toContain(REDACTED);
    expect(JSON.stringify(payload)).not.toContain('sk-secretvalue123');
  });
});

describe('sendLog (T-F-39)', () => {
  it('falls back to local logging without a token and does not fetch', async () => {
    const fetchSpy = vi.fn();
    globalThis.fetch = fetchSpy as unknown as typeof fetch;

    await expect(sendLog({ level: 'info', message: 'hello' })).resolves.toBe(false);

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(console.warn).toHaveBeenCalled();
  });

  it('ships structured JSON with a bearer token when configured', async () => {
    process.env[TOKEN_ENV] = 'tok';
    process.env[URL_ENV] = 'https://ingest.example/logs';
    const fetchSpy = vi.fn(async () => new Response(null, { status: 202 }));
    globalThis.fetch = fetchSpy as unknown as typeof fetch;

    await expect(
      sendLog({ level: 'error', message: 'boom token=sk-secretvalue123' }),
    ).resolves.toBe(true);

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://ingest.example/logs');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer tok');
    expect(String(init.body)).not.toContain('sk-secretvalue123');
    expect(String(init.body)).toContain(REDACTED);
  });

  it('returns false on a non-ok response', async () => {
    process.env[TOKEN_ENV] = 'tok';
    globalThis.fetch = vi.fn(
      async () => new Response(null, { status: 500 }),
    ) as unknown as typeof fetch;

    await expect(sendLog({ level: 'warn', message: 'x' })).resolves.toBe(false);
  });

  it('never throws when the transport fails and still logs locally', async () => {
    process.env[TOKEN_ENV] = 'tok';
    globalThis.fetch = vi.fn(async () => {
      throw new Error('network down');
    }) as unknown as typeof fetch;

    await expect(sendLog({ level: 'error', message: 'x' })).resolves.toBe(false);
    expect(console.error).toHaveBeenCalled();
  });
});
