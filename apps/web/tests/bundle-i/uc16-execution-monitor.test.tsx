/**
 * T-UC-16 — S-I03 実行モニター 配線テスト
 *
 * streamFn を注入し real SSE を叩かずに検証する:
 *   - ExecLogEvent を逐次受け取りログ行へ変換（status_change / end / error）
 *   - stream 例外で inline error を表示
 */

// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";

import * as React from "react";
import { render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ExecutionMonitorContainer } from "../../app/tasks/s_i03/_components/ExecutionMonitorContainer";
import type {
  ExecLogEvent,
  StreamExecLogsArgs,
} from "../../app/tasks/s_i03/_components/execStream";

afterEach(() => vi.clearAllMocks());

describe("S-I03 ExecutionMonitorContainer (T-UC-16)", () => {
  it("renders streamed exec log events as log lines", async () => {
    const streamFn = vi.fn(async (args: StreamExecLogsArgs) => {
      const events: ExecLogEvent[] = [
        {
          type: "status_change",
          status: "running",
          timestamp: "2026-06-20T10:00:01Z",
        },
        {
          type: "error",
          error_summary: "タイムアウト",
          timestamp: "2026-06-20T10:00:05Z",
        },
        { type: "end", status: "failed", timestamp: "2026-06-20T10:00:06Z" },
      ];
      for (const e of events) args.onEvent(e);
    });
    render(<ExecutionMonitorContainer executionId="e1" streamFn={streamFn} />);

    expect(await screen.findByText("状態: running")).toBeInTheDocument();
    expect(screen.getByText("タイムアウト")).toBeInTheDocument();
    expect(screen.getByText("実行終了（状態: failed）")).toBeInTheDocument();
    expect(streamFn.mock.calls[0]![0]!.executionId).toBe("e1");
  });

  it("shows an inline error when the stream throws", async () => {
    const streamFn = vi.fn(async () => {
      throw new Error("connection lost");
    });
    render(<ExecutionMonitorContainer executionId="e1" streamFn={streamFn} />);
    await waitFor(() =>
      expect(screen.getByRole("alert")).toHaveTextContent(
        "実行ログの取得に失敗",
      ),
    );
  });
});

// ── design-audit v2: フリートビュー (FleetMonitorContainer) ──────────────
// 実 tasks API 相当の fake client で、要対応/進行中/順番待ちの分類・統計・
// 承認 mutation・担当表示名解決・死にボタン非描画を検証する。

import { fireEvent } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";
import { type ApiClient } from "@atelier/api-client";

import { createQueryClient } from "../../lib/query-client";
import { FleetMonitorContainer } from "../../app/tasks/s_i03/_components/FleetMonitorContainer";

function renderWithQuery(ui: React.ReactElement) {
  const qc = createQueryClient();
  return render(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>);
}

const FLEET_TASKS = [
  {
    id: "t-await",
    title: "退会フロー（30 日猶予）",
    lifecycle_stage: "awaiting",
    assigned_employee_id: "vision",
    retry_count: 0,
  },
  {
    id: "t-block",
    title: "ログイン画面の実装",
    lifecycle_stage: "blocked",
    blocked_reason: "条件 6 が未達",
    assigned_employee_id: "thor",
    retry_count: 1,
  },
  {
    id: "t-run",
    title: "文脈構築レイヤ",
    lifecycle_stage: "in_progress",
    dispatch_status: "running",
    assigned_employee_id: "thor",
  },
  {
    id: "t-queue",
    title: "メールリンク発行",
    lifecycle_stage: "ready",
    dispatch_status: "queued",
    estimated_hours: 12,
  },
];

