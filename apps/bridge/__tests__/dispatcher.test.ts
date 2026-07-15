/**
 * T-F-41: Dispatcher 3-tier AC テスト (vitest)。
 *
 * API は fake (呼び出し記録)、child は echo / false / sleep で実行経路を検証する。
 */

import { describe, expect, it } from 'vitest';

import { BridgeAuthError, type BridgeApi, type KanbanPickResult } from '../src/api-client.js';
import { DEFAULT_DISPATCHER_CONFIG, Dispatcher } from '../src/dispatcher.js';

class FakeApi implements BridgeApi {
  readonly calls: string[] = [];
  pickResult: KanbanPickResult = {
    taskId: 'task-1',
    executionId: 'exec-1',
    worktreePath: null,
    noAvailableTask: false,
  };
  authFail = false;

  async pick(): Promise<KanbanPickResult> {
    if (this.authFail) throw new BridgeAuthError('401');
    this.calls.push('pick');
    return this.pickResult;
  }
  async start(): Promise<void> {
    this.calls.push('start');
  }
  async complete(_t: string, _e: string, summary: string): Promise<void> {
    this.calls.push(`complete:${summary.length > 0 ? 'with-summary' : 'empty'}`);
  }
  async requestChange(_t: string, _e: string, reason: string): Promise<void> {
    this.calls.push(`request-change:${reason.split(' ')[0]}`);
  }
  async heartbeat(): Promise<void> {
    this.calls.push('heartbeat');
  }
}

function makeDispatcher(api: BridgeApi, command: string, timeoutMs = 30_000): Dispatcher {
  return new Dispatcher(api, {
    ...DEFAULT_DISPATCHER_CONFIG,
    workerPid: process.pid,
    command,
    buildArgs: () => ['bridge-test-output'],
    logDir: '/tmp/atelier-bridge-test-logs',
    timeoutMs,
    heartbeatMs: 50,
  });
}

describe('Dispatcher.runOnce (T-F-41)', () => {
  it('claim→実行→complete の順で API を呼ぶ (exit 0)', async () => {
    const api = new FakeApi();
    const d = makeDispatcher(api, 'echo');
    const outcome = await d.runOnce();
    expect(outcome).toBe('completed');
    expect(api.calls[0]).toBe('pick');
    expect(api.calls[1]).toBe('start');
    expect(api.calls.at(-1)).toBe('complete:with-summary');
  });

  it('exit 非 0 で request-change を呼ぶ', async () => {
    const api = new FakeApi();
    const d = makeDispatcher(api, 'false');
    const outcome = await d.runOnce();
    expect(outcome).toBe('change-requested');
    expect(api.calls.at(-1)).toBe('request-change:exit');
  });

  it('timeout で kill され request-change (timeout) になる', async () => {
    const api = new FakeApi();
    const d = new Dispatcher(api, {
      ...DEFAULT_DISPATCHER_CONFIG,
      workerPid: process.pid,
      command: 'sleep',
      buildArgs: () => ['30'],
      logDir: '/tmp/atelier-bridge-test-logs',
      timeoutMs: 300,
      heartbeatMs: 50,
    });
    const outcome = await d.runOnce();
    expect(outcome).toBe('change-requested');
    expect(api.calls.at(-1)).toBe('request-change:timeout');
  });

  it('401 (BridgeAuthError) では claim せず auth-error で停止する', async () => {
    const api = new FakeApi();
    api.authFail = true;
    const d = makeDispatcher(api, 'echo');
    const outcome = await d.runOnce();
    expect(outcome).toBe('auth-error');
    expect(api.calls).toEqual([]); // start/complete は一切呼ばれない
  });

  it('no_available_task では何も実行しない', async () => {
    const api = new FakeApi();
    api.pickResult = {
      taskId: null,
      executionId: null,
      worktreePath: null,
      noAvailableTask: true,
    };
    const d = makeDispatcher(api, 'echo');
    const outcome = await d.runOnce();
    expect(outcome).toBe('no-task');
    expect(api.calls).toEqual(['pick']);
  });
});
