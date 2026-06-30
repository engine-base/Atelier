/**
 * T-UC-15 — S-I02 タスク詳細6タブ 配線テスト
 *
 * fake client を注入し real API を叩かずに検証する:
 *   - 概要(GET /tasks/{id}) / 仕様(/acceptance-criteria) / 実行履歴(/executions) /
 *     コメント(GET /comments) をタブに表示
 *   - 403 拒否
 */

// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";

import * as React from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";
import { ApiError, type ApiClient } from "@atelier/api-client";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createQueryClient } from "../../lib/query-client";
import { TaskDetailContainer } from "../../app/tasks/s_i02/_components/TaskDetailContainer";

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

function routedGet() {
  return vi.fn(async (path: string) => {
    if (path.includes("acceptance-criteria")) {
      return {
        data: { items: ["構造: API を公開", "機能: 403 を返す"], version: 1 },
      };
    }
    if (path.includes("executions")) {
      return {
        data: [
          {
            id: "x1",
            status: "completed",
            score: 0.92,
            ac_pass_rate: 1,
            started_at: "2026-06-20T10:00:00Z",
          },
        ],
      };
    }
    if (path.includes("comments") || path === "/comments") {
      return {
        data: [
          {
            id: "c1",
            author_user_id: "u1",
            content: "LGTM",
            created_at: "2026-06-20T11:00:00Z",
          },
        ],
      };
    }
    return {
      data: {
        title: "API 設計",
        lifecycle_stage: "in_progress",
        priority: "high",
        type: "feature",
        estimated_hours: 6,
        description: "詳細説明",
      },
    };
  });
}

afterEach(() => vi.clearAllMocks());

describe("S-I02 TaskDetailContainer (T-UC-15)", () => {
  it("shows the task title and overview, then spec / history / comments per tab", async () => {
    renderWithQuery(
      <TaskDetailContainer taskId="t1" client={fakeClient(routedGet())} />,
    );

    // タイトル + 概要タブ
    expect(
      await screen.findByRole("heading", { name: "API 設計" }),
    ).toBeInTheDocument();
    expect(screen.getByText("in_progress")).toBeInTheDocument();

    // 仕様タブ
    fireEvent.click(screen.getByRole("tab", { name: "仕様" }));
    expect(await screen.findByText(/構造: API を公開/)).toBeInTheDocument();

    // 実行履歴タブ
    fireEvent.click(screen.getByRole("tab", { name: "実行履歴" }));
    expect(await screen.findByText("completed")).toBeInTheDocument();

    // コメントタブ
    fireEvent.click(screen.getByRole("tab", { name: "コメント" }));
    expect(await screen.findByText("LGTM")).toBeInTheDocument();
  });

  it("shows a forbidden message on 403", async () => {
    const get = vi.fn(async () => {
      throw apiError(403);
    });
    renderWithQuery(
      <TaskDetailContainer taskId="t1" client={fakeClient(get)} />,
    );
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "権限がありません",
    );
  });
});
