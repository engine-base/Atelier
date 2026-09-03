/**
 * GAP-315 (通し J31-08) — 未登録の相手を招待できるようにした分の画面テスト。
 *
 *   - 未登録の宛先に招待リンクを送ったことが画面に出る (S-A03)
 *   - /invite/<token> が「どこへの招待か」を見せ、参加できる
 *   - 期限切れは **理由つき**で出る (「無効です」だけだと壊れているとしか思えない)
 *   - 未サインインなら、招待された宛先でのサインイン / 登録へ案内する
 */

// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";

import * as React from "react";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";
import { ApiError, type ApiClient } from "@atelier/api-client";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createQueryClient } from "../../lib/query-client";
import { MembersSection } from "../../app/auth/s_a03/_components/MembersSection";
import { InviteAcceptContainer } from "../../app/invite/[token]/_components/InviteAcceptContainer";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}));

function renderWithQuery(ui: React.ReactElement) {
  const qc = createQueryClient();
  return render(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>);
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

function apiError(status: number, detail: string): ApiError {
  return new ApiError({
    status,
    statusText: "x",
    payload: { detail },
    path: "/invitations/x",
    method: "get",
  });
}

afterEach(() => vi.clearAllMocks());

describe("S-A03 未登録の宛先への招待 (GAP-315)", () => {
  it("招待リンクを送ったことが画面に出る (メンバーは増えない)", async () => {
    const get = vi.fn(async () => ({ data: [] }));
    const post = vi.fn(async () => ({
      data: {
        id: "inv1",
        workspace_id: "w1",
        workspace_name: "テスト WS",
        email: "newbie@example.com",
        role: "member",
        expires_at: "2026-09-10T00:00:00Z",
      },
    }));
    renderWithQuery(
      <MembersSection workspaceId="w1" client={fakeClient({ get, post })} />,
    );
    fireEvent.click(await screen.findByRole("button", { name: "メンバー招待" }));
    fireEvent.change(screen.getByLabelText(/メール/), {
      target: { value: "newbie@example.com" },
    });
    fireEvent.click(screen.getByRole("button", { name: "招待する" }));
    await waitFor(() => expect(post).toHaveBeenCalled());
    expect(
      await screen.findByText(/7 日間有効な招待リンクをメールで送りました/),
    ).toBeInTheDocument();
  });
});

describe("/invite/<token> 招待の受け取り (GAP-315)", () => {
  const PREVIEW = {
    workspace_name: "テスト WS",
    email: "newbie@example.com",
    role: "member",
    expires_at: "2026-09-10T09:00:00Z",
    invited_by_name: "オーナー太郎",
  };

  it("どこへの招待かが分かり、参加できる", async () => {
    const get = vi.fn(async () => ({ data: PREVIEW }));
    const post = vi.fn(async () => ({
      data: { workspace_id: "w1", workspace_name: "テスト WS", role: "member" },
    }));
    renderWithQuery(
      <InviteAcceptContainer token="t1" client={fakeClient({ get, post })} signedIn />,
    );
    expect(await screen.findByText(/「テスト WS」への招待/)).toBeInTheDocument();
    expect(screen.getByText("newbie@example.com")).toBeInTheDocument();
    expect(screen.getByText("メンバー")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "参加する" }));
    await waitFor(() => expect(post).toHaveBeenCalled());
    expect(
      await screen.findByRole("heading", { name: "参加しました" }),
    ).toBeInTheDocument();
  });

  it("期限切れは理由つきで出る (「無効です」で終わらせない)", async () => {
    const get = vi.fn(async () => {
      throw apiError(
        410,
        "この招待リンクは期限切れです。招待した人にもう一度送ってもらってください。",
      );
    });
    renderWithQuery(
      <InviteAcceptContainer token="t2" client={fakeClient({ get })} signedIn />,
    );
    const alert = await screen.findByRole("alert");
    expect(within(alert).getByText(/期限切れ/)).toBeInTheDocument();
  });

  it("未サインインなら、招待された宛先での登録 / サインインへ案内する", async () => {
    const get = vi.fn(async () => ({ data: PREVIEW }));
    renderWithQuery(
      <InviteAcceptContainer token="t3" client={fakeClient({ get })} signedIn={false} />,
    );
    expect(
      await screen.findByRole("link", { name: "サインインする" }),
    ).toHaveAttribute("href", "/signin?redirect=%2Finvite%2Ft3");
    expect(screen.getByRole("link", { name: "新規登録する" })).toHaveAttribute(
      "href",
      "/signup?redirect=%2Finvite%2Ft3",
    );
  });
});
