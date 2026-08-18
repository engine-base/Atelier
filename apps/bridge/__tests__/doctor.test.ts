/**
 * GAP-135: 環境診断 (doctor) の unit tests — CommandRunner を注入して
 * CLI 検出 / ログイン判定 / 接続設定の 3 チェックを検証する。
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { parseAuthStatus, runDoctor, type CommandRunner } from '../src/doctor.js';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'atelier-doctor-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const runnerOf =
  (outputs: Record<string, { ok: boolean; stdout: string }>): CommandRunner =>
  (_cmd, args) => {
    const key = args.join(' ');
    for (const [suffix, result] of Object.entries(outputs)) {
      if (key.endsWith(suffix)) return Promise.resolve(result);
    }
    return Promise.resolve({ ok: false, stdout: '' });
  };

describe('parseAuthStatus', () => {
  it('JSON から loggedIn / authMethod を取り出す (前後の人間向け行は無視)', () => {
    const parsed = parseAuthStatus(
      'checking...\n{\n  "loggedIn": true,\n  "authMethod": "oauth_token"\n}\ndone',
    );
    expect(parsed).toEqual({ loggedIn: true, method: 'oauth_token' });
  });

  it('壊れた出力・loggedIn 欠落は null (推測しない)', () => {
    expect(parseAuthStatus('not json')).toBeNull();
    expect(parseAuthStatus('{"authMethod":"x"}')).toBeNull();
  });
});

describe('runDoctor', () => {
  it('CLI あり + ログイン済み + 接続設定あり → 全 ok', async () => {
    const claudePath = path.join(dir, 'claude');
    writeFileSync(claudePath, '#!/bin/sh\n');
    const configPath = path.join(dir, 'bridge.json');
    writeFileSync(configPath, JSON.stringify({ apiUrl: 'https://api.example', token: 't' }));
    const report = await runDoctor({
      env: { PATH: dir, HOME: dir },
      platform: 'linux',
      configPath,
      run: runnerOf({
        '--version': { ok: true, stdout: '2.1.234 (Claude Code)\n' },
        'auth status': { ok: true, stdout: '{"loggedIn": true, "authMethod": "oauth_token"}' },
      }),
    });
    expect(report.cli.status).toBe('ok');
    expect(report.cli.path).toBe(claudePath);
    expect(report.cli.version).toBe('2.1.234 (Claude Code)');
    expect(report.auth).toEqual({ status: 'ok', loggedIn: true, method: 'oauth_token' });
    expect(report.connection).toEqual({
      status: 'ok',
      apiUrl: 'https://api.example',
      source: 'config',
    });
  });

  it('CLI 未検出 → cli fail / auth は unknown のまま (実行しない)', async () => {
    let ran = 0;
    const report = await runDoctor({
      env: { PATH: path.join(dir, 'empty') },
      platform: 'linux',
      configPath: path.join(dir, 'none.json'),
      run: () => {
        ran += 1;
        return Promise.resolve({ ok: true, stdout: 'x' });
      },
    });
    expect(report.cli.status).toBe('fail');
    expect(report.cli.resolution).toBe('unresolved');
    expect(ran).toBe(0); // 実体が無いのに CLI を叩かない
    expect(report.auth.status).toBe('unknown');
    expect(report.connection.status).toBe('fail');
  });

  it('未ログインは auth fail、auth サブコマンド不明 (旧 CLI) は unknown', async () => {
    writeFileSync(path.join(dir, 'claude'), '');
    const base = {
      env: { PATH: dir, HOME: dir },
      platform: 'linux' as const,
      configPath: path.join(dir, 'none.json'),
    };
    const loggedOut = await runDoctor({
      ...base,
      run: runnerOf({
        '--version': { ok: true, stdout: '2.1.0' },
        'auth status': { ok: true, stdout: '{"loggedIn": false}' },
      }),
    });
    expect(loggedOut.auth).toEqual({ status: 'fail', loggedIn: false, method: null });

    const oldCli = await runDoctor({
      ...base,
      run: runnerOf({ '--version': { ok: true, stdout: '1.0.0' } }),
    });
    expect(oldCli.auth.status).toBe('unknown');
  });

  it('env の ATELIER_BRIDGE_TOKEN は設定ファイルより優先 (source=env)', async () => {
    const report = await runDoctor({
      env: {
        PATH: path.join(dir, 'empty'),
        ATELIER_BRIDGE_TOKEN: 'tok',
        ATELIER_API_URL: 'http://127.0.0.1:8000',
      },
      platform: 'linux',
      configPath: path.join(dir, 'none.json'),
      run: () => Promise.resolve({ ok: false, stdout: '' }),
    });
    expect(report.connection).toEqual({
      status: 'ok',
      apiUrl: 'http://127.0.0.1:8000',
      source: 'env',
    });
  });
});
