/**
 * GAP-135: claude CLI のクロスプラットフォーム解決の unit tests。
 *
 * fs は触らない — exists を注入して各 OS のレイアウトを再現する。
 */

import { describe, expect, it } from 'vitest';

import { resolveClaudeSpawn, searchDirs } from '../src/command.js';

const existsIn =
  (paths: readonly string[]) =>
  (p: string): boolean =>
    paths.includes(p);

describe('resolveClaudeSpawn', () => {
  it('claude 以外の明示指定は一切触らない (テスト/ユーザー差し替えの尊重)', () => {
    const spec = resolveClaudeSpawn('echo', { exists: () => true });
    expect(spec).toMatchObject({ command: 'echo', resolution: 'explicit', prependArgs: [] });
    const abs = resolveClaudeSpawn('/opt/custom/claude-wrapper', { exists: () => true });
    expect(abs.resolution).toBe('explicit');
    expect(abs.command).toBe('/opt/custom/claude-wrapper');
  });

  it('POSIX: PATH 上の実体を発見して絶対パスで返す', () => {
    const spec = resolveClaudeSpawn('claude', {
      platform: 'linux',
      env: { PATH: '/usr/bin:/opt/node22/bin' },
      homeDir: '/home/u',
      exists: existsIn(['/opt/node22/bin/claude']),
    });
    expect(spec.resolution).toBe('path');
    expect(spec.command).toBe('/opt/node22/bin/claude');
    expect(spec.prependArgs).toEqual([]);
    expect(spec.extraEnv).toEqual({});
  });

  it('macOS GUI 起動 (最小 PATH) でも既知ディレクトリから brew の claude を発見する', () => {
    // Dock 起動の Electron は /usr/bin:/bin:/usr/sbin:/sbin しか持たない
    const spec = resolveClaudeSpawn('claude', {
      platform: 'darwin',
      env: { PATH: '/usr/bin:/bin:/usr/sbin:/sbin' },
      homeDir: '/Users/u',
      exists: existsIn(['/opt/homebrew/bin/claude']),
    });
    expect(spec.resolution).toBe('path');
    expect(spec.command).toBe('/opt/homebrew/bin/claude');
  });

  it('macOS: ネイティブインストーラの ~/.local/bin を PATH 不在でも見つける', () => {
    const spec = resolveClaudeSpawn('claude', {
      platform: 'darwin',
      env: { PATH: '/usr/bin' },
      homeDir: '/Users/u',
      exists: existsIn(['/Users/u/.local/bin/claude']),
    });
    expect(spec.command).toBe('/Users/u/.local/bin/claude');
  });

  it('Windows ネイティブ: claude.exe を最優先で直接 spawn する', () => {
    const spec = resolveClaudeSpawn('claude', {
      platform: 'win32',
      env: {
        PATH: 'C:\\Windows\\system32;C:\\Users\\u\\.local\\bin',
        USERPROFILE: 'C:\\Users\\u',
      },
      exists: existsIn(['C:\\Users\\u\\.local\\bin\\claude.exe']),
    });
    expect(spec.resolution).toBe('path');
    expect(spec.command).toBe('C:\\Users\\u\\.local\\bin\\claude.exe');
    expect(spec.prependArgs).toEqual([]);
  });

  it('Windows npm 版: .cmd シムは踏まず cli.js を Node 直実行に置換する (shell 経由なし)', () => {
    const npmDir = 'C:\\Users\\u\\AppData\\Roaming\\npm';
    const cli = `${npmDir}\\node_modules\\@anthropic-ai\\claude-code\\cli.js`;
    const spec = resolveClaudeSpawn('claude', {
      platform: 'win32',
      env: { PATH: `C:\\Windows\\system32;${npmDir}`, USERPROFILE: 'C:\\Users\\u' },
      exists: existsIn([`${npmDir}\\claude.cmd`, cli]),
      execPath: 'C:\\apps\\AtelierBridge\\AtelierBridge.exe',
    });
    expect(spec.resolution).toBe('npm-shim');
    expect(spec.command).toBe('C:\\apps\\AtelierBridge\\AtelierBridge.exe');
    expect(spec.prependArgs).toEqual([cli]);
    // Electron を素の Node として走らせる (これが無いと GUI がもう 1 枚起動する)
    expect(spec.extraEnv).toEqual({ ELECTRON_RUN_AS_NODE: '1' });
    expect(spec.claudePath).toBe(cli);
  });

  it('Windows: シムだけあって cli.js が無い場合は shell 実行に逃げず unresolved', () => {
    const npmDir = 'C:\\Users\\u\\AppData\\Roaming\\npm';
    const spec = resolveClaudeSpawn('claude', {
      platform: 'win32',
      env: { PATH: npmDir, USERPROFILE: 'C:\\Users\\u', APPDATA: 'C:\\Users\\u\\AppData\\Roaming' },
      exists: existsIn([`${npmDir}\\claude.cmd`]),
    });
    expect(spec.resolution).toBe('unresolved');
    expect(spec.command).toBe('claude'); // ENOENT → GAP-127 [claude-not-found] へ
    expect(spec.claudePath).toBeNull();
  });

  it('どこにも無ければ unresolved で元コマンドのまま (導入案内へ)', () => {
    const spec = resolveClaudeSpawn('claude', {
      platform: 'linux',
      env: { PATH: '/usr/bin' },
      homeDir: '/home/u',
      exists: () => false,
    });
    expect(spec.resolution).toBe('unresolved');
    expect(spec.claudePath).toBeNull();
  });
});

describe('searchDirs', () => {
  it('PATH を先頭に、既知ディレクトリを重複除去して連結する', () => {
    const dirs = searchDirs('linux', { PATH: '/usr/bin:/home/u/.local/bin' }, '/home/u');
    expect(dirs[0]).toBe('/usr/bin');
    expect(dirs[1]).toBe('/home/u/.local/bin');
    // 重複 (~/.local/bin) は 1 回だけ
    expect(dirs.filter((d) => d === '/home/u/.local/bin')).toHaveLength(1);
    expect(dirs).toContain('/usr/local/bin');
  });

  it('win32 は ; 区切りで、ネイティブインストーラと npm prefix を補う', () => {
    const dirs = searchDirs(
      'win32',
      { PATH: 'C:\\Windows\\system32', USERPROFILE: 'C:\\Users\\u', APPDATA: 'C:\\Users\\u\\AppData\\Roaming' },
      'C:\\Users\\u',
    );
    expect(dirs).toContain('C:\\Windows\\system32');
    expect(dirs).toContain('C:\\Users\\u\\.local\\bin');
    expect(dirs).toContain('C:\\Users\\u\\AppData\\Roaming\\npm');
  });

  it('nvm 利用者は NVM_BIN が PATH に無くても探索対象になる', () => {
    const dirs = searchDirs(
      'darwin',
      { PATH: '/usr/bin', NVM_BIN: '/Users/u/.nvm/versions/node/v22.12.0/bin' },
      '/Users/u',
    );
    expect(dirs).toContain('/Users/u/.nvm/versions/node/v22.12.0/bin');
  });
});
