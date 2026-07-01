/**
 * T-UC-39 — プロジェクト切替 配線テスト
 *
 *   - GET /projects（現在 WS で絞り込み）を一覧化し先頭を初期選択
 *   - localStorage 保存済みプロジェクトを尊重
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
import { ProjectSwitcherContainer } from "../../app/t-uc-39/_components/ProjectSwitcherContainer";

function renderWithQuery(ui: React.ReactElement) {
  const qc = createQueryClient();
  return render(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>);
}

function apiError(status: number): ApiError {
  return new ApiError({
    status,
    statusText: "x",
    payload: undefined,
    path: "/projects",
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

const PROJECTS = [
  { id: "p1", name: "Alpha 案件" },
  { id: "p2", name: "Beta 案件" },
];

afterEach(() => {
  vi.clearAllMocks();
  window.localStorage.clear();
});

describe("T-UC-39 ProjectSwitcherContainer", () => {
  it("lists projects filtered by current workspace and selects the first", async () => {
    window.localStorage.setItem("atelier_current_workspace", "w1");
    const get = vi.fn(async () => ({ data: PROJECTS }));
    renderWithQuery(<ProjectSwitcherContainer client={fakeClient(get)} />);
    expect((await screen.findAllByText("Alpha 案件")).length).toBeGreaterThan(
      0,
    );
    // workspace_id クエリが渡る
    const init = (
      get.mock.calls[0] as unknown as [
        string,
        { params: { query: { workspace_id?: string } } },
      ]
    )[1];
    expect(init.params.query.workspace_id).toBe("w1");
  });

  it("honors the project saved in localStorage", async () => {
    window.localStorage.setItem("atelier_current_project", "p2");
    const get = vi.fn(async () => ({ data: PROJECTS }));
    renderWithQuery(<ProjectSwitcherContainer client={fakeClient(get)} />);
    expect((await screen.findAllByText("Beta 案件")).length).toBeGreaterThan(0);
  });

  it("shows a forbidden message on 403", async () => {
    const get = vi.fn(async () => {
      throw apiError(403);
    });
    renderWithQuery(<ProjectSwitcherContainer client={fakeClient(get)} />);
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "権限がありません",
    );
  });
});
