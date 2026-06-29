/**
 * T-UC-04 — S-B02 プロジェクトダッシュボード 配線テスト
 *
 * fake client を注入し real API を叩かずに検証する:
 *   - GET /projects/{id}/dashboard の task_counts を KPI タイルへマップ
 *   - GET /projects/{id} の name をヘッダに使う
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
import { ProjectDashboardContainer } from "../../app/projects/s_b02/_components/ProjectDashboardContainer";

function renderWithQuery(ui: React.ReactElement) {
  const qc = createQueryClient();
  return render(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>);
}

function apiError(status: number): ApiError {
  return new ApiError({
    status,
    statusText: "x",
    payload: undefined,
    path: "/p",
    method: "get",
  });
}

function fakeClient(get: unknown): ApiClient {
  const noop = vi.fn(async () => ({ data: {} }));
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

describe("S-B02 ProjectDashboardContainer (T-UC-04)", () => {
  it("maps task_counts to KPI tiles and shows the project name", async () => {
    const get = vi.fn(async (path: string) =>
      path.includes("dashboard")
        ? {
            data: {
              task_counts: {
                total: 10,
                in_progress: 3,
                awaiting: 2,
                done: 5,
                blocked: 1,
              },
            },
          }
        : { data: { name: "受託案件A" } },
    );
    renderWithQuery(
      <ProjectDashboardContainer projectId="p1" client={fakeClient(get)} />,
    );

    expect(await screen.findByText("受託案件A")).toBeInTheDocument();
    const kpis = screen.getByRole("region", { name: "KPI 一覧" });
    expect(kpis).toHaveTextContent("総タスク");
    expect(kpis).toHaveTextContent("10");
    expect(kpis).toHaveTextContent("完了");
    expect(kpis).toHaveTextContent("5");
    expect(kpis).toHaveTextContent("ブロック");
  });

  it("shows a forbidden message on 403", async () => {
    const get = vi.fn(async () => {
      throw apiError(403);
    });
    renderWithQuery(
      <ProjectDashboardContainer projectId="p1" client={fakeClient(get)} />,
    );
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "権限がありません",
    );
  });
});
