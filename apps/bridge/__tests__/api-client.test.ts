/** T-F-41: ApiClient — fetch モックで全 endpoint + 認証エラー経路を検証。 */

import { afterEach, describe, expect, it, vi } from 'vitest';

import { ApiClient, BridgeAuthError } from '../src/api-client.js';

function mockFetch(status: number, body: unknown): typeof fetch {
  return vi.fn(async () => ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  })) as unknown as typeof fetch;
}

function client(): ApiClient {
  return new ApiClient({ baseUrl: 'http://api.test', token: 'tk' });
}

afterEach(() => vi.unstubAllGlobals());

describe('ApiClient (T-F-41)', () => {
  it('pick: レスポンスを camelCase に写像する', async () => {
    vi.stubGlobal(
      'fetch',
      mockFetch(200, {
        data: {
          task_id: 't1',
          execution_id: 'e1',
          worktree_path: null,
          no_available_task: false,
        },
      }),
    );
    const r = await client().pick(123);
    expect(r).toEqual({
      taskId: 't1',
      executionId: 'e1',
      worktreePath: null,
      noAvailableTask: false,
      // GAP-030: タスク内容フィールドは旧 API 応答 (欠落) では null に落ちる
      taskTitle: null,
      taskDescription: null,
      assignedEmployee: null,
    });
  });

  it('pick: タスク内容 (GAP-030) を camelCase に写像する', async () => {
    vi.stubGlobal(
      'fetch',
      mockFetch(200, {
        data: {
          task_id: 't1',
          execution_id: 'e1',
          worktree_path: null,
          no_available_task: false,
          task_title: '見積画面',
          task_description: '一覧を作る',
          assigned_employee: 'wanda',
        },
      }),
    );
    const r = await client().pick(123);
    expect(r.taskTitle).toBe('見積画面');
    expect(r.taskDescription).toBe('一覧を作る');
    expect(r.assignedEmployee).toBe('wanda');
  });

  it('pick: X-Bridge-Token を送る', async () => {
    const f = mockFetch(200, { data: { no_available_task: true } });
    vi.stubGlobal('fetch', f);
    await client().pick(1);
    const call = (f as unknown as { mock: { calls: [string, RequestInit][] } }).mock.calls[0];
    expect((call[1].headers as Record<string, string>)['X-Bridge-Token']).toBe('tk');
  });

  it('401 は BridgeAuthError', async () => {
    vi.stubGlobal('fetch', mockFetch(401, { detail: 'invalid bridge token' }));
    await expect(client().pick(1)).rejects.toBeInstanceOf(BridgeAuthError);
  });

  it('500 (token 未設定の API 側) も BridgeAuthError', async () => {
    vi.stubGlobal('fetch', mockFetch(500, { detail: 'bridge token not configured' }));
    await expect(client().pick(1)).rejects.toBeInstanceOf(BridgeAuthError);
  });

  it('その他 4xx は通常 Error', async () => {
    vi.stubGlobal('fetch', mockFetch(409, { detail: 'invalid_state' }));
    await expect(client().start('t', 'e', 1)).rejects.toThrow('/kanban/start failed: 409');
  });

  it('start/complete/requestChange/heartbeat が snake_case body を送る', async () => {
    const f = mockFetch(200, { data: {} });
    vi.stubGlobal('fetch', f);
    const c = client();
    await c.start('t1', 'e1', 9);
    await c.complete('t1', 'e1', 'done', {
      score: 1,
      acPassRate: 1,
      testPassRate: 1,
      verificationScore: 1,
      retryCount: 0,
      filesChanged: [],
    });
    await c.requestChange('t1', 'e1', 'ng');
    await c.heartbeat('t1', 9);
    const calls = (f as unknown as { mock: { calls: [string, RequestInit][] } }).mock.calls;
    const bodies = calls.map((x) => JSON.parse(String(x[1].body)));
    expect(bodies[0]).toEqual({ task_id: 't1', execution_id: 'e1', worker_pid: 9 });
    expect(bodies[1].metadata.ac_pass_rate).toBe(1);
    expect(bodies[1].auto_approve).toBe(false);
    expect(bodies[2].reason).toBe('ng');
    expect(bodies[3]).toEqual({ task_id: 't1', worker_pid: 9 });
  });
});

describe('ApiClient — chat relay (GAP-114)', () => {
  it('chatRelayPick: job を camelCase に写像する', async () => {
    vi.stubGlobal(
      'fetch',
      mockFetch(200, {
        data: {
          job_id: 'j1',
          system_prompt: 'SYS',
          prompt: 'PROMPT',
          no_available_job: false,
        },
      }),
    );
    const r = await client().chatRelayPick('host#1');
    // GAP-134: tools_mode 不在 (旧サーバー) は off に既定化する
    expect(r).toEqual({ jobId: 'j1', systemPrompt: 'SYS', prompt: 'PROMPT', toolsMode: 'off' });
  });

  it('chatRelayPick: tools_mode=approve を写像する (GAP-134)', async () => {
    vi.stubGlobal(
      'fetch',
      mockFetch(200, {
        data: {
          job_id: 'j2',
          system_prompt: 'SYS',
          prompt: 'PROMPT',
          tools_mode: 'approve',
          no_available_job: false,
        },
      }),
    );
    const r = await client().chatRelayPick('host#1');
    expect(r?.toolsMode).toBe('approve');
  });

  it('chatRelayPick: no_available_job は null を返す', async () => {
    vi.stubGlobal(
      'fetch',
      mockFetch(200, {
        data: { job_id: null, system_prompt: null, prompt: null, no_available_job: true },
      }),
    );
    expect(await client().chatRelayPick('host#1')).toBeNull();
  });

  it('chatRelayChunks: seq_start と texts を snake_case で送る', async () => {
    const spy = mockFetch(200, { data: { status: 'ok' } });
    vi.stubGlobal('fetch', spy);
    await client().chatRelayChunks('j1', 3, ['a', 'b']);
    const [url, init] = (spy as unknown as ReturnType<typeof vi.fn>).mock.calls[0] as [
      string,
      { body: string },
    ];
    expect(url).toBe('http://api.test/chat-relay/j1/chunks');
    expect(JSON.parse(init.body)).toEqual({ seq_start: 3, texts: ['a', 'b'] });
  });

  it('chatRelayComplete: ok/error を送る (error 省略時は null)', async () => {
    const spy = mockFetch(200, { data: { status: 'ok' } });
    vi.stubGlobal('fetch', spy);
    await client().chatRelayComplete('j1', false, '実行失敗');
    await client().chatRelayComplete('j2', true);
    const calls = (spy as unknown as ReturnType<typeof vi.fn>).mock.calls as Array<
      [string, { body: string }]
    >;
    expect(calls[0][0]).toBe('http://api.test/chat-relay/j1/complete');
    expect(JSON.parse(calls[0][1].body)).toEqual({ ok: false, error: '実行失敗' });
    expect(JSON.parse(calls[1][1].body)).toEqual({ ok: true, error: null });
  });

  it('chatRelayPick: 401 は BridgeAuthError', async () => {
    vi.stubGlobal('fetch', mockFetch(401, { detail: 'invalid bridge token' }));
    await expect(client().chatRelayPick('host#1')).rejects.toBeInstanceOf(BridgeAuthError);
  });
});
