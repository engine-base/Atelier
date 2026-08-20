/**
 * GAP-199 — Bridge のセキュリティ強化。
 *
 * 直前の実態:
 *   ① `atelier-bridge://connect?api=<任意の http URL>` が **無条件で保存**されていた。
 *      悪意のあるページにリンクを開かせるだけで、指示元を攻撃者のサーバーに
 *      差し替えられた (PC 操作 auto なら任意コマンド実行に直結)。
 *   ② `tools_mode` は **サーバーが送ってきた値をそのまま**使っていた。
 *   ③ セッション ID は検証なしでコマンド引数とファイルパスに入っていた。
 *   ④ 作業フォルダの外を指すシンボリックリンクもそのまま送られていた。
 */

import { mkdirSync, mkdtempSync, readFileSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  AUDIT_ENABLED_ENV,
  DEFAULT_TRUSTED_ORIGINS,
  MAX_TOOLS_MODE_ENV,
  TRUSTED_ORIGINS_ENV,
  appendAudit,
  auditFilePath,
  capToolsMode,
  isTrustedApiUrl,
  isValidSessionId,
  maxToolsMode,
  needsOriginChangeApproval,
  resolvesInsideWorkspace,
  trustedOrigins,
} from '../src/security.js';
import { parseConnectUrl } from '../src/deep-link.js';

const PROD = DEFAULT_TRUSTED_ORIGINS[0];

describe('① 接続先の固定', () => {
  it('本番の接続先は受理する', () => {
    expect(isTrustedApiUrl(PROD, {})).toBe(true);
    expect(isTrustedApiUrl(`${PROD}/`, {})).toBe(true);
  });

  it('見知らぬ https は受理しない（乗っ取りリンクを弾く）', () => {
    expect(isTrustedApiUrl('https://evil.example.com', {})).toBe(false);
    expect(isTrustedApiUrl('https://atelier-api-eb.fly.dev.evil.com', {})).toBe(false);
  });

  it('ローカル開発 (loopback) は http でも受理する（開発体験を壊さない）', () => {
    expect(isTrustedApiUrl('http://127.0.0.1:8000', {})).toBe(true);
    expect(isTrustedApiUrl('http://localhost:8000', {})).toBe(true);
  });

  it('loopback 以外の http は受理しない（平文の指示元を許さない）', () => {
    expect(isTrustedApiUrl('http://atelier-api-eb.fly.dev', {})).toBe(false);
  });

  it('自前ホスティングは PC 側の env でだけ追加できる（クラウドからは増やせない）', () => {
    const env = { [TRUSTED_ORIGINS_ENV]: 'https://api.self-hosted.example' };
    expect(isTrustedApiUrl('https://api.self-hosted.example/x', env)).toBe(true);
    expect(trustedOrigins(env)).toContain('https://api.self-hosted.example');
    // 壊れた値は黙って無視する（推測で広げない）
    expect(trustedOrigins({ [TRUSTED_ORIGINS_ENV]: 'not a url, ,' })).toEqual([
      ...DEFAULT_TRUSTED_ORIGINS,
    ]);
  });

  it('deep link は許可された接続先だけ通す', () => {
    expect(
      parseConnectUrl(`atelier-bridge://connect?api=${encodeURIComponent(PROD)}&token=t`, {}),
    ).toEqual({ apiUrl: PROD, token: 't' });
    expect(
      parseConnectUrl('atelier-bridge://connect?api=https%3A%2F%2Fevil.example&token=t', {}),
    ).toBeNull();
  });

  it('初回接続は確認不要 / 接続先が変わるときだけ確認が要る', () => {
    expect(needsOriginChangeApproval(null, PROD)).toBe(false);
    expect(needsOriginChangeApproval('', PROD)).toBe(false);
    expect(needsOriginChangeApproval(PROD, `${PROD}/health`)).toBe(false); // 同じ origin
    expect(needsOriginChangeApproval(PROD, 'https://other.example')).toBe(true);
    // 現在の設定が壊れている場合は安全側 (確認する)
    expect(needsOriginChangeApproval('!!!', PROD)).toBe(true);
  });
});

describe('② 実行モードの上限は PC 側が決める', () => {
  it('既定は今までどおり auto（体験を変えない）', () => {
    expect(maxToolsMode({})).toBe('auto');
    expect(capToolsMode('auto', {})).toBe('auto');
    expect(capToolsMode('approve', {})).toBe('approve');
    expect(capToolsMode('off', {})).toBe('off');
  });

  it('PC 側の上限を超える指示は格下げされる', () => {
    const env = { [MAX_TOOLS_MODE_ENV]: 'approve' };
    expect(capToolsMode('auto', env)).toBe('approve');
    expect(capToolsMode('approve', env)).toBe('approve');
    expect(capToolsMode('off', env)).toBe('off');
    expect(capToolsMode('auto', { [MAX_TOOLS_MODE_ENV]: 'off' })).toBe('off');
  });

  it('未知の値は最も弱い off に倒す（推測で強くしない）', () => {
    expect(capToolsMode('yolo', {})).toBe('off');
    expect(capToolsMode('', {})).toBe('off');
  });

  it('上限の env が壊れていたら既定 (auto) に戻す', () => {
    expect(maxToolsMode({ [MAX_TOOLS_MODE_ENV]: 'nonsense' })).toBe('auto');
  });
});

