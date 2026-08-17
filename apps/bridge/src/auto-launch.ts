/**
 * GAP-126: ログイン時自動起動 (Bridge を「繋ぎっぱなし」にする)。
 *
 * 接続トークンは無期限だが、接続中と表示されるのは Bridge プロセスが生きて
 * いる間だけ。OS 再起動後に手でアプリを開かないと未接続に戻る、が唯一の
 * 弱点だった (経営者指摘)。本モジュールで OS ログイン時に自動起動させる:
 *   - macOS / Windows: Electron の setLoginItemSettings (electron-entry 側)
 *   - Linux: XDG autostart (~/.config/autostart/atelier-bridge.desktop)
 *
 * 登録は「接続済み (トークンがある)」ときだけ行う — 未接続のまま常駐しても
 * 意味がなく、インストール直後から勝手に立ち上がる挙動は不信を生むため。
 */

import fs from 'node:fs';
import path from 'node:path';

import { loadConnectConfig } from './deep-link.js';

/** 接続済みか (env のトークン or ワンクリック接続の保存設定)。 */
export function hasConnection(
  env: Record<string, string | undefined>,
  configPath: string,
): boolean {
  if (env.ATELIER_BRIDGE_TOKEN) return true;
  return loadConnectConfig(configPath) !== null;
}

/** XDG autostart の配置先 (Linux)。 */
export function autostartFilePath(home: string): string {
  return path.join(home, '.config', 'autostart', 'atelier-bridge.desktop');
}

/** .desktop の中身。Exec はスペース入りパスに備えて必ず引用する。 */
export function autostartDesktopEntry(execPath: string): string {
  return [
    '[Desktop Entry]',
    'Type=Application',
    'Name=Atelier Bridge',
    `Exec="${execPath.replaceAll('"', '\\"')}"`,
    'X-GNOME-Autostart-enabled=true',
    'Comment=Atelier と Claude プランの接続をログイン時に自動再開します',
    '',
  ].join('\n');
}

/** Linux: XDG autostart エントリを書き込む (冪等 — 常に上書き)。 */
export function installLinuxAutostart(home: string, execPath: string): string {
  const target = autostartFilePath(home);
  fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
  fs.writeFileSync(target, autostartDesktopEntry(execPath), { mode: 0o644 });
  return target;
}
