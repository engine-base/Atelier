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
    });
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
