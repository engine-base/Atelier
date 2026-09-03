/**
 * GAP-261 (通し J10-03) — JWT を JS から読めない場所に移した分の回帰。
 *
 * 以前は `document.cookie` に書いていたので、XSS が 1 つでもあればそのまま
 * 盗まれた。いまは web オリジンの route handler が HttpOnly cookie として
 * 保存し、ブラウザはメモリの控えだけを Authorization に使う。
 */

// @vitest-environment node

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const store = new Map<string, { value: string; opts: Record<string, unknown> }>();

vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) => {
      const hit = store.get(name);
      return hit ? { name, value: hit.value } : undefined;
    },
    set: (name: string, value: string, opts: Record<string, unknown>) => {
      store.set(name, { value, opts });
    },
  }),
}));

beforeEach(() => store.clear());
afterEach(() => vi.clearAllMocks());

async function post(body: unknown) {
  const { POST } = await import("../../app/api/session/route");
  return await POST(new Request("http://localhost/api/session", {
    method: "POST",
    body: JSON.stringify(body),
  }));
}

describe("POST /api/session (GAP-261)", () => {
  it("HttpOnly + SameSite=Lax でトークンを保存する (JS からは読めない)", async () => {
    const res = await post({
      access_token: "aaa.bbb.ccc",
      expires_at: "2999-01-01T00:00:00Z",
    });
    expect(res.status).toBe(200);
    const saved = store.get("atelier_access");
    expect(saved?.value).toBe("aaa.bbb.ccc");
    expect(saved?.opts.httpOnly).toBe(true);
    expect(saved?.opts.sameSite).toBe("lax");
    expect(saved?.opts.path).toBe("/");
    expect(saved?.opts.expires).toBeInstanceOf(Date);
  });

  it("JWT の形をしていない値は保存しない (何でも入る箱にしない)", async () => {
    for (const bad of ["", "not-a-jwt", "a.b", "x".repeat(5000)]) {
      const res = await post({ access_token: bad, expires_at: "2999-01-01T00:00:00Z" });
      expect(res.status).toBe(400);
    }
    expect(store.has("atelier_access")).toBe(false);
  });

  it("期限が壊れていても保存はする (セッション cookie として扱う)", async () => {
    const res = await post({ access_token: "aaa.bbb.ccc", expires_at: "壊れた値" });
    expect(res.status).toBe(200);
    expect(store.get("atelier_access")?.opts.expires).toBeUndefined();
  });

  it("DELETE で確実に消える (HttpOnly は JS からは消せない)", async () => {
    await post({ access_token: "aaa.bbb.ccc", expires_at: "2999-01-01T00:00:00Z" });
    const { DELETE } = await import("../../app/api/session/route");
    const res = await DELETE();
    expect(res.status).toBe(200);
    const cleared = store.get("atelier_access");
    expect(cleared?.value).toBe("");
    expect((cleared?.opts.expires as Date).getTime()).toBe(0);
  });
});

describe("GET /api/session/token (GAP-261)", () => {
  it("同一オリジンの JS にだけ渡し、保存させない", async () => {
    store.set("atelier_access", { value: "aaa.bbb.ccc", opts: {} });
    const { GET } = await import("../../app/api/session/token/route");
    const res = await GET();
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    const json = (await res.json()) as { data: { access_token: string | null } };
    expect(json.data.access_token).toBe("aaa.bbb.ccc");
  });

  it("サインインしていなければ null (偽のトークンを作らない)", async () => {
    const { GET } = await import("../../app/api/session/token/route");
    const json = (await (await GET()).json()) as { data: { access_token: string | null } };
    expect(json.data.access_token).toBeNull();
  });
});
