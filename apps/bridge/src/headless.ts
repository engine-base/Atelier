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
import { DEFAULT_DISPATCHER_CONFIG, Dispatcher, type CycleOutcome } from './dispatcher.js';

export interface HeadlessRunner {
  runOnce(): Promise<CycleOutcome>;
}

export interface HeadlessOptions {
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly argv: readonly string[];
  /** テスト注入用。省略時は実 ApiClient + Dispatcher。 */
  readonly makeRunner?: (token: string) => HeadlessRunner;
  /** loop 時の待機 (テストでは 0 に)。 */
  readonly sleepMs?: number;
}

export function makeDefaultRunner(
  token: string,
  env: Readonly<Record<string, string | undefined>>,
): HeadlessRunner {
  const api = new ApiClient({
    baseUrl: env.ATELIER_API_URL ?? 'http://127.0.0.1:8000',
    token,
  });
  return new Dispatcher(api, {
    ...DEFAULT_DISPATCHER_CONFIG,
    workerPid: process.pid,
    projectId: env.ATELIER_BRIDGE_PROJECT,
    command: env.ATELIER_BRIDGE_CMD ?? DEFAULT_DISPATCHER_CONFIG.command,
    timeoutMs: Number(env.ATELIER_BRIDGE_TIMEOUT_MS ?? DEFAULT_DISPATCHER_CONFIG.timeoutMs),
  });
}

export async function runHeadless(opts: HeadlessOptions): Promise<number> {
  const token = opts.env.ATELIER_BRIDGE_TOKEN;
  if (!token) {
    console.error('ATELIER_BRIDGE_TOKEN が未設定です。claim せず終了します。');
    return 2;
  }
  const runner = (opts.makeRunner ?? ((t) => makeDefaultRunner(t, opts.env)))(token);
  const loop = opts.argv.includes('--loop');
  do {
    const outcome = await runner.runOnce();
    console.log(`[bridge] cycle outcome: ${outcome}`);
    if (outcome === 'auth-error') return 2;
    if (outcome === 'no-task') {
      if (!loop) return 0;
      await new Promise((r) => setTimeout(r, opts.sleepMs ?? 10_000));
    }
  } while (loop);
  return 0;
}

// 直接実行時のみ起動 (vitest import 時は走らない)
/* v8 ignore start -- process.exit を伴う実行時エントリはユニットテスト対象外 */
if (process.argv[1]?.endsWith('headless.js')) {
  runHeadless({ env: process.env, argv: process.argv }).then(
    (code) => process.exit(code),
    (err) => {
      console.error('[bridge] fatal:', err);
      process.exit(1);
    },
  );
}
/* v8 ignore stop */
