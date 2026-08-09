/**
 * T-UC-33 — S-T04 ユーザー管理 配線テスト
 *
 * fake client を注入し real API を叩かずに検証する:
 *   - GET /admin/users の一覧描画（read-only: 停止/復元なし）
 *   - 空状態 / 403
 */

// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";

import * as React from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";
import { ApiError, type ApiClient } from "@atelier/api-client";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createQueryClient } from "../../lib/query-client";
import { UserAdminContainer } from "../../app/admin/s_t04/_components/UserAdminContainer";

function renderWithQuery(ui: React.ReactElement) {
  const qc = createQueryClient();
  return render(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>);
}

function apiError(status: number): ApiError {
  return new ApiError({
    status,
    statusText: "x",
    payload: undefined,
    path: "/admin",
    method: "get",
  });
}

function fakeClient(get: unknown): ApiClient {
  const noop = vi.fn(async () => ({ data: [] }));
  return {
    get,
    post: noop,
    patch: noop,
    delete: noop,
    put: noop,
    request: noop,
  } as unknown as ApiClient;
}

const USERS = [
  { user_id: "u1", email: "alice@example.com", display_name: "Alice" },
];

afterEach(() => vi.clearAllMocks());

describe("S-T04 UserAdminContainer (T-UC-33)", () => {
  it("renders users read-only (no suspend/restore buttons)", async () => {
    const get = vi.fn(async () => ({ data: USERS }));
    renderWithQuery(<UserAdminContainer client={fakeClient(get)} />);
    expect(await screen.findByText("alice@example.com")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /を停止/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /を復元/ })).toBeNull();
    const [path] = get.mock.calls[0]! as unknown as [string];
    expect(path).toBe("/admin/users");
  });

  it("shows empty state when there are no users", async () => {
    const get = vi.fn(async () => ({ data: [] }));
    renderWithQuery(<UserAdminContainer client={fakeClient(get)} />);
    expect(await screen.findByText("ユーザーがいません")).toBeInTheDocument();
  });

  it("shows a forbidden message on 403", async () => {
    const get = vi.fn(async () => {
      throw apiError(403);
    });
    renderWithQuery(<UserAdminContainer client={fakeClient(get)} />);
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "運営 admin 専用",
    );
  });
});

describe("S-T04 サポート連絡 (GAP-031⑥)", () => {
  function pathClient(post?: unknown): ApiClient {
    const get = vi.fn(async (path: string) =>
      path === "/admin/users"
        ? { data: USERS }
        : path === "/admin/support-contacts"
          ? {
              data: [
                {
                  to_email: "alice@example.com",
                  display_name: "Alice",
                  subject: "課金タイミングについて",
                  created_at: new Date(Date.now() - 2 * 3_600_000).toISOString(),
                },
              ],
            }
          : { data: [] },
    );
    const noop = vi.fn(async () => ({ data: {} }));
    return {
      get,
      post: post ?? noop,
      patch: noop,
      delete: noop,
      put: noop,
      request: noop,
    } as unknown as ApiClient;
  }

  it("sends a support mail via dialog → POST /admin/support-contact → dry-run banner", async () => {
    const post = vi.fn(async (..._args: unknown[]) => ({
      data: { to_email: "alice@example.com", dry_run: true },
    }));
    renderWithQuery(<UserAdminContainer client={pathClient(post)} />);
    fireEvent.click(
      await screen.findByRole("button", {
        name: "alice@example.com へサポート連絡",
      }),
    );
    fireEvent.change(screen.getByLabelText(/件名/), {
      target: { value: "認証エラーの件" },
    });
    fireEvent.change(screen.getByLabelText(/本文/), {
      target: { value: "状況を伺えますか。" },
    });
    fireEvent.click(screen.getByRole("button", { name: "送信する" }));
    await waitFor(() => expect(post).toHaveBeenCalledTimes(1));
    expect(post.mock.calls[0]![0]).toBe("/admin/support-contact");
    const init = post.mock.calls[0]![1] as {
      body: { user_id: string; subject: string; message: string };
    };
    expect(init.body.user_id).toBe("u1");
    expect(init.body.subject).toBe("認証エラーの件");
    // dry-run を偽装せず明示
    const banner = await screen.findByRole("status");
    expect(banner).toHaveTextContent("ドライラン");
  });

  it("renders 最近のサポート対応 from GET /admin/support-contacts (実 audit 逆引き)", async () => {
    renderWithQuery(<UserAdminContainer client={pathClient()} />);
    const section = await screen.findByRole("region", {
      name: "最近のサポート対応",
    });
    expect(section).toHaveTextContent("Alice");
    expect(section).toHaveTextContent("課金タイミングについて");
    expect(section).toHaveTextContent("2h");
  });
});
