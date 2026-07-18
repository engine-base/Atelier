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

// ── v2 (モック忠実再構築) の追加カバレッジ ──────────────────────

const RICH_INBOX = [
  {
    id: "s1",
    type: "scope_change",
    title: "仕様変更X",
    status: "pending",
    payload: {
      requested_by: "tony",
      preview: "プレビュー文",
      description: "何が起きたかの説明",
      impact: [{ label: "影響タスクの数", value: "7 件", warn: true }],
      stages: [
        { key: "req", label: "要件定義", checked: true },
        { key: "arch", label: "アーキ設計", disabled: true },
      ],
    },
    created_at: "2026-07-18T00:00:00Z",
  },
  {
    id: "t1",
    type: "task_approval",
    title: "タスクY",
    status: "pending",
    payload: { requested_by: "vision", score: 0.87 },
    created_at: "2026-07-18T01:00:00Z",
  },
  {
    id: "r1",
    type: "task_approval",
    title: "済みZ",
    status: "approved",
    payload: {},
    created_at: "2026-07-18T02:00:00Z",
    resolved_at: "2026-07-18T02:01:00Z",
  },
];

describe("S-J01 v2: KPI / チップ絞り込み / 詳細ペイン", () => {
  it("renders KPI from real counts (urgent=1, pending=2)", async () => {
    const get = vi.fn(async () => ({ data: RICH_INBOX }));
    renderWithQuery(<ApprovalsContainer client={fakeClient({ get })} />);
    const kpi = await screen.findByLabelText("承認 KPI");
    expect(kpi).toHaveTextContent("緊急（仕様変更）");
    expect(kpi).toHaveTextContent("未処理");
    // 処理済 (approved) は pending リストに出ない
    expect(screen.queryByText("済みZ")).toBeNull();
  });

  it("filters the list by kind chip and shows counts", async () => {
    const get = vi.fn(async () => ({ data: RICH_INBOX }));
    renderWithQuery(<ApprovalsContainer client={fakeClient({ get })} />);
    await screen.findByText("仕様変更X");
    fireEvent.click(screen.getByRole("button", { name: /^タスク承認/ }));
    expect(screen.queryByText("仕様変更X")).toBeNull();
    expect(screen.getByText("タスクY")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /^すべて/ }));
    expect(await screen.findByText("仕様変更X")).toBeInTheDocument();
  });

  it("opens the detail pane with impact and stage chips on select", async () => {
    const get = vi.fn(async () => ({ data: RICH_INBOX }));
    renderWithQuery(<ApprovalsContainer client={fakeClient({ get })} />);
    fireEvent.click(
      await screen.findByRole("button", { name: "仕様変更X を判断する" }),
    );
    const pane = screen.getByLabelText("承認詳細");
    expect(pane).toHaveTextContent("何が起きたかの説明");
    expect(pane).toHaveTextContent("影響タスクの数");
    // disabled 工程はチェック不可
    const arch = screen.getByRole("checkbox", { name: /アーキ設計/ });
    expect(arch).toBeDisabled();
  });

  it("sends note (stages + memo) in the decide body from the detail pane", async () => {
    const get = vi.fn(async () => ({ data: RICH_INBOX }));
    const post = vi.fn(async () => ({ data: {} }));
    renderWithQuery(<ApprovalsContainer client={fakeClient({ get, post })} />);
    fireEvent.click(
      await screen.findByRole("button", { name: "仕様変更X を判断する" }),
    );
    fireEvent.change(screen.getByPlaceholderText(/差し戻し理由/), {
      target: { value: "条件付き承認" },
    });
    fireEvent.click(
      screen.getByRole("button", { name: "承認して再実行を開始" }),
    );
    await waitFor(() => expect(post).toHaveBeenCalledTimes(1));
    const [, init] = post.mock.calls[0]! as unknown as [
      string,
      { body: { decision: string; note?: string } },
    ];
    expect(init.body.decision).toBe("approve");
    expect(init.body.note).toContain("要件定義");
    expect(init.body.note).toContain("条件付き承認");
  });

  it("defer (あとで判断する) clears the detail pane without calling the API", async () => {
    const get = vi.fn(async () => ({ data: RICH_INBOX }));
    const post = vi.fn(async () => ({ data: {} }));
    renderWithQuery(<ApprovalsContainer client={fakeClient({ get, post })} />);
    fireEvent.click(
      await screen.findByRole("button", { name: "仕様変更X を判断する" }),
    );
    fireEvent.click(screen.getByRole("button", { name: "あとで判断する" }));
    expect(
      screen.getByText(/リストから案件を選ぶと/),
    ).toBeInTheDocument();
    expect(post).not.toHaveBeenCalled();
  });
});
