/**
 * T-UC-38 — ワークスペース切替 配線テスト
 *
 *   - GET /workspaces を一覧化し先頭を初期選択
 *   - localStorage に保存済みの WS を初期選択として尊重
 *   - 403 拒否
 */

// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";

import * as React from "react";
import { render, screen } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";
import { ApiError, type ApiClient } from "@atelier/api-client";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createQueryClient } from "../../lib/query-client";
import { WorkspaceSwitcherContainer } from "../../app/t-uc-38/_components/WorkspaceSwitcherContainer";

function renderWithQuery(ui: React.ReactElement) {
  const qc = createQueryClient();
  return render(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>);
}

function apiError(status: number): ApiError {
  return new ApiError({
    status,
    statusText: "x",
    payload: undefined,
    path: "/workspaces",
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

const WS = [
  { id: "w1", name: "Alpha 社" },
  { id: "w2", name: "Beta 社" },
];

afterEach(() => {
  vi.clearAllMocks();
  window.localStorage.clear();
});

describe("T-UC-38 WorkspaceSwitcherContainer", () => {
  it("lists workspaces and selects the first by default", async () => {
    const get = vi.fn(async () => ({ data: WS }));
    renderWithQuery(<WorkspaceSwitcherContainer client={fakeClient(get)} />);
    // 先頭 WS が現在選択として表示される（picker ボタン + 現在ラベルで複数出現しうる）。
    expect((await screen.findAllByText("Alpha 社")).length).toBeGreaterThan(0);
  });

  it("honors the workspace saved in localStorage", async () => {
    window.localStorage.setItem("atelier_current_workspace", "w2");
    const get = vi.fn(async () => ({ data: WS }));
    renderWithQuery(<WorkspaceSwitcherContainer client={fakeClient(get)} />);
    // 現在表示が Beta 社（保存済み）になる
    expect((await screen.findAllByText("Beta 社")).length).toBeGreaterThan(0);
  });

  it("shows a forbidden message on 403", async () => {
    const get = vi.fn(async () => {
      throw apiError(403);
    });
    renderWithQuery(<WorkspaceSwitcherContainer client={fakeClient(get)} />);
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "権限がありません",
    );
  });
});
