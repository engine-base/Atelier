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
import { CronSchedule } from "../../app/cron/s_o01/_components/CronSchedule";

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
    // GAP-185: 止まったもの・待ちきれないものを人の操作で進められる
    // (以前はバックエンドが無かったのでボタン自体を出していなかった)
    expect(
      screen.getByRole("button", { name: /今すぐ実行/ }),
    ).toBeInTheDocument();
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
    // GAP-014: 空でも早期 return せず CronSchedule 側の空表示になる
    // (法令・運用バックエンド節をスケジュール有無に関係なく出すため)
    const get = vi.fn(async () => ({ data: [] }));
    renderWithQuery(
      <CronScheduleContainer projectId="p1" client={fakeClient({ get })} />,
    );
    expect(
      await screen.findByText("スケジュールされたジョブはありません"),
    ).toBeInTheDocument();
  });

  it("renders the legal platform jobs section from GET /cron-platform-jobs (GAP-014)", async () => {
    const get = vi.fn(async (path: string) =>
      path === "/cron-platform-jobs"
        ? {
            data: [
              {
                name: "purge-deleted-accounts",
                category: "legal",
                required: true,
                title: "退会データを 30 日後に完全削除",
                description: "個人情報保護法に基づく削除義務。",
                cron: "0 15 * * *",
                schedule_label: "毎日 深夜 0:00 (JST)",
                next_run_at: "2026-08-05T15:00:00Z",
                last_run: {
                  started_at: "2026-08-04T15:00:00Z",
                  finished_at: "2026-08-04T15:00:02Z",
                  status: "success",
                },
              },
              {
                name: "integrity-check",
                category: "legal",
                required: true,
                title: "データ整合性チェック",
                description: "依存・AC・モック・工程担当の矛盾を検出。",
                cron: "0 20 * * *",
                schedule_label: "毎日 朝 5:00 (JST)",
                next_run_at: null,
                last_run: null,
              },
            ],
          }
        : path === "/cron-schedules"
          ? { data: JOBS }
          : { data: [] },
    );
    renderWithQuery(
      <CronScheduleContainer projectId="p1" client={fakeClient({ get })} />,
    );
    const section = await screen.findByRole("region", {
      name: "法令・運用バックエンド",
    });
    expect(section).toHaveTextContent("退会データを 30 日後に完全削除");
    expect(section).toHaveTextContent("データ整合性チェック");
    expect(section).toHaveTextContent("無効化不可");
    expect(section).toHaveTextContent("0 15 * * *");
    expect(section).toHaveTextContent("最終実行 成功");
    // 未実行のジョブは偽装せず「未実行」
    expect(section).toHaveTextContent("最終実行 未実行");
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
    const get = vi.fn(async (path: unknown) =>
      path === "/cron-runs" ? { data: [] } : { data: RICH },
    );
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

describe("S-O01 実行履歴 (GAP-013)", () => {
  it("runs prop で履歴テーブルを描画 (成功/失敗/実行中 + 所要時間)", () => {
    render(
      <CronSchedule
        jobs={[]}
        onToggle={() => undefined}
        runs={[
          {
            id: "r1",
            name: "transcribe-queue",
            startedAt: "2026-08-03T02:00:00Z",
            finishedAt: "2026-08-03T02:00:12Z",
            status: "success",
          },
          {
            id: "r2",
            name: "daily-digest",
            startedAt: "2026-08-03T01:00:00Z",
            finishedAt: "2026-08-03T01:00:03Z",
            status: "error",
          },
          {
            id: "r3",
            name: "weekly-burndown",
            startedAt: "2026-08-03T03:00:00Z",
            finishedAt: null,
            status: "running",
          },
        ]}
      />,
    );
    expect(screen.getByText(/実行履歴（直近 3 件）/)).toBeInTheDocument();
    expect(screen.getByText("transcribe-queue")).toBeInTheDocument();
    expect(screen.getByText("12 秒")).toBeInTheDocument();
    expect(screen.getByText("成功")).toBeInTheDocument();
    expect(screen.getByText("失敗")).toBeInTheDocument();
    expect(screen.getByText("実行中")).toBeInTheDocument();
  });

  it("runs 未指定なら履歴セクションを出さない (Rule 10) / 空配列は空状態", () => {
    const { rerender } = render(<CronSchedule jobs={[]} onToggle={() => undefined} />);
    expect(screen.queryByText(/実行履歴/)).toBeNull();
    rerender(<CronSchedule jobs={[]} onToggle={() => undefined} runs={[]} />);
    expect(screen.getByText(/実行履歴はまだありません/)).toBeInTheDocument();
  });
});

/* ------------------------------------------------------------------ */
/* GAP-193: 取りこぼした自動実行を黙って消さない                        */
/* ------------------------------------------------------------------ */

describe("GAP-193 取りこぼしの可視化", () => {
  it("PC を止めていた間に過ぎた定刻の回数を実行履歴に出す", () => {
    render(
      <CronSchedule
        jobs={[]}
        onToggle={() => undefined}
        runs={[
          {
            id: "r1",
            name: "毎朝の進捗ダイジェスト",
            startedAt: "2026-08-20T00:00:00Z",
            finishedAt: "2026-08-20T00:00:03Z",
            status: "success",
            skippedOccurrences: 2,
          },
        ]}
      />,
    );
    expect(screen.getByText("2 回分を未実行")).toBeInTheDocument();
  });

  it("取りこぼしが無いときは余計な表示を出さない", () => {
    render(
      <CronSchedule
        jobs={[]}
        onToggle={() => undefined}
        runs={[
          {
            id: "r2",
            name: "毎朝の進捗ダイジェスト",
            startedAt: "2026-08-20T00:00:00Z",
            finishedAt: "2026-08-20T00:00:03Z",
            status: "success",
            skippedOccurrences: 0,
          },
        ]}
      />,
    );
    expect(screen.queryByText(/回分を未実行/)).toBeNull();
  });
});
