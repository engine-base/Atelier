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
 *   ATELIER_BRIDGE_CHAT_RELAY '0' でチャット中継 (GAP-114) を無効化 (既定 ON)
 */

import { hostname } from 'node:os';

import { ApiClient } from './api-client.js';
import { ChatRelayWorker, chatRelayEnabled, type ChatRelayOutcome } from './chat-relay.js';
import { DEFAULT_DISPATCHER_CONFIG, Dispatcher, type CycleOutcome } from './dispatcher.js';

export interface HeadlessRunner {
  runOnce(): Promise<CycleOutcome>;
}

export interface ChatRelayRunner {
  runOnce(): Promise<ChatRelayOutcome>;
}

export interface HeadlessOptions {
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly argv: readonly string[];
  /** テスト注入用。省略時は実 ApiClient + Dispatcher。 */
  readonly makeRunner?: (token: string) => HeadlessRunner;
  /** テスト注入用。省略時は実 ChatRelayWorker (GAP-114)。 */
  readonly makeChatRelay?: (token: string) => ChatRelayRunner;
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

/** GAP-114: 実 ChatRelayWorker を生成する (headless 既定)。 */
export function makeDefaultChatRelay(
  token: string,
  env: Readonly<Record<string, string | undefined>>,
): ChatRelayRunner {
  const api = new ApiClient({
    baseUrl: env.ATELIER_API_URL ?? 'http://127.0.0.1:8000',
    token,
  });
  return new ChatRelayWorker(api, {
    workerId: `${hostname()}#${process.pid}`,
    command: env.ATELIER_BRIDGE_CMD ?? 'claude',
    timeoutMs: Number(env.ATELIER_BRIDGE_TIMEOUT_MS ?? 180_000),
    env,
    flushIntervalMs: 300,
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

  // GAP-114: チャット中継 (既定 ON)。タスク claim とは独立の高頻度ループで回す
  // (チャットは応答レイテンシが体感を決めるため、タスクの 10s 間隔に縛らない)。
  let chatLoopStop = false;
  let chatLoopDone: Promise<void> = Promise.resolve();
  if (chatRelayEnabled(opts.env)) {
    const chat = (opts.makeChatRelay ?? ((t) => makeDefaultChatRelay(t, opts.env)))(token);
    const chatSleep = opts.sleepMs !== undefined ? Math.min(opts.sleepMs, 1_000) : 1_000;
    if (loop) {
      chatLoopDone = (async () => {
        while (!chatLoopStop) {
          try {
            const outcome = await chat.runOnce();
            if (outcome !== 'no-job') console.log(`[bridge:chat-relay] ${outcome}`);
          } catch (err: unknown) {
            console.error('[bridge:chat-relay] cycle error:', err);
          }
          await new Promise((r) => setTimeout(r, chatSleep));
        }
      })();
    } else {
      // 単発モードでも 1 回だけ拾う (デバッグ用)。チャット中継の失敗で
      // タスク claim を止めない (独立経路)。
      try {
        const outcome = await chat.runOnce();
        console.log(`[bridge:chat-relay] ${outcome}`);
      } catch (err: unknown) {
        console.error('[bridge:chat-relay] cycle error:', err);
      }
    }
  }

  try {
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
  } finally {
    chatLoopStop = true;
    await chatLoopDone;
  }
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
