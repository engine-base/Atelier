/**
 * T-UC-19 — S-K02 ナレッジ昇格レビュー 配線テスト
 *
 * fake client を注入し real API を叩かずに検証する:
 *   - GET /knowledge?account_type=user の昇格候補を描画
 *   - 昇格で POST /knowledge/{id}/promote {target_workspace_id}
 *   - 却下で候補をクライアント側 dismiss
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
import { PromotionReviewContainer } from "../../app/knowledge/s_k02/_components/PromotionReviewContainer";

function renderWithQuery(ui: React.ReactElement) {
  const qc = createQueryClient();
  return render(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>);
}

function apiError(status: number): ApiError {
  return new ApiError({
    status,
    statusText: "x",
    payload: undefined,
    path: "/k",
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

const CANDIDATES = [
  {
    id: "k1",
    title: "遷移ルール",
    content_md: "active→paused",
    confidence_score: 0.9,
    source_type: "ai_extracted",
  },
];

afterEach(() => vi.clearAllMocks());

function props(overrides?: Partial<{ client: ApiClient }>) {
  return { accountId: "u1", targetWorkspaceId: "w1", ...overrides };
}

describe("S-K02 PromotionReviewContainer (T-UC-19)", () => {
  it("renders user-scope promotion candidates", async () => {
    const get = vi.fn(async () => ({ data: CANDIDATES }));
    renderWithQuery(
      <PromotionReviewContainer {...props({ client: fakeClient({ get }) })} />,
    );
    expect(await screen.findByText("遷移ルール")).toBeInTheDocument();
    const init = (
      get.mock.calls[0] as unknown as [
        string,
        { params: { query: { account_type: string } } },
      ]
    )[1];
    expect(init.params.query.account_type).toBe("user");
  });

  it("promotes via POST /knowledge/{id}/promote with target_workspace_id", async () => {
    const get = vi.fn(async () => ({ data: CANDIDATES }));
    const post = vi.fn(async () => ({ data: {} }));
    renderWithQuery(
      <PromotionReviewContainer
        {...props({ client: fakeClient({ get, post }) })}
      />,
    );
    fireEvent.click(
      await screen.findByRole("button", { name: "遷移ルール を昇格" }),
    );
    await waitFor(() => expect(post).toHaveBeenCalledTimes(1));
    const [path, init] = post.mock.calls[0]! as unknown as [
      string,
      {
        params: { path: { knowledge_id: string } };
        body: { target_workspace_id: string };
      },
    ];
    expect(path).toBe("/knowledge/{knowledge_id}/promote");
    expect(init.params.path.knowledge_id).toBe("k1");
    expect(init.body.target_workspace_id).toBe("w1");
  });

  it("rejects via real DELETE /knowledge/{id} after confirm", async () => {
    // v2: 却下はクライアント dismiss ではなく実 DELETE (リロードで復活しない)
    let deleted = false;
    const get = vi.fn(async () => ({ data: deleted ? [] : CANDIDATES }));
    const del = vi.fn(async () => {
      deleted = true;
      return {};
    });
    renderWithQuery(
      <PromotionReviewContainer
        {...props({ client: fakeClient({ get, delete: del }) })}
      />,
    );
    fireEvent.click(
      await screen.findByRole("button", { name: "遷移ルール を却下" }),
    );
    // 2 段階確認
    expect(del).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "却下して削除" }));
    await waitFor(() => expect(del).toHaveBeenCalledTimes(1));
    const [path, init] = del.mock.calls[0]! as unknown as [
      string,
      { params: { path: { knowledge_id: string } } },
    ];
    expect(path).toBe("/knowledge/{knowledge_id}");
    expect(init.params.path.knowledge_id).toBe("k1");
    await waitFor(() =>
      expect(screen.getByText("昇格候補はありません。")).toBeInTheDocument(),
    );
  });

  it("edits then promotes: PATCH with draft before promote", async () => {
    const get = vi.fn(async () => ({ data: CANDIDATES }));
    const patch = vi.fn(async () => ({ data: {} }));
    const post = vi.fn(async () => ({ data: {} }));
    renderWithQuery(
      <PromotionReviewContainer
        {...props({ client: fakeClient({ get, patch, post }) })}
      />,
    );
    await screen.findByLabelText("昇格候補タイトル");
    fireEvent.change(screen.getByLabelText("昇格候補タイトル"), {
      target: { value: "編集済タイトル" },
    });
    fireEvent.click(
      screen.getByRole("button", { name: "遷移ルール を昇格" }),
    );
    await waitFor(() => expect(post).toHaveBeenCalledTimes(1));
    expect(patch).toHaveBeenCalledTimes(1);
    const body = (
      patch.mock.calls[0] as unknown as [string, { body: { title: string } }]
    )[1].body;
    expect(body.title).toBe("編集済タイトル");
  });

  it("adds and removes tags in the editor", async () => {
    const get = vi.fn(async () => ({
      data: [{ ...CANDIDATES[0], tags: ["auth"] }],
    }));
    renderWithQuery(
      <PromotionReviewContainer {...props({ client: fakeClient({ get }) })} />,
    );
    await screen.findByLabelText("タグを追加");
    fireEvent.change(screen.getByLabelText("タグを追加"), {
      target: { value: "oauth" },
    });
    fireEvent.keyDown(screen.getByLabelText("タグを追加"), { key: "Enter" });
    expect(screen.getByText("oauth")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "タグ auth を削除" }));
    expect(screen.queryByText("auth")).toBeNull();
  });

  it("marks employee_specific candidates as non-promotable", async () => {
    const get = vi.fn(async () => ({
      data: [
        { ...CANDIDATES[0], id: "k9", title: "社員別X", scope: "employee_specific" },
      ],
    }));
    renderWithQuery(
      <PromotionReviewContainer {...props({ client: fakeClient({ get }) })} />,
    );
    expect(await screen.findByText("社員別 (昇格不可)")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "社員別X を昇格" })).toBeNull();
  });

  it("shows empty state when there are no candidates", async () => {
    const get = vi.fn(async () => ({ data: [] }));
    renderWithQuery(
      <PromotionReviewContainer {...props({ client: fakeClient({ get }) })} />,
    );
    expect(
      await screen.findByText("昇格候補はありません。"),
    ).toBeInTheDocument();
  });

  it("shows a forbidden message on 403", async () => {
    const get = vi.fn(async () => {
      throw apiError(403);
    });
    renderWithQuery(
      <PromotionReviewContainer {...props({ client: fakeClient({ get }) })} />,
    );
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "権限がありません",
    );
  });
});
