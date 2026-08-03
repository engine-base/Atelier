/**
 * T-F-41: Dispatcher 3-tier AC テスト (vitest)。
 *
 * API は fake (呼び出し記録)、child は echo / false / sleep で実行経路を検証する。
 */

import { describe, expect, it } from 'vitest';

import { BridgeAuthError, type BridgeApi, type KanbanPickResult } from '../src/api-client.js';
import {
  DEFAULT_DISPATCHER_CONFIG,
  Dispatcher,
  buildDefaultPrompt,
  type TaskPromptContext,
} from '../src/dispatcher.js';

class FakeApi implements BridgeApi {
  readonly calls: string[] = [];
  pickResult: KanbanPickResult = {
    taskId: 'task-1',
    executionId: 'exec-1',
    worktreePath: null,
    noAvailableTask: false,
    taskTitle: 'ログイン画面のバリデーション実装',
    taskDescription: 'メール形式チェックとエラー文言を追加する',
    assignedEmployee: 'thor',
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

describe('buildDefaultPrompt (GAP-030)', () => {
  it('タスク内容 (title/description/担当) をプロンプトに含める', () => {
    const prompt = buildDefaultPrompt({
      taskId: 'task-9',
      taskTitle: '見積画面の追加',
      taskDescription: '一覧と詳細を作る',
      assignedEmployee: 'wanda',
    });
    expect(prompt).toContain('task-9');
    expect(prompt).toContain('見積画面の追加');
    expect(prompt).toContain('一覧と詳細を作る');
    expect(prompt).toContain('wanda');
    // 子 Claude が仕様を探しに行って長考しない指示 (タイムアウト是正の要)
    expect(prompt).toContain('探しに行かず');
  });

  it('null フィールドは行ごと省いて ID のみでも成立する', () => {
    const prompt = buildDefaultPrompt({
      taskId: 'task-0',
      taskTitle: null,
      taskDescription: null,
      assignedEmployee: null,
    });
    expect(prompt).toContain('task-0');
    expect(prompt).not.toContain('タイトル:');
    expect(prompt).not.toContain('内容:');
  });

  it('Dispatcher が buildArgs にタスク文脈を渡す', async () => {
    const api = new FakeApi();
    const seen: TaskPromptContext[] = [];
    const d = new Dispatcher(api, {
      ...DEFAULT_DISPATCHER_CONFIG,
      workerPid: process.pid,
      command: 'echo',
      buildArgs: (task) => {
        seen.push(task);
        return ['ok'];
      },
      logDir: '/tmp/atelier-bridge-test-logs',
      timeoutMs: 30_000,
      heartbeatMs: 50,
    });
    await d.runOnce();
    expect(seen).toHaveLength(1);
    expect(seen[0]).toEqual({
      taskId: 'task-1',
      taskTitle: 'ログイン画面のバリデーション実装',
      taskDescription: 'メール形式チェックとエラー文言を追加する',
      assignedEmployee: 'thor',
    });
  });
});

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
      taskTitle: null,
      taskDescription: null,
      assignedEmployee: null,
    };
    const d = makeDispatcher(api, 'echo');
    const outcome = await d.runOnce();
    expect(outcome).toBe('no-task');
    expect(api.calls).toEqual(['pick']);
  });
});
