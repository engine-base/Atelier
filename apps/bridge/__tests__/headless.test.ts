/** T-F-41: runHeadless — token ガード / 1 サイクル / auth-error 停止。 */

import { describe, expect, it } from 'vitest';

import type { CycleOutcome } from '../src/dispatcher.js';
import { runHeadless } from '../src/headless.js';

function runnerOf(outcomes: CycleOutcome[]): { runOnce(): Promise<CycleOutcome> } {
  return {
    async runOnce() {
      return outcomes.shift() ?? 'no-task';
    },
  };
}

describe('runHeadless (T-F-41)', () => {
  it('token 無しは claim せず exit 2', async () => {
    const code = await runHeadless({ env: { ATELIER_BRIDGE_CHAT_RELAY: '0' }, argv: [] });
    expect(code).toBe(2);
  });

  it('no-task で 0 終了 (単発)', async () => {
    const code = await runHeadless({
      env: { ATELIER_BRIDGE_TOKEN: 'tk', ATELIER_BRIDGE_CHAT_RELAY: '0' },
      argv: [],
      makeRunner: () => runnerOf(['no-task']),
    });
    expect(code).toBe(0);
  });

  it('completed 後も loop 無しなら継続せず 0', async () => {
    const code = await runHeadless({
      env: { ATELIER_BRIDGE_TOKEN: 'tk', ATELIER_BRIDGE_CHAT_RELAY: '0' },
      argv: [],
      makeRunner: () => runnerOf(['completed']),
    });
    expect(code).toBe(0);
  });

  it('auth-error は exit 2 (loop 中でも停止)', async () => {
    const code = await runHeadless({
      env: { ATELIER_BRIDGE_TOKEN: 'tk', ATELIER_BRIDGE_CHAT_RELAY: '0' },
      argv: ['--loop'],
      makeRunner: () => runnerOf(['completed', 'auth-error']),
      sleepMs: 0,
    });
    expect(code).toBe(2);
  });
});

describe('makeDefaultRunner', () => {
  it('env から実 Dispatcher を構築できる (実行はしない)', async () => {
    const { makeDefaultRunner } = await import('../src/headless.js');
    const runner = makeDefaultRunner('tk', {
      ATELIER_API_URL: 'http://api.test',
      ATELIER_BRIDGE_PROJECT: 'p1',
      ATELIER_BRIDGE_CMD: 'echo',
      ATELIER_BRIDGE_TIMEOUT_MS: '1000',
    });
    expect(typeof runner.runOnce).toBe('function');
  });
});

describe('runHeadless --loop', () => {
  it('no-task 後も loop なら次サイクルへ進み、completed 後は継続', async () => {
    const code = await runHeadless({
      env: { ATELIER_BRIDGE_TOKEN: 'tk', ATELIER_BRIDGE_CHAT_RELAY: '0' },
      argv: ['--loop'],
      makeRunner: () => runnerOf(['no-task', 'completed', 'auth-error']),
      sleepMs: 0,
    });
    expect(code).toBe(2); // 最後は auth-error で停止
  });
});

describe('runHeadless — chat relay (GAP-114)', () => {
  it('既定 ON: 単発モードでチャット中継を 1 回試行する', async () => {
    const calls: string[] = [];
    const code = await runHeadless({
      env: { ATELIER_BRIDGE_TOKEN: 'tk' },
      argv: [],
      makeRunner: () => runnerOf(['no-task']),
      makeChatRelay: () => ({
        async runOnce() {
          calls.push('chat');
          return 'no-job' as const;
        },
      }),
    });
    expect(code).toBe(0);
    expect(calls).toEqual(['chat']);
  });

  it("ATELIER_BRIDGE_CHAT_RELAY='0' では中継を起動しない", async () => {
    const calls: string[] = [];
    const code = await runHeadless({
      env: { ATELIER_BRIDGE_TOKEN: 'tk', ATELIER_BRIDGE_CHAT_RELAY: '0' },
      argv: [],
      makeRunner: () => runnerOf(['no-task']),
      makeChatRelay: () => ({
        async runOnce() {
          calls.push('chat');
          return 'no-job' as const;
        },
      }),
    });
    expect(code).toBe(0);
    expect(calls).toEqual([]);
  });

  it('loop モードではチャット中継ループが複数回回り、終了時に止まる', async () => {
    let chatCalls = 0;
    const code = await runHeadless({
      env: { ATELIER_BRIDGE_TOKEN: 'tk' },
      argv: ['--loop'],
      makeRunner: () => runnerOf(['no-task', 'auth-error']),
      makeChatRelay: () => ({
        async runOnce() {
          chatCalls += 1;
          return 'no-job' as const;
        },
      }),
      sleepMs: 5,
    });
    expect(code).toBe(2);
    expect(chatCalls).toBeGreaterThanOrEqual(1);
  });
});

describe('runHeadless — chat relay の異常系と既定生成 (GAP-114)', () => {
  it('単発モード: chat.runOnce が throw してもタスク側は完走する', async () => {
    const code = await runHeadless({
      env: { ATELIER_BRIDGE_TOKEN: 'tk' },
      argv: [],
      makeRunner: () => runnerOf(['no-task']),
      makeChatRelay: () => ({
        async runOnce(): Promise<'no-job'> {
          throw new Error('network down');
        },
      }),
    });
    expect(code).toBe(0);
  });

  it('loop モード: chat.runOnce の throw はループを殺さない', async () => {
    let chatCalls = 0;
    const code = await runHeadless({
      env: { ATELIER_BRIDGE_TOKEN: 'tk' },
      argv: ['--loop'],
      makeRunner: () => runnerOf(['no-task', 'no-task', 'auth-error']),
      makeChatRelay: () => ({
        async runOnce(): Promise<'no-job'> {
          chatCalls += 1;
          throw new Error('network down');
        },
      }),
      sleepMs: 5,
    });
    expect(code).toBe(2);
    expect(chatCalls).toBeGreaterThanOrEqual(1);
  });

  it('makeDefaultChatRelay は実 ChatRelayWorker を構成する (ネットワーク未使用)', async () => {
    const { makeDefaultChatRelay } = await import('../src/headless.js');
    const { ChatRelayWorker } = await import('../src/chat-relay.js');
    const worker = makeDefaultChatRelay('tk', {
      ATELIER_API_URL: 'http://api.test',
      ATELIER_BRIDGE_TIMEOUT_MS: '1234',
    });
    expect(worker).toBeInstanceOf(ChatRelayWorker);
  });
});
