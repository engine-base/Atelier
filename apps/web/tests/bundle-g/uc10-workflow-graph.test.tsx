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
import { render, screen } from "@testing-library/react";
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
    expect(screen.getByText("設計")).toBeInTheDocument();
    // completed → UI「完了」, 依存エッジ「要件定義 → 設計」
    expect(screen.getByText("完了")).toBeInTheDocument();
    const deps = screen.getByLabelText("依存関係");
    expect(deps).toHaveTextContent("要件定義 → 設計");
  });

  it("shows an empty message when there are no phases", async () => {
    const get = vi.fn(async () => ({ data: [] }));
    renderWithQuery(
      <WorkflowGraphContainer projectId="prj1" client={fakeClient(get)} />,
    );
    expect(
      await screen.findByText("工程がまだ登録されていません。"),
    ).toBeInTheDocument();
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
