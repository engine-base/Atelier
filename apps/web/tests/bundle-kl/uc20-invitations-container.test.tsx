/**
 * T-UC-20 — S-L01 クライアント招待管理 配線テスト
 *
 * fake client を注入し real API を叩かずに検証する:
 *   - GET /client-invitations?project_id を status 導出して一覧
 *   - 発行 POST → raw token を1度だけバナー表示
 *   - 失効 POST /client-invitations/{id}/revoke（楽観）
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
import { InvitationsListContainer } from "../../app/client/s_l01/_components/InvitationsListContainer";

function renderWithQuery(ui: React.ReactElement) {
  const qc = createQueryClient();
  return render(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>);
}

function apiError(status: number): ApiError {
  return new ApiError({
    status,
    statusText: "x",
    payload: undefined,
    path: "/client-invitations",
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

const FUTURE = "2999-12-31T00:00:00Z";
const INVS = [
  {
    id: "inv1",
    email: "a@example.com",
    expires_at: FUTURE,
    used_at: null,
    revoked_at: null,
  },
];

afterEach(() => vi.clearAllMocks());

describe("S-L01 InvitationsListContainer (T-UC-20)", () => {
  it("lists invitations with derived status", async () => {
    const get = vi.fn(async () => ({ data: INVS }));
    renderWithQuery(
      <InvitationsListContainer projectId="p1" client={fakeClient({ get })} />,
    );
    expect(await screen.findByText("a@example.com")).toBeInTheDocument();
    expect(screen.getByText("未使用")).toBeInTheDocument();
    const init = (
      get.mock.calls[0] as unknown as [
        string,
        { params: { query: { project_id: string } } },
      ]
    )[1];
    expect(init.params.query.project_id).toBe("p1");
  });

  it("issues an invitation and shows the one-time token banner", async () => {
    const get = vi.fn(async () => ({ data: INVS }));
    const post = vi.fn(async () => ({ data: { token: "raw-token-xyz" } }));
    renderWithQuery(
      <InvitationsListContainer
        projectId="p1"
        client={fakeClient({ get, post })}
      />,
    );
    await screen.findByText("a@example.com");
    fireEvent.change(screen.getByLabelText("招待メールアドレス"), {
      target: { value: "new@example.com" },
    });
    fireEvent.click(screen.getByRole("button", { name: "招待を発行" }));
    // バナーはトークン単体ではなく、共有用の招待リンク(?token=<raw>)を表示する。
    expect(
      await screen.findByText((t) => t.includes("/portal/signin?token=raw-token-xyz")),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "リンクをコピー" }),
    ).toBeInTheDocument();
    const [path, init] = post.mock.calls[0]! as unknown as [
      string,
      { body: { project_id: string; email: string } },
    ];
    expect(path).toBe("/client-invitations");
    expect(init.body).toEqual({ project_id: "p1", email: "new@example.com" });
  });

  it("revokes an invitation via POST revoke", async () => {
    const get = vi.fn(async () => ({ data: INVS }));
    const post = vi.fn(async () => ({ data: {} }));
    renderWithQuery(
      <InvitationsListContainer
        projectId="p1"
        client={fakeClient({ get, post })}
      />,
    );
    fireEvent.click(
      await screen.findByRole("button", { name: "a@example.com を失効" }),
    );
    await waitFor(() => expect(post).toHaveBeenCalledTimes(1));
    const [path, init] = post.mock.calls[0]! as unknown as [
      string,
      { params: { path: { invitation_id: string } } },
    ];
    expect(path).toBe("/client-invitations/{invitation_id}/revoke");
    expect(init.params.path.invitation_id).toBe("inv1");
  });

  it("shows a forbidden message on 403", async () => {
    const get = vi.fn(async () => {
      throw apiError(403);
    });
    renderWithQuery(
      <InvitationsListContainer projectId="p1" client={fakeClient({ get })} />,
    );
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "権限がありません",
    );
  });
});