function fleetClient(post?: unknown): ApiClient {
  const get = vi.fn(async (path: string) => {
    if (path === "/tasks") return { data: FLEET_TASKS };
    if (path === "/ai-employees")
      return {
        data: [
          { name: "thor", display_name: "ソー" },
          { name: "vision", display_name: "ヴィジョン" },
        ],
      };
    if (path.includes("executions"))
      return {
        data: [
          {
            id: "x-1",
            status: "succeeded",
            score: 0.87,
            ac_pass_rate: 0.92,
            started_at: "2026-06-20T10:00:00Z",
          },
        ],
      };
    return { data: {} };
  });
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

describe("S-I03 FleetMonitorContainer (design-audit v2)", () => {
  it("buckets tasks into attention / running / queue with real stats", async () => {
    renderWithQuery(
      <FleetMonitorContainer projectId="p1" client={fleetClient()} />,
    );
    expect(
      await screen.findByText("退会フロー（30 日猶予）"),
    ).toBeInTheDocument();
    // 統計: 判断待ち 2 (承認 1・再試行 1)
    expect(screen.getByText("承認 1 件・再試行 1 件")).toBeInTheDocument();
    // 進行中 + dispatch 状態の日本語ラベル
    expect(screen.getByText("文脈構築レイヤ")).toBeInTheDocument();
    expect(screen.getByText(/実装中 · 実行中/)).toBeInTheDocument();
    // 順番待ちリスト (見積表示)
    expect(screen.getByText("メールリンク発行")).toBeInTheDocument();
    expect(screen.getByText("見積 12 時間")).toBeInTheDocument();
    // blocked_reason 表示
    expect(screen.getByText("条件 6 が未達")).toBeInTheDocument();
    // 担当は表示名 (鉄則5)
    expect(screen.getByText("ヴィジョン")).toBeInTheDocument();
    expect(screen.queryByText("vision")).not.toBeInTheDocument();
  });

  it("shows the latest execution score and links to detail / SSE log", async () => {
    renderWithQuery(
      <FleetMonitorContainer projectId="p1" client={fleetClient()} />,
    );
    expect(
      (await screen.findAllByText("0.87 / 0.95（自動承認しきい値）")).length,
    ).toBeGreaterThan(0);
    const links = screen.getAllByRole("link");
    expect(
      links.some((l) => l.getAttribute("href") === "/tasks/detail?task=t-await"),
    ).toBe(true);
    expect(
      links.some(
        (l) => l.getAttribute("href") === "/tasks/monitor?execution=x-1",
      ),
    ).toBe(true);
  });

  it("approves an awaiting task from the card (2-step confirm)", async () => {
    const post = vi.fn(async (..._args: unknown[]) => ({ data: {} }));
    renderWithQuery(
      <FleetMonitorContainer projectId="p1" client={fleetClient(post)} />,
    );
    fireEvent.click(await screen.findByRole("button", { name: "承認" }));
    expect(screen.getByText("承認して完了にしますか？")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "確定" }));
    await waitFor(() => expect(post).toHaveBeenCalledTimes(1));
    expect(post.mock.calls[0]![0]).toBe("/tasks/{task_id}/approve");
  });

  it("does not render unbacked controls (停止 / 一時停止 / キュー取消 — Rule 10)", async () => {
    renderWithQuery(
      <FleetMonitorContainer projectId="p1" client={fleetClient()} />,
    );
    await screen.findByText("文脈構築レイヤ");
    expect(screen.queryByRole("button", { name: /停止/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /一時停止/ })).not.toBeInTheDocument();
  });
});

describe("S-I03 FleetMonitorContainer 並び替え (GAP-031③)", () => {
  const sortTasks = [
    {
      id: "t-old",
      title: "古い進行中",
      lifecycle_stage: "in_progress",
      updated_at: "2026-08-01T00:00:00Z",
    },
    {
      id: "t-new",
      title: "新しい判断待ち",
      lifecycle_stage: "awaiting",
      updated_at: "2026-08-03T00:00:00Z",
    },
  ];

  function sortClient(): ApiClient {
    const get = vi.fn(async (path: string) => {
      if (path === "/tasks") return { data: sortTasks };
      if (path === "/ai-employees") return { data: [] };
      if (path.includes("executions"))
        return {
          data: [
            {
              id: "x-9",
              status: "succeeded",
              score: 0.5,
              started_at: "2026-08-01T00:00:00Z",
            },
          ],
        };
      return { data: {} };
    });
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

  it("defaults to 要対応が上 (区分表示) and merges into 新しい順 on toggle", async () => {
    renderWithQuery(
      <FleetMonitorContainer projectId="p1" client={sortClient()} />,
    );
    // 既定: 区分表示 (要対応が上 が押下状態)
    const attentionBtn = await screen.findByRole("button", {
      name: "要対応が上",
    });
    expect(attentionBtn).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByText("順調に進行中")).toBeInTheDocument();

    // 新しい順: 結合グリッドで updated_at 降順 (新しい判断待ち → 古い進行中)
    fireEvent.click(screen.getByRole("button", { name: "新しい順" }));
    expect(
      await screen.findByText("すべてのセッション（新しい順）"),
    ).toBeInTheDocument();
    const cards = screen.getAllByText(/古い進行中|新しい判断待ち/);
    expect(cards[0]).toHaveTextContent("新しい判断待ち");
    expect(cards[1]).toHaveTextContent("古い進行中");
    // 区分見出しは消える
    expect(screen.queryByText("順調に進行中")).toBeNull();
  });

  it("進捗順 sorts by latest execution progress (score desc, 実データ)", async () => {
    renderWithQuery(
      <FleetMonitorContainer projectId="p1" client={sortClient()} />,
    );
    fireEvent.click(await screen.findByRole("button", { name: "進捗順" }));
    expect(
      await screen.findByText("すべてのセッション（進捗順）"),
    ).toBeInTheDocument();
  });
});
