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
    const code = await runHeadless({ env: {}, argv: [] });
    expect(code).toBe(2);
  });

  it('no-task で 0 終了 (単発)', async () => {
    const code = await runHeadless({
      env: { ATELIER_BRIDGE_TOKEN: 'tk' },
      argv: [],
      makeRunner: () => runnerOf(['no-task']),
    });
    expect(code).toBe(0);
  });

  it('completed 後も loop 無しなら継続せず 0', async () => {
    const code = await runHeadless({
      env: { ATELIER_BRIDGE_TOKEN: 'tk' },
      argv: [],
      makeRunner: () => runnerOf(['completed']),
    });
    expect(code).toBe(0);
  });

  it('auth-error は exit 2 (loop 中でも停止)', async () => {
    const code = await runHeadless({
      env: { ATELIER_BRIDGE_TOKEN: 'tk' },
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
      env: { ATELIER_BRIDGE_TOKEN: 'tk' },
      argv: ['--loop'],
      makeRunner: () => runnerOf(['no-task', 'completed', 'auth-error']),
      sleepMs: 0,
    });
    expect(code).toBe(2); // 最後は auth-error で停止
  });
});
