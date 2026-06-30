/**
 * T-UC-25 — S-O01 自動スケジュール 配線テスト
 *
 * fake client を注入し real API を叩かずに検証する:
 *   - GET /cron-schedules?project_id の一覧描画
 *   - 有効トグルで PATCH /cron-schedules/{id} {enabled}
 *   - 即時実行列は出さない（バックエンド未対応）
 *   - 空状態 / 403
 */

// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";

import * as React from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";
import { ApiError, type ApiClient } from "@atelier/api-client";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createQueryClient } from "../../lib/query-client";
import { CronScheduleContainer } from "../../app/cron/s_o01/_components/CronScheduleContainer";

function renderWithQuery(ui: React.ReactElement) {
  const qc = createQueryClient();
  return render(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>);
}

function apiError(status: number): ApiError {
  return new ApiError({
    status,
    statusText: "x",
    payload: undefined,
    path: "/c",
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

const JOBS = [
  {
    id: "j1",
    name: "昇格レビュー集約",
    cron_expression: "0 9 * * *",
    enabled: true,
    next_run_at: "2026-06-21T09:00:00Z",
  },
];

afterEach(() => vi.clearAllMocks());

describe("S-O01 CronScheduleContainer (T-UC-25)", () => {
  it("renders cron jobs for the project and hides the run-now column", async () => {
    const get = vi.fn(async () => ({ data: JOBS }));
    renderWithQuery(
      <CronScheduleContainer projectId="p1" client={fakeClient({ get })} />,
    );
    expect(await screen.findByText("昇格レビュー集約")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /今すぐ実行/ })).toBeNull();
    const init = (
      get.mock.calls[0] as unknown as [
        string,
        { params: { query: { project_id: string } } },
      ]
    )[1];
    expect(init.params.query.project_id).toBe("p1");
  });

  it("toggles enabled via PATCH /cron-schedules/{id}", async () => {
    const get = vi.fn(async () => ({ data: JOBS }));
    const patch = vi.fn(async () => ({ data: {} }));
    renderWithQuery(
      <CronScheduleContainer
        projectId="p1"
        client={fakeClient({ get, patch })}
      />,
    );
    fireEvent.click(
      await screen.findByLabelText(/昇格レビュー集約 を 無効 化/),
    );
    await waitFor(() => expect(patch).toHaveBeenCalledTimes(1));
    const [path, init] = patch.mock.calls[0]! as unknown as [
      string,
      { params: { path: { schedule_id: string } }; body: { enabled: boolean } },
    ];
    expect(path).toBe("/cron-schedules/{schedule_id}");
    expect(init.params.path.schedule_id).toBe("j1");
    expect(init.body.enabled).toBe(false);
  });

  it("shows empty state when there are no schedules", async () => {
    const get = vi.fn(async () => ({ data: [] }));
    renderWithQuery(
      <CronScheduleContainer projectId="p1" client={fakeClient({ get })} />,
    );
    expect(
      await screen.findByText("スケジュールがまだありません。"),
    ).toBeInTheDocument();
  });

  it("shows a forbidden message on 403", async () => {
    const get = vi.fn(async () => {
      throw apiError(403);
    });
    renderWithQuery(
      <CronScheduleContainer projectId="p1" client={fakeClient({ get })} />,
    );
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "権限がありません",
    );
  });
});
