/**
 * T-UC-17 — S-J01 承認待ち（5 種統合）配線テスト
 *
 * fake client を注入し real API を叩かずに検証する:
 *   - GET /approval-inbox の一覧描画
 *   - 承認/却下で POST /approval-inbox/{id}/decide {decision}
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
import { ApprovalsContainer } from "../../app/approvals/s_j01/_components/ApprovalsContainer";

function renderWithQuery(ui: React.ReactElement) {
  const qc = createQueryClient();
  return render(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>);
}

function apiError(status: number): ApiError {
  return new ApiError({
    status,
    statusText: "x",
    payload: undefined,
    path: "/a",
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

const INBOX = [
  {
    id: "a1",
    type: "task",
    title: "API 設計を承認",
    payload: { actor: "thor" },
    created_at: "2026-06-20T00:00:00Z",
  },
];

afterEach(() => vi.clearAllMocks());

describe("S-J01 ApprovalsContainer (T-UC-17)", () => {
  it("renders the approval inbox from GET /approval-inbox", async () => {
    const get = vi.fn(async () => ({ data: INBOX }));
    renderWithQuery(<ApprovalsContainer client={fakeClient({ get })} />);
    expect(await screen.findByText("API 設計を承認")).toBeInTheDocument();
    const [path] = get.mock.calls[0]! as unknown as [string];
    expect(path).toBe("/approval-inbox");
  });

  it("approves via POST decide {decision: approve}", async () => {
    const get = vi.fn(async () => ({ data: INBOX }));
    const post = vi.fn(async () => ({ data: {} }));
    renderWithQuery(<ApprovalsContainer client={fakeClient({ get, post })} />);
    fireEvent.click(
      await screen.findByRole("button", { name: "API 設計を承認 を承認" }),
    );
    await waitFor(() => expect(post).toHaveBeenCalledTimes(1));
    const [path, init] = post.mock.calls[0]! as unknown as [
      string,
      { params: { path: { approval_id: string } }; body: { decision: string } },
    ];
    expect(path).toBe("/approval-inbox/{approval_id}/decide");
    expect(init.params.path.approval_id).toBe("a1");
    expect(init.body.decision).toBe("approve");
  });

  it("rejects via POST decide {decision: reject}", async () => {
    const get = vi.fn(async () => ({ data: INBOX }));
    const post = vi.fn(async () => ({ data: {} }));
    renderWithQuery(<ApprovalsContainer client={fakeClient({ get, post })} />);
    fireEvent.click(
      await screen.findByRole("button", { name: "API 設計を承認 を却下" }),
    );
    await waitFor(() => expect(post).toHaveBeenCalledTimes(1));
    const init = (
      post.mock.calls[0] as unknown as [string, { body: { decision: string } }]
    )[1];
    expect(init.body.decision).toBe("reject");
  });

  it("shows empty state when inbox is empty", async () => {
    const get = vi.fn(async () => ({ data: [] }));
    renderWithQuery(<ApprovalsContainer client={fakeClient({ get })} />);
    expect(
      await screen.findByText("承認待ちはありません。"),
    ).toBeInTheDocument();
  });

  it("shows a forbidden message on 403", async () => {
    const get = vi.fn(async () => {
      throw apiError(403);
    });
    renderWithQuery(<ApprovalsContainer client={fakeClient({ get })} />);
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "権限がありません",
    );
  });
});
