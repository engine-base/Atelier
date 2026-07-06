/**
 * T-UC-06 — S-C01 AI 社員組織図 配線テスト
 *
 * fake client を注入し real API を叩かずに検証する:
 *   - GET /ai-employees を department 別にグルーピング描画
 *   - 社員クリックで onSelect
 *   - 空状態 / 403
 */

// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";

import * as React from "react";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";
import { ApiError, type ApiClient } from "@atelier/api-client";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createQueryClient } from "../../lib/query-client";
import { OrgChartContainer } from "../../app/employees/s_c01/_components/OrgChartContainer";

function renderWithQuery(ui: React.ReactElement) {
  const qc = createQueryClient();
  return render(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>);
}

function apiError(status: number): ApiError {
  return new ApiError({
    status,
    statusText: "x",
    payload: undefined,
    path: "/ai-employees",
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

const EMPLOYEES = [
  { id: "e1", name: "tony", display_name: "トニー", department: "dev_qa" },
  { id: "e2", name: "wanda", display_name: "ワンダ", department: "design" },
];

afterEach(() => vi.clearAllMocks());

describe("S-C01 OrgChartContainer (T-UC-06)", () => {
  it("groups employees by department", async () => {
    const get = vi.fn(async () => ({ data: EMPLOYEES }));
    renderWithQuery(<OrgChartContainer client={fakeClient(get)} />);
    const devqa = await screen.findByRole("article", { name: "開発・QA" });
    expect(within(devqa).getByText("トニー")).toBeInTheDocument();
    expect(
      screen.getByRole("article", { name: "デザイン" }),
    ).toBeInTheDocument();
    const [path] = get.mock.calls[0]! as unknown as [string];
    expect(path).toBe("/ai-employees");
  });

  it("invokes onSelect when a member is clicked", async () => {
    const get = vi.fn(async () => ({ data: EMPLOYEES }));
    const onSelect = vi.fn();
    renderWithQuery(
      <OrgChartContainer client={fakeClient(get)} onSelect={onSelect} />,
    );
    fireEvent.click(
      await screen.findByRole("button", { name: /トニー の詳細/ }),
    );
    // 遷移には実 UUID を渡す (name "tony" を渡すと詳細取得が 404/500 になる実バグがあった)
    expect(onSelect).toHaveBeenCalledWith("e1");
  });

  it("shows empty state when there are no employees", async () => {
    const get = vi.fn(async () => ({ data: [] }));
    renderWithQuery(<OrgChartContainer client={fakeClient(get)} />);
    expect(await screen.findByText("AI 社員がいません。")).toBeInTheDocument();
  });

  it("shows a forbidden message on 403", async () => {
    const get = vi.fn(async () => {
      throw apiError(403);
    });
    renderWithQuery(<OrgChartContainer client={fakeClient(get)} />);
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "権限がありません",
    );
  });
});
