/**
 * @atelier/api-client unit tests — T-US-04
 *
 * - path placeholder fill / query build の単体検証
 * - get/post/delete の URL/method/body/header/auth/error/204 を mock fetch で検証
 * - AbortSignal 反映
 * - ApiError の構造的フィールド検証
 */

import { describe, expect, it, vi } from 'vitest';

import { ApiError, _internal, createApiClient } from '../src/index';

describe('_internal.fillPath', () => {
  it('replaces single placeholder with encoded value', () => {
    expect(_internal.fillPath('/projects/{project_id}', { project_id: 'abc/def' })).toBe(
      '/projects/abc%2Fdef',
    );
  });
  it('returns template unchanged when no pathParams given', () => {
    expect(_internal.fillPath('/projects', undefined)).toBe('/projects');
  });
  it('throws when required placeholder is missing', () => {
    expect(() => _internal.fillPath('/projects/{project_id}', {})).toThrow(/project_id/);
  });
});

describe('_internal.buildQuery', () => {
  it('returns empty string when query is undefined', () => {
    expect(_internal.buildQuery(undefined)).toBe('');
  });
  it('builds a leading ? query string', () => {
    expect(_internal.buildQuery({ limit: 10, cursor: 'x' })).toBe('?limit=10&cursor=x');
  });
  it('skips null and undefined values', () => {
    expect(_internal.buildQuery({ a: null, b: undefined, c: 1 })).toBe('?c=1');
  });
  it('repeats key for array values', () => {
    expect(_internal.buildQuery({ tag: ['a', 'b'] })).toBe('?tag=a&tag=b');
  });
});

interface MockResponseInit {
  status?: number;
  contentType?: string | null;
  body?: unknown;
}
function makeResponse(init: MockResponseInit = {}): Response {
  const status = init.status ?? 200;
  const body = init.body;
  const ct = init.contentType === undefined ? 'application/json' : init.contentType;
  const headers = new Headers();
  if (ct) headers.set('content-type', ct);
  const bodyStr =
    body === undefined ? null : ct?.includes('application/json') ? JSON.stringify(body) : String(body);
  return new Response(bodyStr, { status, statusText: status === 200 ? 'OK' : `S${status}`, headers });
}

describe('createApiClient', () => {
  it('GET: builds URL with baseURL + path + query and parses JSON body', async () => {
    const fetchMock = vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>(async () => makeResponse({ body: { ok: true } }));
    const c = createApiClient({ baseURL: 'https://api.example.com/', fetch: fetchMock });
    const out = await c.request('get', '/projects' as never, {
      params: { query: { limit: 5 } } as never,
    });
    expect(out).toEqual({ ok: true });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const call = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(call[0]).toBe('https://api.example.com/projects?limit=5');
    expect(call[1].method).toBe('GET');
    expect((call[1].headers as Record<string, string>).Accept).toBe('application/json');
  });

  it('POST: sets Content-Type and serializes body', async () => {
    const fetchMock = vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>(async () => makeResponse({ status: 201, body: { id: 'p1' } }));
    const c = createApiClient({ baseURL: 'https://api.example.com', fetch: fetchMock });
    const out = await c.request('post', '/projects' as never, { body: { name: 'X' } as never });
    expect(out).toEqual({ id: 'p1' });
    const init = fetchMock.mock.calls[0]![1] as RequestInit;
    expect(init.method).toBe('POST');
    expect((init.headers as Record<string, string>)['Content-Type']).toBe('application/json');
    expect(init.body).toBe(JSON.stringify({ name: 'X' }));
  });

  it('attaches Authorization when getToken returns a string', async () => {
    const fetchMock = vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>(async () => makeResponse({ body: {} }));
    const c = createApiClient({
      baseURL: 'https://api.example.com',
      fetch: fetchMock,
      getToken: async () => 'tok-1',
    });
    await c.request('get', '/projects' as never);
    const init = fetchMock.mock.calls[0]![1] as RequestInit;
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer tok-1');
  });

  it('omits Authorization when getToken returns null', async () => {
    const fetchMock = vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>(async () => makeResponse({ body: {} }));
    const c = createApiClient({
      baseURL: 'https://api.example.com',
      fetch: fetchMock,
      getToken: () => null,
    });
    await c.request('get', '/projects' as never);
    const init = fetchMock.mock.calls[0]![1] as RequestInit;
    expect((init.headers as Record<string, string>).Authorization).toBeUndefined();
  });

  it('204 returns undefined without body parsing', async () => {
    const fetchMock = vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>(async () => makeResponse({ status: 204, contentType: null }));
    const c = createApiClient({ baseURL: 'https://api.example.com', fetch: fetchMock });
    const out = await c.request('delete', '/projects/{project_id}' as never, {
      params: { path: { project_id: 'p1' } } as never,
    });
    expect(out).toBeUndefined();
  });

  it('non-2xx throws ApiError with structural fields and JSON payload', async () => {
    const fetchMock = vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>(async () => makeResponse({ status: 403, body: { detail: 'forbidden' } }));
    const c = createApiClient({ baseURL: 'https://api.example.com', fetch: fetchMock });
    await expect(
      c.request('get', '/client/projects/{project_id}' as never, {
        params: { path: { project_id: 'p1' } } as never,
      }),
    ).rejects.toMatchObject({
      name: 'ApiError',
      status: 403,
      payload: { detail: 'forbidden' },
      method: 'get',
      path: '/client/projects/{project_id}',
    });
  });

  it('passes AbortSignal through to fetch', async () => {
    const ctrl = new AbortController();
    const fetchMock = vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>(async () => makeResponse({ body: {} }));
    const c = createApiClient({ baseURL: 'https://api.example.com', fetch: fetchMock });
    await c.request('get', '/projects' as never, { signal: ctrl.signal });
    const init = fetchMock.mock.calls[0]![1] as RequestInit;
    expect(init.signal).toBe(ctrl.signal);
  });

  it('helper shortcuts (get/post/put/patch/delete) wire to request()', async () => {
    const fetchMock = vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>(async () => makeResponse({ body: { ok: 1 } }));
    const c = createApiClient({ baseURL: 'https://api.example.com', fetch: fetchMock });
    await c.get('/projects' as never);
    await c.post('/projects' as never, { body: {} as never });
    await c.put('/projects' as never, { body: {} as never });
    await c.patch('/projects' as never, { body: {} as never });
    await c.delete('/projects/{project_id}' as never, {
      params: { path: { project_id: 'p1' } } as never,
    });
    const methods = fetchMock.mock.calls.map((cc) => (cc[1] as unknown as RequestInit).method);
    expect(methods).toEqual(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']);
  });
});

describe('ApiError', () => {
  it('exposes status / payload / path / method on instances', () => {
    const e = new ApiError({
      status: 401,
      statusText: 'Unauthorized',
      payload: { detail: 'no' },
      path: '/projects',
      method: 'get',
    });
    expect(e.status).toBe(401);
    expect(e.payload).toEqual({ detail: 'no' });
    expect(e.path).toBe('/projects');
    expect(e.method).toBe('get');
    expect(e.message).toContain('GET /projects -> 401');
  });
});
