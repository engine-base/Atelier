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
import { render, screen } from "@testing-library/react";
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
