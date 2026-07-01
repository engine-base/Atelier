/**
 * T-UC-36 — 通知センター 配線テスト
 *
 *   - GET /approval-inbox を通知として一覧表示、未読数を表示
 *   - 既読ボタンで localStorage 管理の read 状態が更新される
 *   - 未読フィルタ / 403 拒否
 */

// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";

import * as React from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";
import { ApiError, type ApiClient } from "@atelier/api-client";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createQueryClient } from "../../lib/query-client";
import { NotificationsContainer } from "../../app/t-uc-36/_components/NotificationsContainer";

function renderWithQuery(ui: React.ReactElement) {
  const qc = createQueryClient();
  return render(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>);
}

function apiError(status: number): ApiError {
  return new ApiError({
    status,
    statusText: "x",
    payload: undefined,
    path: "/approval-inbox",
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

const INBOX = [
  {
    id: "a1",
    title: "昇格レビュー承認待ち",
    created_at: "2026-06-20T10:00:00Z",
  },
  { id: "a2", title: "API 契約凍結承認", created_at: "2026-06-20T11:00:00Z" },
];

afterEach(() => {
  vi.clearAllMocks();
  window.localStorage.clear();
});

describe("T-UC-36 NotificationsContainer", () => {
  it("lists approval-inbox items as notifications with an unread count", async () => {
    const get = vi.fn(async () => ({ data: INBOX }));
    renderWithQuery(<NotificationsContainer client={fakeClient(get)} />);
    expect(await screen.findByText("昇格レビュー承認待ち")).toBeInTheDocument();
    expect(screen.getByLabelText("未読 2 件")).toBeInTheDocument();
  });

  it("marks a notification read (persisted to localStorage)", async () => {
    const get = vi.fn(async () => ({ data: INBOX }));
    renderWithQuery(<NotificationsContainer client={fakeClient(get)} />);
    fireEvent.click(
      await screen.findByRole("button", {
        name: "昇格レビュー承認待ち を既読にする",
      }),
    );
    // 未読が 1 に減る + localStorage に記録
    await waitFor(() =>
      expect(screen.getByLabelText("未読 1 件")).toBeInTheDocument(),
    );
    expect(
      JSON.parse(
        window.localStorage.getItem("atelier_read_notifications") ?? "[]",
      ),
    ).toContain("a1");
  });

  it("honors localStorage-read items and the unread filter", async () => {
    window.localStorage.setItem(
      "atelier_read_notifications",
      JSON.stringify(["a1"]),
    );
    const get = vi.fn(async () => ({ data: INBOX }));
    renderWithQuery(<NotificationsContainer client={fakeClient(get)} />);
    await screen.findByText("API 契約凍結承認");
    fireEvent.click(screen.getByRole("tab", { name: "未読のみ" }));
    // a1 は既読なので未読フィルタで消える
    expect(screen.queryByText("昇格レビュー承認待ち")).toBeNull();
    expect(screen.getByText("API 契約凍結承認")).toBeInTheDocument();
  });

  it("shows a forbidden message on 403", async () => {
    const get = vi.fn(async () => {
      throw apiError(403);
    });
    renderWithQuery(<NotificationsContainer client={fakeClient(get)} />);
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "権限がありません",
    );
  });
});
