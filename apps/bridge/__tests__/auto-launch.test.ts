/**
 * GAP-126 — ログイン時自動起動 (auto-launch) のテスト。
 * Electron API (setLoginItemSettings) 自体は electron-entry 側の責務のため、
 * ここではテスト可能な純粋部分 (接続判定 / XDG autostart) を検証する。
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  autostartDesktopEntry,
  autostartFilePath,
  hasConnection,
  installLinuxAutostart,
} from '../src/auto-launch.js';
import { saveConnectConfig } from '../src/deep-link.js';

let tmpHome: string | null = null;
const makeHome = (): string => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-autolaunch-'));
  return tmpHome;
};
afterEach(() => {
  if (tmpHome) fs.rmSync(tmpHome, { recursive: true, force: true });
  tmpHome = null;
});

describe('hasConnection (登録は接続済みのときだけ)', () => {
  it('env にトークンがあれば true', () => {
    expect(
      hasConnection({ ATELIER_BRIDGE_TOKEN: 'tok' }, '/nonexistent/config.json'),
    ).toBe(true);
  });

  it('保存済みのワンクリック接続設定があれば true', () => {
    const home = makeHome();
    const cfg = path.join(home, '.atelier-bridge.json');
    saveConnectConfig(cfg, { apiUrl: 'http://127.0.0.1:8000', token: 'tok' });
    expect(hasConnection({}, cfg)).toBe(true);
  });

  it('どちらも無ければ false (未接続では常駐登録しない)', () => {
    expect(hasConnection({}, '/nonexistent/config.json')).toBe(false);
  });
});

describe('XDG autostart (Linux)', () => {
  it('.desktop を ~/.config/autostart に冪等に書き込む', () => {
    const home = makeHome();
    const target = installLinuxAutostart(home, '/opt/Atelier Bridge/bridge');
    expect(target).toBe(autostartFilePath(home));
    const body = fs.readFileSync(target, 'utf8');
    expect(body).toContain('[Desktop Entry]');
    expect(body).toContain('Name=Atelier Bridge');
    // スペース入りパスも引用されて壊れない
    expect(body).toContain('Exec="/opt/Atelier Bridge/bridge"');
    // 冪等: 2 回目も同じ内容で上書き成功
    expect(installLinuxAutostart(home, '/opt/Atelier Bridge/bridge')).toBe(target);
  });

  it('Exec 内の二重引用符はエスケープされる', () => {
    expect(autostartDesktopEntry('/x/"y"/bridge')).toContain('Exec="/x/\\"y\\"/bridge"');
  });
});
