/**
 * @atelier/api-client — T-US-04: 型安全 API クライアント
 *
 * openapi-typescript が `packages/api-types/src/openapi.ts` に emit する `paths` 型を
 * 直接消費し、URL / method / request body / response body を**コンパイル時に**型検証する。
 * 信頼源: 07_api_design/openapi.yaml。drift は CI Gate #7 で別途担保。
 *
 * 設計原則:
 *   - fetch wrapper のみ (axios 等不採用 — selected-stack 準拠)
 *   - bearer token は呼び出し側が getToken で注入 (cookie/header どちらでも)
 *   - 4xx/5xx は ApiError として throw、レスポンスボディは error.payload に保持
 *   - URL path 置換 (`{project_id}` → 実値) は型安全に行う
 *   - AbortSignal 対応 (TanStack Query との連携前提)
 *   - R-T08: client_portal endpoint も同 client を再利用可能 (token を差し替えるだけ)
 */

import type { paths } from '@atelier/api-types';

export type Paths = paths;

/** HTTP method 列挙 (openapi-typescript の paths key と整合) */
export type HttpMethod = 'get' | 'post' | 'put' | 'patch' | 'delete' | 'head' | 'options';

/** path に対して定義されている method のみを許容 */
export type PathsWithMethod<M extends HttpMethod> = {
  [P in keyof Paths]: Paths[P] extends { [K in M]: unknown } ? P : never;
}[keyof Paths];

/** 指定 path/method の operation オブジェクト */
type Operation<P extends keyof Paths, M extends HttpMethod> = Paths[P] extends {
  [K in M]: infer O;
}
  ? O
  : never;

/** 指定 operation の request body (JSON) */
type RequestBody<P extends keyof Paths, M extends HttpMethod> =
  Operation<P, M> extends {
    requestBody?: { content: { 'application/json': infer B } };
  }
    ? B
    : undefined;

/** 指定 operation の path/query parameters */
type Params<P extends keyof Paths, M extends HttpMethod> =
  Operation<P, M> extends { parameters: infer Pp } ? Pp : Record<string, never>;

/** 指定 operation の 2xx success response body (JSON) */
type SuccessResponse<P extends keyof Paths, M extends HttpMethod> =
  Operation<P, M> extends {
    responses: infer R;
  }
    ? R extends {
        [K in 200 | 201 | 202 | 204]?: { content?: { 'application/json'?: infer B } };
      }
      ? NonNullable<R[Extract<keyof R, 200 | 201 | 202 | 204>]> extends {
          content?: { 'application/json'?: infer B2 };
        }
        ? B2
        : never
      : never
    : never;

/** Atelier API の構造的エラー */
export class ApiError<Body = unknown> extends Error {
  readonly status: number;
  readonly statusText: string;
  readonly payload: Body | undefined;
  readonly path: string;
  readonly method: HttpMethod;

  constructor(args: {
    status: number;
    statusText: string;
    payload: Body | undefined;
    path: string;
    method: HttpMethod;
  }) {
    super(`Atelier API ${args.method.toUpperCase()} ${args.path} -> ${args.status} ${args.statusText}`);
    this.name = 'ApiError';
    this.status = args.status;
    this.statusText = args.statusText;
    this.payload = args.payload;
    this.path = args.path;
    this.method = args.method;
  }
}

/** ApiClient のオプション */
export interface ApiClientOptions {
  /** baseURL — 末尾 / は不要 (例: `https://api.atelier.example`) */
  baseURL: string;
  /** access token を取得する関数。null/undefined を返した場合は Authorization を付けない */
  getToken?: () => string | null | undefined | Promise<string | null | undefined>;
  /** すべてのリクエストに付ける追加 header */
  defaultHeaders?: Record<string, string>;
  /** 内部 fetch (テストで差し替え用) */
  fetch?: typeof fetch;
}

