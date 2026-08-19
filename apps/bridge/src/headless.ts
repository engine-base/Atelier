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
 *   ATELIER_BRIDGE_SCHEDULE_TICKER    '0' で自動実行の見張り (GAP-183) を無効化 (既定 ON)
 *   ATELIER_BRIDGE_SCHEDULE_INTERVAL_MS 見張り間隔 (既定 60000)
 */

import { homedir, hostname } from 'node:os';

import { ApiClient } from './api-client.js';
import { ChatRelayWorker, chatRelayEnabled, type ChatRelayOutcome } from './chat-relay.js';
import { resolveClaudeSpawn } from './command.js';
import { configFilePath, loadConnectConfig } from './deep-link.js';
import { DEFAULT_DISPATCHER_CONFIG, Dispatcher, type CycleOutcome } from './dispatcher.js';
import {
  scheduleTickerEnabled,
  tickIntervalMs,
  tickOnce,
  type ScheduleTickerApi,
} from './schedule-ticker.js';
import { BRIDGE_VERSION } from './updates.js';

export interface HeadlessRunner {
  runOnce(): Promise<CycleOutcome>;
}

/** GAP-122: チャット専用降格時に presence を維持する ping 関数。 */
export type PresencePinger = () => Promise<void>;

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
  /** GAP-122: ワンクリック接続の設定ファイル (テスト注入用。省略時 ~/.atelier-bridge.json)。 */
  readonly configPath?: string;
  /** GAP-122: チャット専用降格時の presence pinger (テスト注入用)。 */
  readonly makePinger?: (token: string) => PresencePinger;
  /** GAP-183: 自動実行の見張り (テスト注入用。省略時は実 ApiClient)。 */
  readonly makeScheduleTicker?: (token: string) => ScheduleTickerApi;
}

export function makeDefaultRunner(
  token: string,
  env: Readonly<Record<string, string | undefined>>,
): HeadlessRunner {
  const api = new ApiClient({
    baseUrl: env.ATELIER_API_URL ?? 'http://127.0.0.1:8000',
    token,
  });
  // GAP-135: Windows ネイティブ (.cmd シム) / macOS GUI 起動 (最小 PATH) でも
  // claude を起動できるように実体を解決してから渡す。
  const spec = resolveClaudeSpawn(env.ATELIER_BRIDGE_CMD ?? DEFAULT_DISPATCHER_CONFIG.command, {
    env,
  });
  const childEnv =
    Object.keys(spec.extraEnv).length > 0
      ? {
          ...Object.fromEntries(
            Object.entries(env).filter((e): e is [string, string] => e[1] !== undefined),
          ),
          ...spec.extraEnv,
        }
      : undefined;
  return new Dispatcher(api, {
    ...DEFAULT_DISPATCHER_CONFIG,
    workerPid: process.pid,
    projectId: env.ATELIER_BRIDGE_PROJECT,
    command: spec.command,
    prependArgs: spec.prependArgs,
    childEnv,
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
  // GAP-135: claude 実体を解決 (npm-shim のときは extraEnv を子 env に合流)
  const spec = resolveClaudeSpawn(env.ATELIER_BRIDGE_CMD ?? 'claude', { env });
  return new ChatRelayWorker(api, {
    workerId: `${hostname()}#${process.pid}`,
    command: spec.command,
    prependArgs: spec.prependArgs,
    timeoutMs: Number(env.ATELIER_BRIDGE_TIMEOUT_MS ?? 180_000),
    env: { ...env, ...spec.extraEnv },
    flushIntervalMs: 300,
  });
}

/** GAP-183: 実 ApiClient で自動実行の見張りを行う。 */
export function makeDefaultScheduleTicker(
  token: string,
  env: Readonly<Record<string, string | undefined>>,
): ScheduleTickerApi {
  return new ApiClient({
    baseUrl: env.ATELIER_API_URL ?? 'http://127.0.0.1:8000',
    token,
  });
}

/** GAP-122: 実 ApiClient で presence を送る pinger。 */
export function makeDefaultPinger(
  token: string,
  env: Readonly<Record<string, string | undefined>>,
): PresencePinger {
  const api = new ApiClient({
    baseUrl: env.ATELIER_API_URL ?? 'http://127.0.0.1:8000',
    token,
  });
  return () =>
    api.ping({
      workerId: `${hostname()}#${process.pid}`,
      hostLabel: hostname(),
      version: BRIDGE_VERSION,
      workerPid: process.pid,
    });
}

export async function runHeadless(opts: HeadlessOptions): Promise<number> {
  // GAP-122: env に無ければワンクリック接続の設定ファイルを読む
  // (env が常に優先 — 明示指定を黙って上書きしない)
  let env = opts.env;
  if (!env.ATELIER_BRIDGE_TOKEN) {
    const stored = loadConnectConfig(opts.configPath ?? configFilePath(homedir()));
    if (stored) {
      env = {
        ...env,
        ATELIER_BRIDGE_TOKEN: stored.token,
        ATELIER_API_URL: env.ATELIER_API_URL ?? stored.apiUrl,
      };
      console.log('[bridge] ワンクリック接続の保存設定を使用します');
    }
  }
  const token = env.ATELIER_BRIDGE_TOKEN;
  if (!token) {
    console.error(
      'ATELIER_BRIDGE_TOKEN が未設定です (アプリの「接続」も未実行)。claim せず終了します。',
    );
    return 2;
  }
  const runner = (opts.makeRunner ?? ((t) => makeDefaultRunner(t, env)))(token);
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

  // GAP-183: 自動実行の見張り (既定 ON)。クラウドに毎分 cron を置かずに済ませる
  // ための時計。起動直後に 1 回動かすので、スリープ中に過ぎた分はここで走る。
  let scheduleLoopStop = false;
  let scheduleLoopDone: Promise<void> = Promise.resolve();
  if (scheduleTickerEnabled(env)) {
    const ticker = (opts.makeScheduleTicker ?? ((t) => makeDefaultScheduleTicker(t, env)))(token);
    const interval = opts.sleepMs !== undefined ? opts.sleepMs : tickIntervalMs(env);
    await tickOnce(ticker);
    if (loop) {
      scheduleLoopDone = (async () => {
        while (!scheduleLoopStop) {
          await new Promise((r) => setTimeout(r, interval));
          if (scheduleLoopStop) break;
          await tickOnce(ticker);
        }
      })();
    }
  }

  try {
    do {
      let outcome: CycleOutcome;
      try {
        outcome = await runner.runOnce();
      } catch (err: unknown) {
        // GAP-122: user トークンはタスク実行 (kanban) が 403 — チャット中継専用
        // として降格し、チャットループだけで待機し続ける (fatal 終了させない)。
        // presence (接続バッジ) は task ループが送っていたため、降格後は
        // 自前の ping ループで維持する。
        if (loop && String(err).includes('403')) {
          console.log(
            '[bridge] このトークンではタスク実行は行いません (チャット中継のみで待機します)',
          );
          const ping =
            (opts.makePinger ?? ((t: string) => makeDefaultPinger(t, env)))(token);
          const pingLoop = (async () => {
            while (!chatLoopStop) {
              await ping().catch(() => {
                /* presence 失敗は致命ではない */
              });
              await new Promise((r) => setTimeout(r, opts.sleepMs ?? 10_000));
            }
          })();
          await chatLoopDone; // chatLoopStop が立つまで回り続ける (実質常駐)
          await pingLoop;
          return 0;
        }
        throw err;
      }
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
    scheduleLoopStop = true;
    await chatLoopDone;
    await scheduleLoopDone;
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
