/**
 * T-UC-25 — S-O01 自動スケジュール 配線テスト
 *
 * fake client を注入し real API を叩かずに検証する:
 *   - GET /cron-schedules?project_id の一覧描画
 *   - 有効トグルで PATCH /cron-schedules/{id} {enabled}
 *   - 即時実行列は出さない（バックエンド未対応）
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
import { CronScheduleContainer } from "../../app/cron/s_o01/_components/CronScheduleContainer";

function renderWithQuery(ui: React.ReactElement) {
  const qc = createQueryClient();
  return render(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>);
}

function apiError(status: number): ApiError {
  return new ApiError({
    status,
    statusText: "x",
    payload: undefined,
    path: "/c",
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

const JOBS = [
  {
    id: "j1",
    name: "昇格レビュー集約",
    cron_expression: "0 9 * * *",
    enabled: true,
    next_run_at: "2026-06-21T09:00:00Z",
  },
];

afterEach(() => vi.clearAllMocks());

describe("S-O01 CronScheduleContainer (T-UC-25)", () => {
  it("renders cron jobs for the project and hides the run-now column", async () => {
    const get = vi.fn(async () => ({ data: JOBS }));
    renderWithQuery(
      <CronScheduleContainer projectId="p1" client={fakeClient({ get })} />,
    );
    // v2: 次に動くスケジュール (upcoming) とグループ行の両方に出る
    expect((await screen.findAllByText("昇格レビュー集約")).length).toBeGreaterThan(0);
    expect(screen.queryByRole("button", { name: /今すぐ実行/ })).toBeNull();
    const init = (
      get.mock.calls[0] as unknown as [
        string,
        { params: { query: { project_id: string } } },
      ]
    )[1];
    expect(init.params.query.project_id).toBe("p1");
  });

  it("toggles enabled via PATCH /cron-schedules/{id}", async () => {
    const get = vi.fn(async () => ({ data: JOBS }));
    const patch = vi.fn(async () => ({ data: {} }));
    renderWithQuery(
      <CronScheduleContainer
        projectId="p1"
        client={fakeClient({ get, patch })}
      />,
    );
    fireEvent.click(
      await screen.findByLabelText(/昇格レビュー集約 を 無効 化/),
    );
    await waitFor(() => expect(patch).toHaveBeenCalledTimes(1));
    const [path, init] = patch.mock.calls[0]! as unknown as [
      string,
      { params: { path: { schedule_id: string } }; body: { enabled: boolean } },
    ];
    expect(path).toBe("/cron-schedules/{schedule_id}");
    expect(init.params.path.schedule_id).toBe("j1");
    expect(init.body.enabled).toBe(false);
  });

  it("shows empty state when there are no schedules", async () => {
    const get = vi.fn(async () => ({ data: [] }));
    renderWithQuery(
      <CronScheduleContainer projectId="p1" client={fakeClient({ get })} />,
    );
    expect(
      await screen.findByText("スケジュールがまだありません。"),
    ).toBeInTheDocument();
  });

  it("shows a forbidden message on 403", async () => {
    const get = vi.fn(async () => {
      throw apiError(403);
    });
    renderWithQuery(
      <CronScheduleContainer projectId="p1" client={fakeClient({ get })} />,
    );
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "権限がありません",
    );
  });
});

// ── v2 (モック忠実再構築): cron 日本語ラベル / グループ / upcoming ────────

import { cronLabel } from "../../app/cron/s_o01/_components/CronSchedule";

describe("S-O01 v2: cronLabel", () => {
  it("translates common cron patterns to Japanese", () => {
    expect(cronLabel("0 2 * * *")).toBe("毎日 深夜 2:00");
    expect(cronLabel("30 3 * * *")).toBe("毎日 深夜 3:30");
    expect(cronLabel("0 5 * * *")).toBe("毎日 朝 5:00");
    expect(cronLabel("0 4 * * 1")).toBe("毎週 月曜 4:00");
    expect(cronLabel("0 9 1 * *")).toBe("毎月 1 日 朝 9:00");
    expect(cronLabel("0 * * * *")).toBe("毎時 0 分");
    expect(cronLabel("*/5 * * * *")).toBe("*/5 * * * *"); // 未対応は素通し
  });
});

describe("S-O01 v2: グループ + upcoming", () => {
  const RICH = [
    {
      id: "j1",
      name: "夜間タスク再生",
      cron_expression: "0 2 * * *",
      enabled: true,
      next_run_at: "2099-01-01T02:00:00Z",
      target_action: "task_replay",
    },
    {
      id: "j2",
      name: "ナレッジ整理",
      cron_expression: "30 3 * * *",
      enabled: true,
      next_run_at: "2099-01-01T03:30:00Z",
      target_action: "knowledge_organize",
    },
    {
      id: "j3",
      name: "月次レポート",
      cron_expression: "0 9 1 * *",
      enabled: false,
      next_run_at: null,
      target_action: "report_summary",
    },
  ];

  it("groups rows by action category and shows upcoming for enabled jobs", async () => {
    const get = vi.fn(async () => ({ data: RICH }));
    renderWithQuery(
      <CronScheduleContainer projectId="p1" client={fakeClient({ get })} />,
    );
    await screen.findByText("次に動くスケジュール");
    // グループ見出し
    expect(screen.getByText("実装の夜間自動進行")).toBeInTheDocument();
    expect(screen.getByText("ナレッジ整理（ティチャラ）")).toBeInTheDocument();
    expect(screen.getByText("通知・レポート配信")).toBeInTheDocument();
    // 無効ジョブ (j3) は upcoming に出ない = 「月次レポート」は 1 箇所のみ
    expect(screen.getAllByText("月次レポート")).toHaveLength(1);
    // 有効ジョブは upcoming + 行の 2 箇所
    expect(screen.getAllByText("夜間タスク再生")).toHaveLength(2);
    // 人間可読ラベル
    expect(screen.getAllByText("毎日 深夜 2:00").length).toBeGreaterThan(0);
  });
});
