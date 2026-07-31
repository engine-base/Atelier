/**
 * T-UC-12 — S-G01 成果物ビューア 配線テスト
 *
 *   - GET /outputs/{id} + /content-url + /comments を取得し iframe + コメント表示
 *   - HTML 未生成(409) / 権限(403) の文言表示
 */

// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";

import * as React from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";
import { ApiError, type ApiClient } from "@atelier/api-client";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createQueryClient } from "../../lib/query-client";
import { OutputViewerContainer } from "../../app/outputs/s_g01/_components/OutputViewerContainer";

function renderWithQuery(ui: React.ReactElement) {
  const qc = createQueryClient();
  return render(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>);
}

function apiError(status: number): ApiError {
  return new ApiError({
    status,
    statusText: "x",
    payload: undefined,
    path: "/outputs",
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

describe("S-G01 OutputViewerContainer (T-UC-12)", () => {
  it("renders the iframe with the signed URL and the comments", async () => {
    const get = vi.fn(async (path: string) => {
      if (path.includes("content-url"))
        return { data: { url: "https://storage/signed/out.html?token=x" } };
      if (path === "/comments")
        return {
          data: [{ id: "c1", author_user_id: "u1", content: "要修正" }],
        };
      return { data: { summary: "見積書 v2", stage: "estimate" } };
    });
    renderWithQuery(
      <OutputViewerContainer outputId="o1" client={fakeClient(get)} />,
    );
    const frame = (await screen.findByTitle("見積書 v2")) as HTMLIFrameElement;
    expect(frame).toHaveAttribute(
      "src",
      "https://storage/signed/out.html?token=x",
    );
    expect(screen.getByText("要修正")).toBeInTheDocument();
  });

  it("adds a comment via POST /comments (optimistic)", async () => {
    const commentsData: {
      id: string;
      author_user_id: string;
      content: string;
    }[] = [];
    const get = vi.fn(async (path: string) => {
      if (path.includes("content-url"))
        return { data: { url: "https://storage/signed/out.html?token=x" } };
      if (path === "/comments") return { data: [...commentsData] };
      return { data: { summary: "見積書 v2" } };
    });
    const post = vi.fn(
      async (_path: string, init: { body: { content: string } }) => {
        // server が永続化した想定: 以降の GET /comments に反映する。
        commentsData.push({
          id: "c9",
          author_user_id: "u2",
          content: init.body.content,
        });
        return { data: { id: "c9" } };
      },
    );
    const client = {
      get,
      post,
      patch: vi.fn(),
      delete: vi.fn(),
      put: vi.fn(),
      request: vi.fn(),
    };
    renderWithQuery(
      <OutputViewerContainer outputId="o1" client={client as never} />,
    );
    const ta = (await screen.findByPlaceholderText(
      "コメントを追加…",
    )) as HTMLTextAreaElement;
    fireEvent.change(ta, { target: { value: "要修正です" } });
    fireEvent.click(screen.getByRole("button", { name: "コメント" }));
    await waitFor(() => expect(post).toHaveBeenCalledTimes(1));
    const [path, init] = post.mock.calls[0]! as unknown as [
      string,
      { body: { target_type: string; target_id: string; content: string } },
    ];
    expect(path).toBe("/comments");
    expect(init.body).toEqual({
      target_type: "workflow_output",
      target_id: "o1",
      content: "要修正です",
    });
    // 楽観追加で即座に表示
    expect(screen.getByText("要修正です")).toBeInTheDocument();
  });

  it("resolves an open comment via PATCH /comments/{id} status=resolved", async () => {
    let status = "open";
    const get = vi.fn(async (path: string) => {
      if (path.includes("content-url"))
        return { data: { url: "https://storage/signed/out.html?token=x" } };
      if (path === "/comments")
        return {
          data: [
            { id: "c1", author_user_id: "u1", content: "要修正", status },
          ],
        };
      return { data: { summary: "見積書 v2" } };
    });
    const patch = vi.fn(async () => {
      status = "resolved";
      return { data: {} };
    });
    const client = {
      get,
      post: vi.fn(),
      patch,
      delete: vi.fn(),
      put: vi.fn(),
      request: vi.fn(),
    };
    renderWithQuery(
      <OutputViewerContainer outputId="o1" client={client as never} />,
    );
    // 未解決バッジが出る
    expect(await screen.findByText("未解決 1")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "解決にする" }));
    await waitFor(() => expect(patch).toHaveBeenCalledTimes(1));
    const [path, init] = patch.mock.calls[0]! as unknown as [
      string,
      { params: { path: { comment_id: string } }; body: { status: string } },
    ];
    expect(path).toBe("/comments/{comment_id}");
    expect(init.params.path.comment_id).toBe("c1");
    expect(init.body.status).toBe("resolved");
    // 再取得で解決済み表示に
    expect(await screen.findByText("すべて解決済み")).toBeInTheDocument();
  });

  it("does not render a disabled 編集 button (Rule 10)", async () => {
    const get = vi.fn(async (path: string) => {
      if (path.includes("content-url"))
        return { data: { url: "https://storage/signed/out.html" } };
      if (path === "/comments") return { data: [] };
      return { data: { summary: "見積書 v2" } };
    });
    renderWithQuery(
      <OutputViewerContainer outputId="o1" client={fakeClient(get)} />,
    );
    await screen.findByTitle("見積書 v2");
    expect(screen.queryByRole("button", { name: "編集" })).not.toBeInTheDocument();
    // 原本リンクは残る
    expect(screen.getByRole("link", { name: "原本" })).toBeInTheDocument();
  });

  it("shows a not-generated message on 409", async () => {
    const get = vi.fn(async (path: string) => {
      if (path.includes("content-url")) throw apiError(409);
      return { data: { summary: "draft" } };
    });
    renderWithQuery(
      <OutputViewerContainer outputId="o1" client={fakeClient(get)} />,
    );
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "まだ生成されていません",
    );
  });

  it("shows a forbidden message on 403", async () => {
    const get = vi.fn(async () => {
      throw apiError(403);
    });
    renderWithQuery(
      <OutputViewerContainer outputId="o1" client={fakeClient(get)} />,
    );
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "権限がありません",
    );
  });
});
