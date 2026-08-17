/**
 * Atelier Bridge — ワンクリック接続 (GAP-122)
 *
 * Web の「アプリで接続」ボタンが開く `atelier-bridge://connect?api=...&token=...`
 * を解釈し、接続設定 (~/.atelier-bridge.json) として永続化する。
 * 以後の起動は env が無くてもこの設定でチャット中継ループを開始できる。
 *
 * セキュリティ:
 *   - token はユーザー別 Bridge トークン (チャット中継 + presence 限定)。
 *   - 設定ファイルは mode 0600 で保存 (他ユーザーから読めない)。
 *   - api は http(s) のみ受理 (それ以外のスキームは拒否)。
 */

import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

export const PROTOCOL_SCHEME = 'atelier-bridge';
export const CONFIG_FILE_NAME = '.atelier-bridge.json';

export interface BridgeConnectConfig {
  readonly apiUrl: string;
  readonly token: string;
}

/** `atelier-bridge://connect?api=...&token=...` を解釈する (対象外は null)。 */
export function parseConnectUrl(raw: string): BridgeConnectConfig | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== `${PROTOCOL_SCHEME}:`) return null;
  // `scheme://connect` は host に、`scheme:connect` は pathname に入る — 両対応
  const action = url.host || url.pathname.replace(/^\/+/, '');
  if (action !== 'connect') return null;
  const api = url.searchParams.get('api');
  const token = url.searchParams.get('token');
  if (!api || !token) return null;
  let apiUrl: URL;
  try {
    apiUrl = new URL(api);
  } catch {
    return null;
  }
  if (apiUrl.protocol !== 'http:' && apiUrl.protocol !== 'https:') return null;
  return { apiUrl: api, token };
}

/** argv (Windows/Linux はディープリンクが引数で届く) から接続 URL を探す。 */
export function findConnectUrlInArgv(argv: readonly string[]): string | null {
  return argv.find((a) => a.startsWith(`${PROTOCOL_SCHEME}://`)) ?? null;
}

/** 接続設定ファイルのパス (~/.atelier-bridge.json)。 */
export function configFilePath(homeDir: string): string {
  return path.join(homeDir, CONFIG_FILE_NAME);
}

/** 接続設定を保存する (mode 0600)。 */
export function saveConnectConfig(filePath: string, config: BridgeConnectConfig): void {
  writeFileSync(filePath, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  // 既存ファイル上書き時は mode が保持されるため明示的に締める
  chmodSync(filePath, 0o600);
}

/** 接続設定を読み込む (無い・壊れている場合は null — 推測で補完しない)。 */
export function loadConnectConfig(filePath: string): BridgeConnectConfig | null {
  if (!existsSync(filePath)) return null;
  try {
    const parsed = JSON.parse(readFileSync(filePath, 'utf8')) as Record<string, unknown>;
    if (typeof parsed.apiUrl !== 'string' || typeof parsed.token !== 'string') return null;
    if (parsed.apiUrl === '' || parsed.token === '') return null;
    return { apiUrl: parsed.apiUrl, token: parsed.token };
  } catch {
    return null;
  }
}
