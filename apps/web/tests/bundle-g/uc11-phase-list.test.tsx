/**
 * T-UC-11 — S-F02 フェーズ管理 配線テスト
 *
 * fake client を注入し real API を叩かずに検証する:
 *   - GET /workflow/phases?project_id を一覧描画（status を UI 値へマップ）
 *   - select 変更で PATCH /workflow/phases/{id} {status}（done→completed 変換）
 *   - 403 拒否
 */

// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";

import * as React from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";
import { ApiError, type ApiClient } from "@atelier/api-client";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createQueryClient } from "../../lib/query-client";
import { PhaseListContainer } from "../../app/workflow/s_f02/_components/PhaseListContainer";

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
  impl: Partial<Record<"get" | "patch", unknown>>,
): ApiClient {
  const noop = vi.fn(async () => ({ data: [] }));
  return {
    get: impl.get ?? noop,
    patch: impl.patch ?? noop,
    post: noop,
    delete: noop,
    put: noop,
    request: noop,
  } as unknown as ApiClient;
}

const PHASES = [
  { id: "ph1", name: "設計", status: "in_progress", order_index: 1 },
];

afterEach(() => vi.clearAllMocks());

describe("S-F02 PhaseListContainer (T-UC-11)", () => {
  it("lists phases mapped to UI status", async () => {
    const get = vi.fn(async (path: unknown) =>
      path === "/ai-employees" ? { data: [] } : { data: PHASES },
    );
    renderWithQuery(
      <PhaseListContainer projectId="p1" client={fakeClient({ get })} />,
    );
    expect(await screen.findByText("設計")).toBeInTheDocument();
    expect(
      (screen.getByLabelText("設計 の状態") as HTMLSelectElement).value,
    ).toBe("in_progress");
    const init = (
      get.mock.calls[0] as unknown as [
        string,
        { params: { query: { project_id: string } } },
      ]
    )[1];
    expect(init.params.query.project_id).toBe("p1");
  });

  it("transitions via PATCH with UI→API status mapping (done→completed)", async () => {
    const get = vi.fn(async (path: unknown) =>
      path === "/ai-employees" ? { data: [] } : { data: PHASES },
    );
    const patch = vi.fn(async () => ({ data: {} }));
    renderWithQuery(
      <PhaseListContainer projectId="p1" client={fakeClient({ get, patch })} />,
    );
    const select = (await screen.findByLabelText(
      "設計 の状態",
    )) as HTMLSelectElement;
    fireEvent.change(select, { target: { value: "done" } });
    await waitFor(() => expect(patch).toHaveBeenCalledTimes(1));
    const [path, init] = patch.mock.calls[0]! as unknown as [
      string,
      { params: { path: { phase_id: string } }; body: { status: string } },
    ];
    expect(path).toBe("/workflow/phases/{phase_id}");
    expect(init.params.path.phase_id).toBe("ph1");
    expect(init.body.status).toBe("completed");
  });

  it("shows a forbidden message on 403", async () => {
    const get = vi.fn(async () => {
      throw apiError(403);
    });
    renderWithQuery(
      <PhaseListContainer projectId="p1" client={fakeClient({ get })} />,
    );
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "権限がありません",
    );
  });
});

describe("S-F02 担当割当 (GAP-004)", () => {
  const EMPS = [
    { id: "e1", name: "wanda", display_name: "ワンダ" },
    { id: "e2", name: "thor", display_name: "ソー" },
  ];

  it("割当チップ + 追加 select が出て PATCH assigned_employee_ids が飛ぶ", async () => {
    const get = vi.fn(async (path: unknown) =>
      path === "/ai-employees"
        ? { data: EMPS }
        : path === "/projects/{project_id}"
          ? { data: { workspace_id: "ws1" } }
          : {
              data: [
                {
                  id: "ph1",
                  name: "設計",
                  status: "in_progress",
                  order_index: 1,
                  assigned_employee_ids: ["e1"],
                },
              ],
            },
    );
    const patch = vi.fn(async () => ({ data: {} }));
    renderWithQuery(
      <PhaseListContainer projectId="p1" client={fakeClient({ get, patch })} />,
    );
    // 既存割当がチップ表示
    expect(await screen.findByText("ワンダ")).toBeInTheDocument();
    // 追加 → PATCH (丸ごと置換で e1+e2)
    fireEvent.change(screen.getByLabelText("設計 に担当を追加"), {
      target: { value: "e2" },
    });
    await waitFor(() =>
      expect(patch).toHaveBeenCalledWith(
        "/workflow/phases/{phase_id}",
        expect.objectContaining({
          body: { assigned_employee_ids: ["e1", "e2"] },
        }),
      ),
    );
    // 外す → PATCH (空配列)
    fireEvent.click(
      screen.getByRole("button", { name: "設計 の担当から ワンダ を外す" }),
    );
    await waitFor(() =>
      expect(patch).toHaveBeenCalledWith(
        "/workflow/phases/{phase_id}",
        expect.objectContaining({ body: { assigned_employee_ids: [] } }),
      ),
    );
  });
});
