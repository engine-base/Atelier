/**
 * T-UC-11 — S-F02 フェーズ管理 配線テスト
 *
 * fake client を注入し real API を叩かずに検証する:
 *   - GET /workflow/phases?project_id を一覧描画（status を UI 値へマップ）
 *   - select 変更で PATCH /workflow/phases/{id} {status}（done→completed 変換）
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
import { PhaseListContainer } from "../../app/workflow/s_f02/_components/PhaseListContainer";

function renderWithQuery(ui: React.ReactElement) {
  const qc = createQueryClient();
  return render(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>);
}

function apiError(status: number): ApiError {
  return new ApiError({
    status,
    statusText: "x",
    payload: undefined,
    path: "/workflow",
    method: "get",
  });
}

function fakeClient(
  impl: Partial<Record<"get" | "patch", unknown>>,
): ApiClient {
  const noop = vi.fn(async () => ({ data: [] }));
  return {
    get: impl.get ?? noop,
    patch: impl.patch ?? noop,
    post: noop,
    delete: noop,
    put: noop,
    request: noop,
  } as unknown as ApiClient;
}

const PHASES = [
  { id: "ph1", name: "設計", status: "in_progress", order_index: 1 },
];

afterEach(() => vi.clearAllMocks());

describe("S-F02 PhaseListContainer (T-UC-11)", () => {
  it("lists phases mapped to UI status", async () => {
    const get = vi.fn(async (path: unknown) =>
      path === "/ai-employees" ? { data: [] } : { data: PHASES },
    );
    renderWithQuery(
      <PhaseListContainer projectId="p1" client={fakeClient({ get })} />,
    );
    expect(await screen.findByText("設計")).toBeInTheDocument();
    expect(
      (screen.getByLabelText("設計 の状態") as HTMLSelectElement).value,
    ).toBe("in_progress");
    const init = (
      get.mock.calls[0] as unknown as [
        string,
        { params: { query: { project_id: string } } },
      ]
    )[1];
    expect(init.params.query.project_id).toBe("p1");
  });

  it("transitions via PATCH with UI→API status mapping (done→completed)", async () => {
    const get = vi.fn(async (path: unknown) =>
      path === "/ai-employees" ? { data: [] } : { data: PHASES },
    );
    const patch = vi.fn(async () => ({ data: {} }));
    renderWithQuery(
      <PhaseListContainer projectId="p1" client={fakeClient({ get, patch })} />,
    );
    const select = (await screen.findByLabelText(
      "設計 の状態",
    )) as HTMLSelectElement;
    fireEvent.change(select, { target: { value: "done" } });
    await waitFor(() => expect(patch).toHaveBeenCalledTimes(1));
    const [path, init] = patch.mock.calls[0]! as unknown as [
      string,
      { params: { path: { phase_id: string } }; body: { status: string } },
    ];
    expect(path).toBe("/workflow/phases/{phase_id}");
    expect(init.params.path.phase_id).toBe("ph1");
    expect(init.body.status).toBe("completed");
  });

  it("shows a forbidden message on 403", async () => {
    const get = vi.fn(async () => {
      throw apiError(403);
    });
    renderWithQuery(
      <PhaseListContainer projectId="p1" client={fakeClient({ get })} />,
    );
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "権限がありません",
    );
  });
});

describe("S-F02 担当割当 (GAP-004)", () => {
  const EMPS = [
    { id: "e1", name: "wanda", display_name: "ワンダ" },
    { id: "e2", name: "thor", display_name: "ソー" },
  ];

  it("割当チップ + 追加 select が出て PATCH assigned_employee_ids が飛ぶ", async () => {
    const get = vi.fn(async (path: unknown) =>
      path === "/ai-employees"
        ? { data: EMPS }
        : path === "/projects/{project_id}"
          ? { data: { workspace_id: "ws1" } }
          : {
              data: [
                {
                  id: "ph1",
                  name: "設計",
                  status: "in_progress",
                  order_index: 1,
                  assigned_employee_ids: ["e1"],
                },
              ],
            },
    );
    const patch = vi.fn(async () => ({ data: {} }));
    renderWithQuery(
      <PhaseListContainer projectId="p1" client={fakeClient({ get, patch })} />,
    );
    // 既存割当がチップ表示
    expect(await screen.findByText("ワンダ")).toBeInTheDocument();
    // 追加 → PATCH (丸ごと置換で e1+e2)
    fireEvent.change(screen.getByLabelText("設計 に担当を追加"), {
      target: { value: "e2" },
    });
    await waitFor(() =>
      expect(patch).toHaveBeenCalledWith(
        "/workflow/phases/{phase_id}",
        expect.objectContaining({
          body: { assigned_employee_ids: ["e1", "e2"] },
        }),
      ),
    );
    // 外す → PATCH (空配列)
    fireEvent.click(
      screen.getByRole("button", { name: "設計 の担当から ワンダ を外す" }),
    );
    await waitFor(() =>
      expect(patch).toHaveBeenCalledWith(
        "/workflow/phases/{phase_id}",
        expect.objectContaining({ body: { assigned_employee_ids: [] } }),
      ),
    );
  });
});

/** GAP-022 標準系 get: phases / proposals / stats / tasks を返す。 */
function gap022Get(overrides?: {
  proposals?: () => { data: unknown[] };
}) {
  return vi.fn(async (path: string) => {
    if (path === "/workflow/phase-proposals")
      return overrides?.proposals ? overrides.proposals() : { data: [] };
    if (path === "/workflow/phase-task-stats")
      return {
        data: [
          { phase_id: "ph1", total: 24, done: 8, awaiting: 3, avg_score: 0.91 },
        ],
      };
    if (path === "/workflow/impact-stats")
      return {
        data: { today_count: 12, consistency_ok: true, dangling_count: 0 },
      };
    if (path === "/tasks")
      return { data: [{ id: "t42", title: "T-042 実装" }] };
    if (path === "/ai-employees" || path === "/projects/{project_id}")
      return { data: [] };
    return { data: PHASES };
  });
}

