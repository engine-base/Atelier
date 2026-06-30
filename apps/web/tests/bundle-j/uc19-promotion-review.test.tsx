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

function fakeClient(impl: Partial<Record<"get" | "post", unknown>>): ApiClient {
  const noop = vi.fn(async () => ({ data: [] }));
  return {
    get: impl.get ?? noop,
    post: impl.post ?? noop,
    patch: noop,
    delete: noop,
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

  it("dismisses a candidate on reject (client-side)", async () => {
    const get = vi.fn(async () => ({ data: CANDIDATES }));
    renderWithQuery(
      <PromotionReviewContainer {...props({ client: fakeClient({ get }) })} />,
    );
    fireEvent.click(
      await screen.findByRole("button", { name: "遷移ルール を却下" }),
    );
    await waitFor(() =>
      expect(screen.getByText("昇格候補はありません。")).toBeInTheDocument(),
    );
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
