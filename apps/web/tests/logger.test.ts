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

describe('redactText (T-F-39)', () => {
  it.each([
    'api_key=sk-abcdefghijklmnop',
    'token: abcdefghijklmnop',
    'password=hunter2',
    'Authorization: Bearer abc.def.ghi',
  ])('redacts %s', (raw) => {
    const out = redactText(raw);
    expect(out).toContain(REDACTED);
    expect(out).not.toContain('hunter2');
    expect(out).not.toContain('abcdefghijklmnop');
  });

  it('redacts bare provider keys', () => {
    expect(redactText('used sk-liveKeyMaterial123 here')).not.toContain('sk-liveKeyMaterial123');
    expect(redactText('charge sk_live_ABCdef123456789')).not.toContain('sk_live_ABCdef123456789');
  });

  it('leaves ordinary messages untouched', () => {
    expect(redactText('workspace created')).toBe('workspace created');
  });

  // QA_FAIL-2 回帰: "Authorization: Bearer <JWT>" は実運用で最も多い形なのに、
  // key-value 規則の \S+ が "Bearer" で止まり JWT 本体が素通ししていた。
  // 接続文字列の資格情報も無伏せだった。
  // ↓ の表は apps/api/tests/test_observability_betterstack.py の
  //   test_redaction_table_is_exact と**同一**に保つこと (API/Web で同一規則)。
  it.each([
    ['call Authorization: Bearer eyJhbGciOi.JIUzI1', 'call Authorization:[REDACTED]'],
    ['Bearer eyJhbGciOi.JIUzI1', 'Bearer [REDACTED]'],
    ['authorization=Bearer eyJhbGciOi.JIUzI1', 'authorization=[REDACTED]'],
    ['db postgres://u:p@h/db', 'db postgres://[REDACTED]@h/db'],
    [
      'conn postgresql+asyncpg://user:s3cr3t@db.example.com:5432/atelier',
      'conn postgresql+asyncpg://[REDACTED]@db.example.com:5432/atelier',
    ],
    ['api_key=sk-abcdefghijklmnop', 'api_key=[REDACTED]'],
    ['workspace created', 'workspace created'],
  ])('redaction table: %s', (raw, expected) => {
    expect(redactText(raw)).toBe(expected);
  });

  it.each(['eyJhbGciOi.JIUzI1', 's3cr3t', 'hunter2', 'sk-abcdefghijklmnop'])(
    'leaves no trace of %s',
    (secret) => {
      for (const message of [
        `call Authorization: Bearer ${secret}`,
        `password=${secret}`,
        `conn postgres://user:${secret}@host/db`,
      ]) {
        expect(redactText(message)).not.toContain(secret);
      }
    },
  );
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
