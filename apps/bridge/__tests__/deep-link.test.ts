/**
 * GAP-122 — ワンクリック接続 (atelier-bridge:// ディープリンク) のテスト。
 */

import { mkdtempSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  configFilePath,
  findConnectUrlInArgv,
  loadConnectConfig,
  parseConnectUrl,
  saveConnectConfig,
} from '../src/deep-link.js';
import { runHeadless } from '../src/headless.js';

describe('parseConnectUrl', () => {
  it('connect URL から api と token を取り出す', () => {
    expect(
      parseConnectUrl('atelier-bridge://connect?api=http%3A%2F%2F127.0.0.1%3A8000&token=tok123'),
    ).toEqual({ apiUrl: 'http://127.0.0.1:8000', token: 'tok123' });
    // https / クエリ順不同も受理 (許可された接続先であること — GAP-199)
    expect(
      parseConnectUrl('atelier-bridge://connect?token=t&api=https://atelier-api-eb.fly.dev'),
    ).toEqual({ apiUrl: 'https://atelier-api-eb.fly.dev', token: 't' });
  });

  it('対象外 URL は null (別スキーム / 別アクション / パラメータ欠落 / 非 http api)', () => {
    expect(parseConnectUrl('https://connect?api=http://x&token=t')).toBeNull();
    expect(parseConnectUrl('atelier-bridge://other?api=http://x&token=t')).toBeNull();
    expect(parseConnectUrl('atelier-bridge://connect?api=http://x')).toBeNull();
    expect(parseConnectUrl('atelier-bridge://connect?token=t')).toBeNull();
    expect(
      parseConnectUrl('atelier-bridge://connect?api=file:///etc/passwd&token=t'),
    ).toBeNull();
    expect(parseConnectUrl('not a url')).toBeNull();
  });
});

describe('findConnectUrlInArgv', () => {
  it('argv (Windows/Linux 経路) から接続 URL を探す', () => {
    expect(
      findConnectUrlInArgv(['electron', '.', 'atelier-bridge://connect?api=http://x&token=t']),
    ).toBe('atelier-bridge://connect?api=http://x&token=t');
    expect(findConnectUrlInArgv(['electron', '.'])).toBeNull();
  });
});

describe('save/loadConnectConfig', () => {
  it('往復保存でき、mode 0600 で保存される', () => {
    const dir = mkdtempSync(join(tmpdir(), 'bridge-cfg-'));
    const p = configFilePath(dir);
    saveConnectConfig(p, { apiUrl: 'http://127.0.0.1:8000', token: 'raw-token' });
    expect(loadConnectConfig(p)).toEqual({ apiUrl: 'http://127.0.0.1:8000', token: 'raw-token' });
    expect(statSync(p).mode & 0o777).toBe(0o600);
  });

  it('無い・壊れたファイルは null (推測で補完しない)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'bridge-cfg-'));
    expect(loadConnectConfig(configFilePath(dir))).toBeNull();
    const p = configFilePath(dir);
    writeFileSync(p, 'not json');
    expect(loadConnectConfig(p)).toBeNull();
    writeFileSync(p, JSON.stringify({ apiUrl: '', token: '' }));
    expect(loadConnectConfig(p)).toBeNull();
  });
});

describe('runHeadless — 保存設定フォールバック (GAP-122)', () => {
  it('env に token が無ければ保存設定で起動する', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'bridge-cfg-'));
    const p = configFilePath(dir);
    saveConnectConfig(p, { apiUrl: 'http://stored.example', token: 'stored-token' });
    const seen: string[] = [];
    const code = await runHeadless({
      env: { ATELIER_BRIDGE_CHAT_RELAY: '0' },
      argv: [],
      configPath: p,
      makeRunner: (token) => {
        seen.push(token);
        return { runOnce: async () => 'no-task' as const };
      },
    });
    expect(code).toBe(0);
    expect(seen).toEqual(['stored-token']);
  });

  it('env の token が保存設定より優先される', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'bridge-cfg-'));
    const p = configFilePath(dir);
    saveConnectConfig(p, { apiUrl: 'http://stored.example', token: 'stored-token' });
    const seen: string[] = [];
    await runHeadless({
      env: { ATELIER_BRIDGE_TOKEN: 'env-token', ATELIER_BRIDGE_CHAT_RELAY: '0' },
      argv: [],
      configPath: p,
      makeRunner: (token) => {
        seen.push(token);
        return { runOnce: async () => 'no-task' as const };
      },
    });
    expect(seen).toEqual(['env-token']);
  });

  it('env にも保存設定にも無ければ 2 で終了 (誠実エラー)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'bridge-cfg-'));
    const code = await runHeadless({
      env: {},
      argv: [],
      configPath: configFilePath(dir),
    });
    expect(code).toBe(2);
  });
});

describe('runHeadless — user トークンのチャット専用降格 (GAP-122)', () => {
  it('タスク claim が 403 なら fatal 終了せず、chat 中継 + presence ping で常駐する', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'bridge-cfg-'));
    let chatRuns = 0;
    let pings = 0;
    let stop: (() => void) | null = null;
    const stopped = new Promise<void>((r) => {
      stop = r;
    });
    const promise = runHeadless({
      env: { ATELIER_BRIDGE_TOKEN: 'user-token' },
      argv: ['--loop'],
      sleepMs: 0,
      configPath: configFilePath(dir),
      makeRunner: () => ({
        runOnce: async () => {
          throw new Error('/kanban/pick failed: 403 chat-only');
        },
      }),
      makeChatRelay: () => ({
        runOnce: async () => {
          chatRuns += 1;
          if (chatRuns >= 3) {
            // 3 周したらプロセス終了相当 (テストの終了条件)
            stop?.();
            throw new Error('stop-signal');
          }
          return 'no-job' as const;
        },
      }),
      makePinger: () => async () => {
        pings += 1;
      },
    });
    await stopped;
    // chat ループは task 403 の後も回り続けている
    expect(chatRuns).toBeGreaterThanOrEqual(3);
    expect(pings).toBeGreaterThanOrEqual(1);
    // 後始末: chat loop は stop-signal 例外後も回るため、ここでは結果を待たない
    void promise;
  });
});
