/**
 * T-UC-14 — S-I01 タスクボード 配線テスト
 *
 * fake client を注入し real API を叩かずに検証する:
 *   - GET /tasks?project_id で取得し 6 列へマップ (triage→バックログ)
 *   - ready タスクの再生で POST /tasks/{id}/play
 *   - 空状態 / 403 拒否
 */

// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";

import * as React from "react";
import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";
import { ApiError, type ApiClient } from "@atelier/api-client";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createQueryClient } from "../../lib/query-client";
import { TaskBoardContainer } from "../../app/tasks/s_i01/_components/TaskBoardContainer";

function renderWithQuery(ui: React.ReactElement) {
  const qc = createQueryClient();
  return render(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>);
}

function apiError(status: number): ApiError {
  return new ApiError({
    status,
    statusText: "x",
    payload: undefined,
    path: "/tasks",
    method: "get",
  });
}

function fakeClient(
  impl: Partial<Record<"get" | "post" | "patch" | "delete", unknown>>,
): ApiClient {
  const noop = vi.fn(async () => ({ data: [] }));
  return {
    get: impl.get ?? noop,
    post: impl.post ?? noop,
    patch: impl.patch ?? noop,
    delete: impl.delete ?? noop,
    put: noop,
    request: noop,
  } as unknown as ApiClient;
}

afterEach(() => vi.clearAllMocks());

const TASKS = [
  { id: "t1", title: "要件 hearing", lifecycle_stage: "triage" },
  { id: "t2", title: "API 設計", lifecycle_stage: "ready" },
  { id: "t3", title: "UI 実装", lifecycle_stage: "in_progress" },
];

describe("S-I01 TaskBoardContainer (T-UC-14)", () => {
  it("fetches tasks for the project and maps triage to the backlog column", async () => {
    const get = vi.fn(async () => ({ data: TASKS }));
    renderWithQuery(
      <TaskBoardContainer projectId="p1" client={fakeClient({ get })} />,
    );
    // triage タスクはバックログ列に出る
    const backlog = await screen.findByRole("region", { name: "準備中" });
    expect(within(backlog).getByText("要件 hearing")).toBeInTheDocument();
    // GET は project_id 付きで呼ばれる
    const init = (
      get.mock.calls[0] as unknown as [
        string,
        { params: { query: { project_id: string } } },
      ]
    )[1];
    expect(init.params.query.project_id).toBe("p1");
  });

  it("plays a ready task via POST /tasks/{id}/play", async () => {
    const get = vi.fn(async () => ({ data: TASKS }));
    const post = vi.fn(async () => ({ data: {} }));
    renderWithQuery(
      <TaskBoardContainer projectId="p1" client={fakeClient({ get, post })} />,
    );
    fireEvent.click(
      await screen.findByRole("button", { name: "API 設計 を実行" }),
    );
    await waitFor(() => expect(post).toHaveBeenCalledTimes(1));
    const [path, init] = post.mock.calls[0]! as unknown as [
      string,
      { params: { path: { id: string } } },
    ];
    expect(path).toBe("/tasks/{id}/play");
    expect(init.params.path.id).toBe("t2");
  });

  it("shows empty state when there are no tasks", async () => {
    const get = vi.fn(async () => ({ data: [] }));
    renderWithQuery(
      <TaskBoardContainer projectId="p1" client={fakeClient({ get })} />,
    );
    expect(
      await screen.findByText("このプロジェクトにタスクがありません。"),
    ).toBeInTheDocument();
  });

  it("shows a forbidden message on 403", async () => {
    const get = vi.fn(async () => {
      throw apiError(403);
    });
    renderWithQuery(
      <TaskBoardContainer projectId="p1" client={fakeClient({ get })} />,
    );
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "権限がありません",
    );
  });
});