/** リクエスト時のオプション */
export interface RequestInit_<P extends keyof Paths, M extends HttpMethod> {
  /** path/query parameters (openapi 由来) */
  params?: Params<P, M>;
  /** request body */
  body?: RequestBody<P, M>;
  /** AbortSignal (TanStack Query の signal を渡す想定) */
  signal?: AbortSignal;
  /** call-site の追加 header */
  headers?: Record<string, string>;
}

/** URL path 中の `{name}` placeholder を実値で置換する */
function fillPath(template: string, pathParams: Record<string, string | number> | undefined): string {
  if (!pathParams) return template;
  return template.replace(/\{([^}]+)\}/g, (_, key: string) => {
    const v = pathParams[key];
    if (v === undefined || v === null) {
      throw new Error(`api-client: path parameter "${key}" missing for "${template}"`);
    }
    return encodeURIComponent(String(v));
  });
}

/** query parameters object を URLSearchParams string に変換 */
function buildQuery(query: Record<string, unknown> | undefined): string {
  if (!query) return '';
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(query)) {
    if (v === undefined || v === null) continue;
    if (Array.isArray(v)) {
      for (const item of v) sp.append(k, String(item));
    } else {
      sp.append(k, String(v));
    }
  }
  const s = sp.toString();
  return s ? `?${s}` : '';
}

/** 型安全 fetch wrapper を生成する */
export function createApiClient(opts: ApiClientOptions) {
  const fetchImpl = opts.fetch ?? globalThis.fetch;

  async function request<P extends keyof Paths, M extends HttpMethod>(
    method: M,
    path: P,
    init: RequestInit_<P, M> = {},
  ): Promise<SuccessResponse<P, M>> {
    const paramsObj = (init.params ?? {}) as {
      path?: Record<string, string | number>;
      query?: Record<string, unknown>;
    };
    const filled = fillPath(path as string, paramsObj.path);
    const qs = buildQuery(paramsObj.query);
    const url = `${opts.baseURL.replace(/\/$/, '')}${filled}${qs}`;

    const headers: Record<string, string> = {
      Accept: 'application/json',
      ...opts.defaultHeaders,
      ...init.headers,
    };
    if (init.body !== undefined) {
      headers['Content-Type'] = 'application/json';
    }
    if (opts.getToken) {
      const tok = await opts.getToken();
      if (tok) headers.Authorization = `Bearer ${tok}`;
    }

    const res = await fetchImpl(url, {
      method: method.toUpperCase(),
      headers,
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
      signal: init.signal,
      credentials: 'include',
    });

    if (res.status === 204) {
      return undefined as SuccessResponse<P, M>;
    }

    const ct = res.headers.get('content-type') ?? '';
    const isJson = ct.includes('application/json');
    const payload: unknown = isJson ? await res.json().catch(() => undefined) : await res.text();

    if (!res.ok) {
      throw new ApiError({
        status: res.status,
        statusText: res.statusText,
        payload: payload as unknown,
        path: path as string,
        method,
      });
    }

    return payload as SuccessResponse<P, M>;
  }

  return {
    get: <P extends PathsWithMethod<'get'>>(path: P, init?: RequestInit_<P, 'get'>) =>
      request('get', path, init),
    post: <P extends PathsWithMethod<'post'>>(path: P, init?: RequestInit_<P, 'post'>) =>
      request('post', path, init),
    put: <P extends PathsWithMethod<'put'>>(path: P, init?: RequestInit_<P, 'put'>) =>
      request('put', path, init),
    patch: <P extends PathsWithMethod<'patch'>>(path: P, init?: RequestInit_<P, 'patch'>) =>
      request('patch', path, init),
    delete: <P extends PathsWithMethod<'delete'>>(path: P, init?: RequestInit_<P, 'delete'>) =>
      request('delete', path, init),
    /** raw request — escape hatch (型は緩む) */
    request,
  };
}

export type ApiClient = ReturnType<typeof createApiClient>;

/** テストヘルパ: path placeholder fill / query 構築を公開 (Vitest 用) */
export const _internal = { fillPath, buildQuery };
