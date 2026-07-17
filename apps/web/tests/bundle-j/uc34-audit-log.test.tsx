/**
 * T-UC-34 — S-T05 監査ログ 配線テスト
 *
 * fake client を注入し real API を叩かずに検証する:
 *   - GET /admin/audit-logs の一覧描画
 *   - 空状態 / 403（admin 専用）
 */

// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";

import * as React from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";
import { ApiError, type ApiClient } from "@atelier/api-client";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createQueryClient } from "../../lib/query-client";
import { AuditLogContainer } from "../../app/admin/s_t05/_components/AuditLogContainer";

function renderWithQuery(ui: React.ReactElement) {
  const qc = createQueryClient();
  return render(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>);
}

function apiError(status: number): ApiError {
  return new ApiError({
    status,
    statusText: "x",
    payload: undefined,
    path: "/admin/audit-logs",
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

const LOGS = [
  {
    id: "a1",
    action: "auth.signin",
    actor_type: "user",
    actor_id: "u1",
    target_type: "user",
    target_id: "u1",
    ip_address: "198.51.100.1",
    created_at: "2026-05-30T05:00:00Z",
  },
];

afterEach(() => vi.clearAllMocks());

describe("S-T05 AuditLogContainer (T-UC-34)", () => {
  it("renders audit logs from GET /admin/audit-logs", async () => {
    const get = vi.fn(async () => ({ data: LOGS }));
    renderWithQuery(<AuditLogContainer client={fakeClient(get)} />);
    expect(await screen.findByText("auth.signin")).toBeInTheDocument();
    const [path] = get.mock.calls[0]! as unknown as [string];
    expect(path).toBe("/admin/audit-logs");
  });

  it("shows empty state when there are no logs", async () => {
    const get = vi.fn(async () => ({ data: [] }));
    renderWithQuery(<AuditLogContainer client={fakeClient(get)} />);
    expect(
      await screen.findByText("監査ログがありません。"),
    ).toBeInTheDocument();
  });

  it("filters rows client-side by actor type", async () => {
    const get = vi.fn(async () => ({
      data: [
        LOGS[0],
        {
          id: "a2",
          action: "task.create",
          actor_type: "ai",
          actor_id: "ai:tony",
          target_type: "task",
          target_id: "t1",
          ip_address: null,
          created_at: "2026-05-30T06:00:00Z",
        },
      ],
    }));
    renderWithQuery(<AuditLogContainer client={fakeClient(get)} />);
    // 両方表示 → アクター=AI で user 行が消える。
    expect(await screen.findByText("task.create")).toBeInTheDocument();
    expect(screen.getByText("auth.signin")).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("アクターで絞り込み"), {
      target: { value: "ai" },
    });
    expect(screen.getByText("task.create")).toBeInTheDocument();
    expect(screen.queryByText("auth.signin")).not.toBeInTheDocument();
  });

  it("shows a forbidden message on 403 (admin only)", async () => {
    const get = vi.fn(async () => {
      throw apiError(403);
    });
    renderWithQuery(<AuditLogContainer client={fakeClient(get)} />);
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "運営 admin 専用",
    );
  });
});