describe('③ サーバー由来の値の検証', () => {
  it('UUID だけを受け入れる', () => {
    expect(isValidSessionId('11111111-2222-4333-8444-555555555555')).toBe(true);
    for (const bad of [
      'known',
      '../../etc/passwd',
      '--dangerously-skip-permissions',
      '11111111-2222-4333-8444-55555555555',
      '',
      null,
      42,
    ]) {
      expect(isValidSessionId(bad)).toBe(false);
    }
  });
});

describe('④ 成果物の持ち出し防止', () => {
  it('作業フォルダの中の実ファイルは通す', () => {
    const root = mkdtempSync(join(tmpdir(), 'g199-ws-'));
    const file = join(root, 'report.html');
    writeFileSync(file, '<p>ok</p>');
    expect(resolvesInsideWorkspace(root, file)).toBe(true);
  });

  it('外を指すシンボリックリンクは通さない（~/.ssh を html に見せかけても出ない）', () => {
    const root = mkdtempSync(join(tmpdir(), 'g199-ws-'));
    const outside = mkdtempSync(join(tmpdir(), 'g199-secret-'));
    const secret = join(outside, 'id_rsa');
    writeFileSync(secret, 'PRIVATE KEY');
    const link = join(root, 'report.html');
    symlinkSync(secret, link);
    expect(resolvesInsideWorkspace(root, link)).toBe(false);
  });

  it('作業フォルダ内を指すシンボリックリンクは通す（正当な使い方は壊さない）', () => {
    const root = mkdtempSync(join(tmpdir(), 'g199-ws-'));
    mkdirSync(join(root, 'sub'));
    const real = join(root, 'sub', 'real.html');
    writeFileSync(real, '<p>ok</p>');
    const link = join(root, 'alias.html');
    symlinkSync(real, link);
    expect(resolvesInsideWorkspace(root, link)).toBe(true);
  });

  it('壊れたリンクは通さない', () => {
    const root = mkdtempSync(join(tmpdir(), 'g199-ws-'));
    const link = join(root, 'broken.html');
    symlinkSync(join(root, 'missing.html'), link);
    expect(resolvesInsideWorkspace(root, link)).toBe(false);
  });

  it('作業フォルダの外の絶対パスは通さない', () => {
    const root = mkdtempSync(join(tmpdir(), 'g199-ws-'));
    expect(resolvesInsideWorkspace(root, '/etc/passwd')).toBe(false);
  });
});

describe('ローカル監査ログ', () => {
  const entry = {
    at: '2026-08-20T04:00:00.000Z',
    jobId: 'job-1',
    requestedMode: 'auto',
    effectiveMode: 'approve' as const,
    cwd: '/home/u/AtelierChatWork',
    apiOrigin: PROD,
    outcome: 'completed',
  };

  it('JSON Lines で追記し、本人しか読めない権限にする', () => {
    const home = mkdtempSync(join(tmpdir(), 'g199-home-'));
    expect(appendAudit(entry, {}, home)).toBe(true);
    expect(appendAudit({ ...entry, jobId: 'job-2' }, {}, home)).toBe(true);
    const lines = readFileSync(auditFilePath(home), 'utf8').trim().split('\n');
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0])).toEqual(entry);
    expect(JSON.parse(lines[1]).jobId).toBe('job-2');
    // 0600 (他ユーザーから読めない)
    expect(statSync(auditFilePath(home)).mode & 0o777).toBe(0o600);
  });

  it('格下げされた事実が残る（サーバー指定と実際の値が両方入る）', () => {
    const home = mkdtempSync(join(tmpdir(), 'g199-home-'));
    appendAudit(entry, {}, home);
    const row = JSON.parse(readFileSync(auditFilePath(home), 'utf8').trim());
    expect(row.requestedMode).toBe('auto');
    expect(row.effectiveMode).toBe('approve');
  });

  it('明示的に OFF にできる', () => {
    const home = mkdtempSync(join(tmpdir(), 'g199-home-'));
    expect(appendAudit(entry, { [AUDIT_ENABLED_ENV]: '0' }, home)).toBe(false);
  });

  it('書けなくても例外にしない（実行を止めない）', () => {
    expect(appendAudit(entry, {}, '/proc/nonexistent-dir')).toBe(false);
  });
});
