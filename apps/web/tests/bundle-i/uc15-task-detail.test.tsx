/**
 * T-UC-15 — S-I02 タスク詳細 配線テスト (design-audit v2 拡張)
 *
 * fake client を注入し real API を叩かずに検証する:
 *   - ヘッダ (GET /tasks/{id}) + 担当 AI 表示名解決 (GET /ai-employees)
 *   - 受入条件 (/acceptance-criteria) / 実行履歴 (/executions) / 依存タスク /
 *     コメント (GET /comments) の各タブ
 *   - コメント追加 (POST /comments target_type=task)
 *   - 操作バー: awaiting で承認/差し戻し (2 段階確認 → POST approve/reject)、
 *     blocked で再試行、その他 stage では非描画 (Rule 10)
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

function fakeClient(get: unknown, post?: unknown): ApiClient {
  const noop = vi.fn(async () => ({ data: [] }));
  return {
    get,
    post: post ?? noop,
    patch: noop,
    delete: noop,
    put: noop,
    request: noop,
  } as unknown as ApiClient;
}

const BASE_TASK = {
  id: "t1",
  project_id: "p1",
  title: "API 設計",
  lifecycle_stage: "in_progress",
  priority: "high",
  type: "feature",
  estimated_hours: 6,
  description: "詳細説明",
  assigned_employee_id: "thor",
  retry_count: 1,
  prerequisites: ["d1"],
  dependencies: [],
  blocks: ["d2"],
};

function routedGet(taskOverrides?: Record<string, unknown>) {
  return vi.fn(async (path: string) => {
    if (path.includes("acceptance-criteria")) {
      return {
        data: {
          items: [
            { tier: 1, text: "画面 ID が正しく設定されている" },
            { tier: 2, text: "403 を返す" },
          ],
          version: 1,
        },
      };
    }
    if (path.includes("executions")) {
      return {
        data: [
          {
            id: "x1",
            status: "succeeded",
            score: 0.92,
            ac_pass_rate: 1,
            started_at: "2026-06-20T10:00:00Z",
          },
        ],
      };
    }
    if (path === "/comments") {
      return {
        data: [
          {
            id: "c1",
            author_user_id: "u1-0000-0000",
            content: "LGTM",
            created_at: "2026-06-20T11:00:00Z",
          },
        ],
      };
    }
    if (path === "/ai-employees") {
      return { data: [{ name: "thor", display_name: "ソー" }] };
    }
    if (path === "/tasks") {
      return {
        data: [
          { id: "d1", title: "DB 権限設計", lifecycle_stage: "done" },
          { id: "d2", title: "チャット UI 導入", lifecycle_stage: "ready" },
        ],
      };
    }
    return { data: { ...BASE_TASK, ...taskOverrides } };
  });
}

afterEach(() => vi.clearAllMocks());

describe("S-I02 TaskDetailContainer (T-UC-15)", () => {
  it("shows the hero with the resolved AI-employee display name (no raw code)", async () => {
    renderWithQuery(
      <TaskDetailContainer taskId="t1" client={fakeClient(routedGet())} />,
    );
    expect(
      await screen.findByRole("heading", { name: "API 設計" }),
    ).toBeInTheDocument();
    // 担当は表示名 (鉄則5: 生コード thor を出さない)
    expect((await screen.findAllByText("ソー")).length).toBeGreaterThan(0);
    expect(screen.queryByText("thor")).not.toBeInTheDocument();
    // 再試行メタ
    expect(screen.getByText("1 / 3 回")).toBeInTheDocument();
  });

  it("renders AC (default tab, 3-tier), history link, deps chips and comments per tab", async () => {
    renderWithQuery(
      <TaskDetailContainer taskId="t1" client={fakeClient(routedGet())} />,
    );
    // 受入条件タブ (既定) — tier 見出し + 項目
    expect(
      await screen.findByText("画面 ID が正しく設定されている"),
    ).toBeInTheDocument();
    expect(screen.getByText("構造の条件")).toBeInTheDocument();
    expect(screen.getByText("機能の条件")).toBeInTheDocument();

    // 依存タスクタブ — 前提/後続がタイトル解決される
    fireEvent.click(screen.getByRole("tab", { name: /依存タスク/ }));
    expect(await screen.findByText("DB 権限設計")).toBeInTheDocument();
    expect(screen.getByText("チャット UI 導入")).toBeInTheDocument();

    // 実行履歴タブ — S-I03 実行モニターへの実リンク
    fireEvent.click(screen.getByRole("tab", { name: /実行履歴/ }));
    expect(await screen.findByText("成功")).toBeInTheDocument();
    const links = screen.getAllByRole("link");
    expect(
      links.some(
        (l) => l.getAttribute("href") === "/tasks/monitor?execution=x1",
      ),
    ).toBe(true);

    // コメントタブ — 一覧 + 生 UUID を出さない
    fireEvent.click(screen.getByRole("tab", { name: /コメント/ }));
    expect(await screen.findByText("LGTM")).toBeInTheDocument();
    expect(screen.getByText(/メンバー u1-0000-/)).toBeInTheDocument();
  });

  it("adds a comment via POST /comments (target_type=task)", async () => {
    const post = vi.fn(async () => ({ data: { id: "c9" } }));
    renderWithQuery(
      <TaskDetailContainer taskId="t1" client={fakeClient(routedGet(), post)} />,
    );
    await screen.findByRole("heading", { name: "API 設計" });
    fireEvent.click(screen.getByRole("tab", { name: /コメント/ }));
    const ta = (await screen.findByPlaceholderText(
      "コメントを追加…",
    )) as HTMLTextAreaElement;
    fireEvent.change(ta, { target: { value: "確認しました" } });
    fireEvent.click(screen.getByRole("button", { name: "コメント" }));
    await waitFor(() => expect(post).toHaveBeenCalledTimes(1));
    const [path, init] = post.mock.calls[0]! as unknown as [
      string,
      { body: { target_type: string; target_id: string; content: string } },
    ];
    expect(path).toBe("/comments");
    expect(init.body).toEqual({
      target_type: "task",
      target_id: "t1",
      content: "確認しました",
    });
  });

  it("approves an awaiting task via the action bar (2-step confirm)", async () => {
    const post = vi.fn(async (..._args: unknown[]) => ({ data: { ...BASE_TASK } }));
    renderWithQuery(
      <TaskDetailContainer
        taskId="t1"
        client={fakeClient(routedGet({ lifecycle_stage: "awaiting" }), post)}
      />,
    );
    fireEvent.click(
      await screen.findByRole("button", { name: /承認する/ }),
    );
    // 2 段階確認
    expect(screen.getByText("承認して完了にしますか？")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "確定" }));
    await waitFor(() => expect(post).toHaveBeenCalledTimes(1));
    expect(post.mock.calls[0]![0]).toBe("/tasks/{task_id}/approve");
  });

  it("rejects an awaiting task with an optional note", async () => {
    const post = vi.fn(async (..._args: unknown[]) => ({ data: { ...BASE_TASK } }));
    renderWithQuery(
      <TaskDetailContainer
        taskId="t1"
        client={fakeClient(routedGet({ lifecycle_stage: "awaiting" }), post)}
      />,
    );
    fireEvent.click(await screen.findByRole("button", { name: /差し戻し/ }));
    fireEvent.change(screen.getByLabelText("差し戻し理由"), {
      target: { value: "条件 6 が未達" },
    });
    fireEvent.click(screen.getByRole("button", { name: "確定" }));
    await waitFor(() => expect(post).toHaveBeenCalledTimes(1));
    const [path, init] = post.mock.calls[0]! as unknown as [
      string,
      { body: { note?: string } },
    ];
    expect(path).toBe("/tasks/{task_id}/reject");
    expect(init.body.note).toBe("条件 6 が未達");
  });

  it("retries a blocked task and hides the bar for non-actionable stages", async () => {
    const post = vi.fn(async (..._args: unknown[]) => ({ data: { ...BASE_TASK } }));
    const { unmount } = renderWithQuery(
      <TaskDetailContainer
        taskId="t1"
        client={fakeClient(
          routedGet({ lifecycle_stage: "blocked", blocked_reason: "AC 未達" }),
          post,
        )}
      />,
    );
    // blocked_reason がヘッダに出る
    expect(await screen.findByText("AC 未達")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /再試行/ }));
    fireEvent.click(screen.getByRole("button", { name: "確定" }));
    await waitFor(() => expect(post).toHaveBeenCalledTimes(1));
    expect(post.mock.calls[0]![0]).toBe("/tasks/{task_id}/retry");
    unmount();

    // in_progress では操作バー非描画 (409 契約に従い死にボタンを置かない)
    renderWithQuery(
      <TaskDetailContainer taskId="t1" client={fakeClient(routedGet())} />,
    );
    await screen.findByRole("heading", { name: "API 設計" });
    expect(
      screen.queryByRole("button", { name: /承認する/ }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /再試行/ }),
    ).not.toBeInTheDocument();
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
