/**
 * Atelier Bridge — headless エントリ (T-F-41)
 *
 * Electron UI 無しに claim サイクルを実行する:
 *   node dist/headless.js [--loop]
 *
 * 環境変数:
 *   ATELIER_API_URL           API base (既定 http://127.0.0.1:8000)
 *   ATELIER_BRIDGE_TOKEN      X-Bridge-Token (必須)
 *   ATELIER_BRIDGE_PROJECT    project_id で claim を絞る (任意)
 *   ATELIER_BRIDGE_CMD        実行コマンド (既定 'claude')
 *   ATELIER_BRIDGE_TIMEOUT_MS child timeout (既定 600000)
 */

import { ApiClient } from './api-client.js';
import { DEFAULT_DISPATCHER_CONFIG, Dispatcher } from './dispatcher.js';

async function main(): Promise<number> {
  const token = process.env.ATELIER_BRIDGE_TOKEN;
  if (!token) {
    console.error('ATELIER_BRIDGE_TOKEN が未設定です。claim せず終了します。');
    return 2;
  }
  const api = new ApiClient({
    baseUrl: process.env.ATELIER_API_URL ?? 'http://127.0.0.1:8000',
    token,
  });
  const dispatcher = new Dispatcher(api, {
    ...DEFAULT_DISPATCHER_CONFIG,
    workerPid: process.pid,
    projectId: process.env.ATELIER_BRIDGE_PROJECT,
    command: process.env.ATELIER_BRIDGE_CMD ?? DEFAULT_DISPATCHER_CONFIG.command,
    timeoutMs: Number(process.env.ATELIER_BRIDGE_TIMEOUT_MS ?? DEFAULT_DISPATCHER_CONFIG.timeoutMs),
  });

  const loop = process.argv.includes('--loop');
  do {
    const outcome = await dispatcher.runOnce();
    console.log(`[bridge] cycle outcome: ${outcome}`);
    if (outcome === 'auth-error') return 2;
    if (outcome === 'no-task') {
      if (!loop) return 0;
      await new Promise((r) => setTimeout(r, 10_000));
    }
  } while (loop);
  return 0;
}

main().then(
  (code) => process.exit(code),
  (err) => {
    console.error('[bridge] fatal:', err);
    process.exit(1);
  },
);