const PENDING_PROPOSAL = {
  id: "pp1",
  name: "工程ワークフロー",
  description: "工程・モック・クライアント招待・コメント",
  reason: "既存フェーズの完了状況を踏まえた提案理由です。",
  proposed_order: 3,
  status: "pending",
  created_at: "2026-08-10T10:00:00Z",
};

describe("S-F02 GAP-022 (AI 提案フェーズ + F-IMP01 + 集計)", () => {
  it("renders the real per-phase task stats row", async () => {
    const get = gap022Get();
    renderWithQuery(
      <PhaseListContainer projectId="p1" client={fakeClient({ get })} />,
    );
    await screen.findByText("設計");
    expect(screen.getByText("8")).toBeInTheDocument();
    expect(screen.getByText(/\/ 24 タスク完了/)).toBeInTheDocument();
    expect(screen.getByText("承認待ち")).toBeInTheDocument();
    expect(screen.getByText("スコア平均 0.91")).toBeInTheDocument();
  });

  it("requests a phase proposal from Jarvis (POST /workflow/phase-proposals)", async () => {
    const proposals: unknown[] = [];
    const get = gap022Get({ proposals: () => ({ data: [...proposals] }) });
    const post = vi.fn(async () => {
      proposals.push(PENDING_PROPOSAL);
      return { data: PENDING_PROPOSAL };
    });
    const client = {
      get,
      post,
      patch: vi.fn(),
      delete: vi.fn(),
      put: vi.fn(),
      request: vi.fn(),
    };
    renderWithQuery(
      <PhaseListContainer projectId="p1" client={client as never} />,
    );
    fireEvent.click(
      await screen.findByRole("button", {
        name: "ジャービスに次フェーズを提案してもらう",
      }),
    );
    await waitFor(() => expect(post).toHaveBeenCalledTimes(1));
    const [path, init] = post.mock.calls[0]! as unknown as [
      string,
      { body: { project_id: string } },
    ];
    expect(path).toBe("/workflow/phase-proposals");
    expect(init.body.project_id).toBe("p1");
    // pending カード (proposed) が実描画され、提案理由をトグル表示できる
    expect(
      await screen.findByText("工程ワークフロー（AI提案）"),
    ).toBeInTheDocument();
    expect(screen.getByText(/ジャービスが提案 · 2026-08-10/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "提案理由を見る" }));
    expect(
      screen.getByText("既存フェーズの完了状況を踏まえた提案理由です。"),
    ).toBeInTheDocument();
  });

  it("approves a pending proposal into a confirmed phase", async () => {
    const get = gap022Get({
      proposals: () => ({ data: [PENDING_PROPOSAL] }),
    });
    const post = vi.fn(async () => ({
      data: {
        proposal: { id: "pp1", status: "approved" },
        phase: { id: "ph9", name: "工程ワークフロー", order: 3 },
      },
    }));
    const client = {
      get,
      post,
      patch: vi.fn(),
      delete: vi.fn(),
      put: vi.fn(),
      request: vi.fn(),
    };
    renderWithQuery(
      <PhaseListContainer projectId="p1" client={client as never} />,
    );
    fireEvent.click(await screen.findByRole("button", { name: "承認" }));
    await waitFor(() => expect(post).toHaveBeenCalledTimes(1));
    const [path] = post.mock.calls[0]! as unknown as [string];
    expect(path).toBe("/workflow/phase-proposals/{proposal_id}/approve");
    expect(
      await screen.findByText(
        "提案を承認し、第 3 段階「工程ワークフロー」を確定しました。",
      ),
    ).toBeInTheDocument();
  });

  it("rejects a pending proposal without creating a phase", async () => {
    const get = gap022Get({
      proposals: () => ({ data: [PENDING_PROPOSAL] }),
    });
    const post = vi.fn(async () => ({ data: { id: "pp1", status: "rejected" } }));
    const client = {
      get,
      post,
      patch: vi.fn(),
      delete: vi.fn(),
      put: vi.fn(),
      request: vi.fn(),
    };
    renderWithQuery(
      <PhaseListContainer projectId="p1" client={client as never} />,
    );
    fireEvent.click(await screen.findByRole("button", { name: "却下" }));
    await waitFor(() => expect(post).toHaveBeenCalledTimes(1));
    const [path] = post.mock.calls[0]! as unknown as [string];
    expect(path).toBe("/workflow/phase-proposals/{proposal_id}/reject");
    expect(
      await screen.findByText("提案を却下しました（フェーズは作成されません）。"),
    ).toBeInTheDocument();
  });

  it("runs the F-IMP01 impact analysis and applies it with auto refactor tasks", async () => {
    const get = gap022Get();
    const post = vi.fn(async (path: string) => {
      if (path === "/workflow/impact-analysis")
        return {
          data: {
            id: "ia1",
            task_title: "T-042 実装",
            target_phase_name: "設計",
            affected: [
              { id: "t55", title: "T-055", lifecycle_stage: "done" },
              { id: "t61", title: "T-061", lifecycle_stage: "triage" },
            ],
            done_count: 1,
            applied: false,
          },
        };
      if (path === "/workflow/impact-analysis/{analysis_id}/apply")
        return {
          data: {
            task_id: "t42",
            moved_to_phase_id: "ph1",
            refactor_task_ids: ["r1"],
          },
        };
      return { data: {} };
    });
    const client = {
      get,
      post,
      patch: vi.fn(),
      delete: vi.fn(),
      put: vi.fn(),
      request: vi.fn(),
    };
    renderWithQuery(
      <PhaseListContainer projectId="p1" client={client as never} />,
    );
    fireEvent.change(
      await screen.findByLabelText("影響解析の対象タスク"),
      { target: { value: "t42" } },
    );
    fireEvent.change(screen.getByLabelText("移動先フェーズ"), {
      target: { value: "ph1" },
    });
    fireEvent.click(screen.getByRole("button", { name: "影響を解析" }));
    // 実解析結果が描画される (影響ノード + 完了済のリファクタ注記)
    expect(
      await screen.findByText(/2 タスクへの影響を検出（実装済み 1 \/ その他 1）/),
    ).toBeInTheDocument();
    expect(screen.getByText("T-055")).toBeInTheDocument();
    expect(
      screen.getByText("リファクタタスクとして自動起票"),
    ).toBeInTheDocument();
    const [analyzePath, analyzeInit] = post.mock.calls[0]! as unknown as [
      string,
      { body: { task_id: string; target_phase_id: string } },
    ];
    expect(analyzePath).toBe("/workflow/impact-analysis");
    expect(analyzeInit.body).toEqual({ task_id: "t42", target_phase_id: "ph1" });

    fireEvent.click(screen.getByRole("button", { name: "承認して移動" }));
    expect(
      await screen.findByText(
        "タスクを移動し、リファクタタスク 1 件を自動起票しました（F-CUC02）。",
      ),
    ).toBeInTheDocument();
    expect(screen.getByText("適用済み")).toBeInTheDocument();
  });

  it("renders the real workflow stats (提案中 / F-IMP01 実行回数 / 整合性)", async () => {
    const get = gap022Get({
      proposals: () => ({ data: [PENDING_PROPOSAL] }),
    });
    renderWithQuery(
      <PhaseListContainer projectId="p1" client={fakeClient({ get })} />,
    );
    await screen.findByText("設計");
    expect(await screen.findByText("提案中")).toBeInTheDocument();
    expect(screen.getByText("12 回（本日）")).toBeInTheDocument();
    expect(screen.getByText("依存整合性チェック")).toBeInTheDocument();
    expect(screen.getByText("OK")).toBeInTheDocument();
  });
});
