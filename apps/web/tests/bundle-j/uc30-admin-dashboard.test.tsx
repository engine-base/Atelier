/**
 * T-UC-30 — S-T01 運営ダッシュボード 配線テスト
 *
 * fake client を注入し real API を叩かずに検証する:
 *   - GET /admin/dashboard の集計を KPI へ
 *   - GET /admin/audit-logs の直近を最近のアクティビティへ
 *   - 403（admin 専用）
 */

// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";

import * as React from "react";
import { render, screen, within } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";
import { ApiError, type ApiClient } from "@atelier/api-client";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createQueryClient } from "../../lib/query-client";
import { AdminDashboardContainer } from "../../app/admin/s_t01/_components/AdminDashboardContainer";

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

describe("S-T01 AdminDashboardContainer (T-UC-30)", () => {
  it("maps dashboard counts to KPIs and audit logs to recent activity", async () => {
    const get = vi.fn(async (path: string) =>
      path.includes("dashboard")
        ? {
            data: {
              workspace_count: 42,
              project_count: 108,
              ai_employee_count: 7,
            },
          }
        : {
            data: [
              {
                id: "a1",
                action: "project.create",
                actor_id: "tony",
                created_at: "2026-06-20T05:00:00Z",
              },
            ],
          },
    );
    renderWithQuery(<AdminDashboardContainer client={fakeClient(get)} />);

    const kpi = await screen.findByRole("region", { name: "KPI" });
    expect(within(kpi).getByText("ワークスペース数")).toBeInTheDocument();
    expect(within(kpi).getByText("42")).toBeInTheDocument();
    expect(within(kpi).getByText("AI 社員数")).toBeInTheDocument();

    const recent = screen.getByRole("region", { name: "最近のアクティビティ" });
    expect(within(recent).getByText("project.create")).toBeInTheDocument();
  });

  it("shows a forbidden message on 403", async () => {
    const get = vi.fn(async () => {
      throw apiError(403);
    });
    renderWithQuery(<AdminDashboardContainer client={fakeClient(get)} />);
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "運営 admin 専用",
    );
  });
});
