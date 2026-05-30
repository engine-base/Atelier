/**
 * Cookie 管理 — T-US-03 (認証フロー配管)
 *
 * Atelier の Web は以下を Cookie で保持する:
 *   - atelier_access:   short-lived JWT (HttpOnly, Secure, SameSite=Lax, 1h)
 *   - atelier_refresh:  long-lived refresh token (HttpOnly, Secure, SameSite=Lax, 30d)
 *   - atelier_csrf:     CSRF token (NOT HttpOnly、JS で読んで header に echo)
 *
 * 本ファイルは Next.js 15 Server Components / Route Handler / middleware で共通利用
 * できるよう、`cookies()` (next/headers) と native parser 両方をサポートする。
 *
 * R-T08 互換: client_portal JWT 用に別 cookie 名 (atelier_client_access) も提供。
 */

import { z } from 'zod';

export const COOKIE_NAMES = {
  access: 'atelier_access',
  refresh: 'atelier_refresh',
  csrf: 'atelier_csrf',
  clientAccess: 'atelier_client_access',
} as const;

export type CookieName = (typeof COOKIE_NAMES)[keyof typeof COOKIE_NAMES];

/** 1 hour in seconds */
export const ACCESS_TTL_S = 60 * 60;
/** 30 days in seconds */
export const REFRESH_TTL_S = 60 * 60 * 24 * 30;

export interface CookieAttributes {
  readonly maxAge: number;
  readonly httpOnly: boolean;
  readonly secure: boolean;
  readonly sameSite: 'lax' | 'strict' | 'none';
  readonly path: string;
}

/** Atelier 既定の cookie 属性 (HttpOnly + Secure + SameSite=Lax) */
export function defaultAttrs(maxAge: number, httpOnly = true): CookieAttributes {
  return { maxAge, httpOnly, secure: true, sameSite: 'lax', path: '/' };
}

/** Cookie 名から既定 TTL を引く */
export function defaultTtl(name: CookieName): number {
  switch (name) {
    case COOKIE_NAMES.access:
    case COOKIE_NAMES.clientAccess:
      return ACCESS_TTL_S;
    case COOKIE_NAMES.refresh:
      return REFRESH_TTL_S;
    case COOKIE_NAMES.csrf:
      return ACCESS_TTL_S;
  }
}

/** `Set-Cookie` ヘッダ文字列を構築 (route handler から直接返したい場合用) */
export function serializeCookie(
  name: string,
  value: string,
  attrs: CookieAttributes,
): string {
  const parts = [`${name}=${encodeURIComponent(value)}`];
  parts.push(`Max-Age=${attrs.maxAge}`);
  parts.push(`Path=${attrs.path}`);
  parts.push(`SameSite=${attrs.sameSite[0]!.toUpperCase() + attrs.sameSite.slice(1)}`);
  if (attrs.secure) parts.push('Secure');
  if (attrs.httpOnly) parts.push('HttpOnly');
  return parts.join('; ');
}

/** `Cookie` ヘッダ文字列をパース */
export function parseCookieHeader(header: string | null | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const pair of header.split(';')) {
    const eq = pair.indexOf('=');
    if (eq === -1) continue;
    const k = pair.slice(0, eq).trim();
    const v = pair.slice(eq + 1).trim();
    if (k) out[k] = decodeURIComponent(v);
  }
  return out;
}

const JwtPayloadSchema = z.object({
  sub: z.string(),
  exp: z.number().int(),
  role: z.string().optional(),
  project_id: z.string().optional(),
});
export type JwtPayload = z.infer<typeof JwtPayloadSchema>;

/** JWT を **検証なしで** decode (UI で exp を見るためだけ。検証は API 側) */
export function decodeJwtUnsafe(token: string): JwtPayload | null {
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  try {
    const payload = parts[1]!;
    const padded = payload + '='.repeat((4 - (payload.length % 4)) % 4);
    const b64 = padded.replace(/-/g, '+').replace(/_/g, '/');
    const json = typeof atob === 'function' ? atob(b64) : Buffer.from(b64, 'base64').toString('utf-8');
    const obj = JSON.parse(json);
    return JwtPayloadSchema.parse(obj);
  } catch {
    return null;
  }
}

/** access token が exp を過ぎているか (UNIX seconds、許容 5s skew) */
export function isExpired(payload: JwtPayload | null, nowSec = Math.floor(Date.now() / 1000)): boolean {
  if (!payload) return true;
  return payload.exp - 5 <= nowSec;
}
