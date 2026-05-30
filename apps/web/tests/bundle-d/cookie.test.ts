/**
 * T-US-03 cookie helpers tests
 */

import { describe, expect, it } from 'vitest';

import {
  ACCESS_TTL_S,
  COOKIE_NAMES,
  REFRESH_TTL_S,
  decodeJwtUnsafe,
  defaultAttrs,
  defaultTtl,
  isExpired,
  parseCookieHeader,
  serializeCookie,
} from '../../lib/auth/cookie';

describe('COOKIE_NAMES constants', () => {
  it('includes access / refresh / csrf / clientAccess', () => {
    expect(COOKIE_NAMES.access).toBe('atelier_access');
    expect(COOKIE_NAMES.refresh).toBe('atelier_refresh');
    expect(COOKIE_NAMES.csrf).toBe('atelier_csrf');
    expect(COOKIE_NAMES.clientAccess).toBe('atelier_client_access');
  });
});

describe('defaultAttrs / defaultTtl', () => {
  it('HttpOnly+Secure+SameSite=lax with given maxAge', () => {
    const a = defaultAttrs(120);
    expect(a).toEqual({ maxAge: 120, httpOnly: true, secure: true, sameSite: 'lax', path: '/' });
  });
  it('CSRF cookie can opt out of HttpOnly', () => {
    expect(defaultAttrs(60, false).httpOnly).toBe(false);
  });
  it('defaultTtl returns access/refresh seconds', () => {
    expect(defaultTtl(COOKIE_NAMES.access)).toBe(ACCESS_TTL_S);
    expect(defaultTtl(COOKIE_NAMES.refresh)).toBe(REFRESH_TTL_S);
    expect(defaultTtl(COOKIE_NAMES.csrf)).toBe(ACCESS_TTL_S);
    expect(defaultTtl(COOKIE_NAMES.clientAccess)).toBe(ACCESS_TTL_S);
  });
});

describe('serializeCookie', () => {
  it('builds Set-Cookie with attributes', () => {
    const s = serializeCookie('atelier_access', 'tok', defaultAttrs(60));
    expect(s).toMatch(/^atelier_access=tok/);
    expect(s).toContain('Max-Age=60');
    expect(s).toContain('Path=/');
    expect(s).toContain('SameSite=Lax');
    expect(s).toContain('Secure');
    expect(s).toContain('HttpOnly');
  });
  it('URL-encodes the value', () => {
    expect(serializeCookie('k', 'a b', defaultAttrs(1))).toMatch(/k=a%20b/);
  });
});

describe('parseCookieHeader', () => {
  it('parses standard Cookie header', () => {
    expect(parseCookieHeader('a=1; b=2 ; c=hello%20world')).toEqual({ a: '1', b: '2', c: 'hello world' });
  });
  it('returns empty object for null/undefined', () => {
    expect(parseCookieHeader(null)).toEqual({});
    expect(parseCookieHeader(undefined)).toEqual({});
  });
});

describe('decodeJwtUnsafe + isExpired', () => {
  function jwt(payload: object): string {
    const enc = (o: object) =>
      Buffer.from(JSON.stringify(o)).toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
    return `${enc({ alg: 'HS256' })}.${enc(payload)}.sig`;
  }

  it('decodes a base64url-encoded JWT payload', () => {
    const token = jwt({ sub: 'user1', exp: 9999999999, role: 'authenticated' });
    expect(decodeJwtUnsafe(token)?.sub).toBe('user1');
    expect(decodeJwtUnsafe(token)?.role).toBe('authenticated');
  });
  it('returns null for malformed JWT', () => {
    expect(decodeJwtUnsafe('not.a.jwt')).toBeNull();
    expect(decodeJwtUnsafe('only.two')).toBeNull();
  });
  it('isExpired returns true for null payload', () => {
    expect(isExpired(null)).toBe(true);
  });
  it('isExpired respects 5s skew', () => {
    const now = 1_000_000;
    expect(isExpired({ sub: 's', exp: now + 10 }, now)).toBe(false);
    expect(isExpired({ sub: 's', exp: now + 4 }, now)).toBe(true);
  });
});
