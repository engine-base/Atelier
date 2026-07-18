/**
 * T-UC-10 — S-F01 工程ワークフロー（司令塔）配線テスト
 *
 * fake client を注入し real API を叩かずに検証する:
 *   - GET /workflow/phases?project_id からノード（状態マップ）と順序エッジを構築
 *   - 403 拒否 / 空状態
 */

// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";

import * as React from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";
import { ApiError, type ApiClient } from "@atelier/api-client";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createQueryClient } from "../../lib/query-client";
import { WorkflowGraphContainer } from "../../app/workflow/s_f01/_components/WorkflowGraphContainer";

function renderWithQuery(ui: React.ReactElement) {
  const qc = createQueryClient();
  return render(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>);
}

function apiError(status: number): ApiError {
  return new ApiError({
    status,
    statusText: "x",
    payload: undefined,
    path: "/workflow",
    method: "get",
  });
}

function fakeClient(
  get: unknown,
  overrides: Partial<Record<"post" | "patch", unknown>> = {},
): ApiClient {
  const noop = vi.fn(async () => ({ data: [] }));
  return {
    get,
    post: overrides.post ?? noop,
    patch: overrides.patch ?? noop,
    delete: noop,
    put: noop,
    request: noop,
  } as unknown as ApiClient;
}

afterEach(() => vi.clearAllMocks());

describe("S-F01 WorkflowGraphContainer (T-UC-10)", () => {
  it("builds nodes (status mapped) and sequential edges from phases", async () => {
    const get = vi.fn(async () => ({
      data: [
        { id: "p1", name: "要件定義", status: "completed", order_index: 1 },
        { id: "p2", name: "設計", status: "in_progress", order_index: 2 },
      ],
    }));
    renderWithQuery(
      <WorkflowGraphContainer projectId="prj1" client={fakeClient(get)} />,
    );

    expect(await screen.findByText("要件定義")).toBeInTheDocument();
    // 設計 = 選択中工程: フローバーのノードと工程ヘッダー h1 の両方に出る
    expect(screen.getAllByText("設計").length).toBeGreaterThanOrEqual(1);
    // completed → UI「完了」, 依存エッジ「要件定義 → 設計」
    expect(screen.getByText("完了")).toBeInTheDocument();
    const deps = screen.getByLabelText("依存関係");
    expect(deps).toHaveTextContent("要件定義 → 設計");
  });

  it("falls back to the canonical 9 phases from current_phase when none are registered", async () => {
    // 工程レコードが無い場合はダッシュボードと同じ canonical 9 工程を current_phase から描く。
    const get = vi.fn(async (path: string) =>
      path.includes("/workflow/phases")
        ? { data: [] }
        : { data: { current_phase: "requirements" } },
    );
    renderWithQuery(
      <WorkflowGraphContainer projectId="prj1" client={fakeClient(get)} />,
    );
    // 9 工程が描画される(先頭ヒアリング・末尾納品)。
    expect(await screen.findByText("ヒアリング")).toBeInTheDocument();
    expect(screen.getByText("納品")).toBeInTheDocument();
    // current=要件定義 が進行中、依存エッジも canonical 順。
    const deps = screen.getByLabelText("依存関係");
    expect(deps).toHaveTextContent("ヒアリング → 要件定義");
  });

  it("seeds canonical phases when empty and 工程を開始する is clicked", async () => {
    const get = vi.fn(async (path: string) =>
      path.includes("/workflow/phases")
        ? { data: [] }
        : { data: { current_phase: "hearing" } },
    );
    const post = vi.fn(async () => ({ data: [] }));
    renderWithQuery(
      <WorkflowGraphContainer
        projectId="prj1"
        client={fakeClient(get, { post })}
      />,
    );
    const btn = await screen.findByRole("button", { name: "工程を開始する" });
    fireEvent.click(btn);
    await waitFor(() => expect(post).toHaveBeenCalledTimes(1));
    expect(post).toHaveBeenCalledWith("/workflow/phases/seed", {
      body: { project_id: "prj1" },
    });
  });

  it("advances the in_progress phase to completed and the next to in_progress", async () => {
    const get = vi.fn(async () => ({
      data: [
        { id: "p1", name: "要件定義", status: "completed", order_index: 1 },
        { id: "p2", name: "設計", status: "in_progress", order_index: 2 },
        { id: "p3", name: "実装", status: "pending", order_index: 3 },
      ],
    }));
    const patch = vi.fn(async () => ({ data: {} }));
    renderWithQuery(
      <WorkflowGraphContainer
        projectId="prj1"
        client={fakeClient(get, { patch })}
      />,
    );
    const btn = await screen.findByRole("button", {
      name: "この工程を完了して次へ",
    });
    fireEvent.click(btn);
    await waitFor(() => expect(patch).toHaveBeenCalledTimes(2));
    expect(patch).toHaveBeenNthCalledWith(1, "/workflow/phases/{phase_id}", {
      params: { path: { phase_id: "p2" } },
      body: { status: "completed" },
    });
    expect(patch).toHaveBeenNthCalledWith(2, "/workflow/phases/{phase_id}", {
      params: { path: { phase_id: "p3" } },
      body: { status: "in_progress" },
    });
  });

  it("shows a forbidden message on 403", async () => {
    const get = vi.fn(async () => {
      throw apiError(403);
    });
    renderWithQuery(
      <WorkflowGraphContainer projectId="prj1" client={fakeClient(get)} />,
    );
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "権限がありません",
    );
  });
});
