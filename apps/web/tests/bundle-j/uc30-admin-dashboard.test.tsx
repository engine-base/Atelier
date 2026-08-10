/**
 * T-UC-30 — S-T01 運営ダッシュボード 配線テスト
 *
 * fake client を注入し real API を叩かずに検証する:
 *   - GET /admin/dashboard の集計を KPI へ
 *   - GET /admin/audit-logs の直近を最近のアクティビティへ
 *   - 403（admin 専用）
 */

// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";

import * as React from "react";
import { render, screen, within } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";
import { ApiError, type ApiClient } from "@atelier/api-client";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createQueryClient } from "../../lib/query-client";
import { AdminDashboardContainer } from "../../app/admin/s_t01/_components/AdminDashboardContainer";

function renderWithQuery(ui: React.ReactElement) {
  const qc = createQueryClient();
  return render(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>);
}

function apiError(status: number): ApiError {
  return new ApiError({
    status,
    statusText: "x",
    payload: undefined,
    path: "/admin",
    method: "get",
  });
}

function fakeClient(get: unknown): ApiClient {
  const noop = vi.fn(async () => ({ data: {} }));
  return {
    get,
    post: noop,
    patch: noop,
    delete: noop,
    put: noop,
    request: noop,
  } as unknown as ApiClient;
}

afterEach(() => vi.clearAllMocks());

describe("S-T01 AdminDashboardContainer (T-UC-30)", () => {
  it("maps dashboard counts to KPIs and audit logs to recent activity", async () => {
    const get = vi.fn(async (path: string) =>
      path.includes("dashboard")
        ? {
            data: {
              workspace_count: 42,
              project_count: 108,
              ai_employee_count: 7,
            },
          }
        : {
            data: [
              {
                id: "a1",
                action: "project.create",
                actor_id: "tony",
                created_at: "2026-06-20T05:00:00Z",
              },
            ],
          },
    );
    renderWithQuery(<AdminDashboardContainer client={fakeClient(get)} />);

    const kpi = await screen.findByRole("region", { name: "KPI" });
    expect(within(kpi).getByText("ワークスペース数")).toBeInTheDocument();
    expect(within(kpi).getByText("42")).toBeInTheDocument();
    expect(within(kpi).getByText("AI 社員数")).toBeInTheDocument();

    const recent = screen.getByRole("region", { name: "最近のアクティビティ" });
    expect(within(recent).getByText("project.create")).toBeInTheDocument();
  });

  it("shows a forbidden message on 403", async () => {
    const get = vi.fn(async () => {
      throw apiError(403);
    });
    renderWithQuery(<AdminDashboardContainer client={fakeClient(get)} />);
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "運営 admin 専用",
    );
  });
});

/** GAP-019 標準系 get: 全セクションの実データ形状を返す。 */
function gap019Get() {
  return vi.fn(async (path: string): Promise<{ data: unknown }> => {
    if (path === "/admin/dashboard")
      return {
        data: {
          workspace_count: 13,
          project_count: 28,
          ai_employee_count: 130,
          audit_log_count_24h: 55,
        },
      };
    if (path === "/admin/mission")
      return {
        data: {
          goal: {
            title: "100 社獲得",
            target_count: 100,
            deadline: "2026-12-31",
            note: "想定 ARR ¥36M",
          },
          current_count: 13,
          added_30d: 8,
          remaining: 87,
          months_left: 4,
          needed_per_month: 22,
        },
      };
    if (path === "/admin/platform-stats")
      return {
        data: {
          task_executions_30d: 1247,
          avg_score_30d: 0.91,
          beta_feedback_total: 42,
          beta_feedback_open: 5,
          bridge_connected: 9,
          users_total: 13,
          users_deleted_30d: 1,
          workspaces_added_30d: 8,
        },
      };
    if (path === "/admin/trends")
      return {
        data: {
          points: [
            { week_start: "2026-07-01", workspaces: 5, projects: 10 },
            { week_start: "2026-07-08", workspaces: 8, projects: 16 },
            { week_start: "2026-07-15", workspaces: 13, projects: 28 },
          ],
          billing_enabled: false,
          mrr_yen: 0,
        },
      };
    if (path === "/admin/acquisitions")
      return {
        data: {
          channels: [
            { channel: "referral", count: 5 },
            { channel: "sns", count: 2 },
          ],
          recent: [
            { id: "aq1", channel: "referral", note: "", occurred_on: "2026-08-09" },
          ],
          total: 7,
        },
      };
    if (path === "/admin/health")
      return {
        data: [
          {
            name: "API ↔ DB 接続",
            status: "ok",
            detail: "DB roundtrip 3ms (実測)",
            meta: "正常",
          },
          {
            name: "Resend (メール)",
            status: "warn",
            detail: "ATELIER_EMAIL_API_KEY 未設定",
            meta: "未設定",
          },
        ],
      };
    if (path === "/admin/beta-feedback")
      return {
        data: [
          {
            id: "fb1",
            email: "matsumoto@example.com",
            category: "bug",
            content: "再生を連打するとエラー",
            status: "open",
            created_at: "2026-08-10T06:00:00Z",
          },
        ],
      };
    if (path === "/admin/costs")
      return {
        data: {
          month: "2026-08-01",
          total_yen: 906,
          items: [
            { id: "c1", name: "Fly.io", description: "夜間停止", amount_yen: 328 },
            { id: "c2", name: "Claude API", description: "", amount_yen: 578 },
          ],
        },
      };
    if (path === "/admin/users") return { data: [] };
    return { data: [] };
  });
}

function gap019Client(get: unknown, extra?: Partial<Record<"post" | "put" | "delete", unknown>>) {
  const noop = vi.fn(async () => ({ data: {} }));
  return {
    get,
    post: extra?.post ?? noop,
    patch: noop,
    delete: extra?.delete ?? noop,
    put: extra?.put ?? noop,
    request: noop,
  } as unknown as ApiClient;
}

describe("S-T01 GAP-019 (mission / trends / channels / health / FB / costs)", () => {
  it("renders the mission hero from the recorded goal + real pace", async () => {
    renderWithQuery(<AdminDashboardContainer client={gap019Client(gap019Get())} />);
    const hero = await screen.findByRole("region", { name: "ミッション" });
    expect(within(hero).getByText(/100 社獲得/)).toBeInTheDocument();
    expect(within(hero).getByText("87 社")).toBeInTheDocument();
    expect(within(hero).getByText("22 社")).toBeInTheDocument();
    expect(within(hero).getByText("+8 社 / 月")).toBeInTheDocument();
    expect(within(hero).getByText("想定 ARR ¥36M")).toBeInTheDocument();
  });

  it("shows the goal form when no goal is recorded and PUTs /admin/goal", async () => {
    const get = gap019Get();
    get.mockImplementation(async (path: string) => {
      if (path === "/admin/mission")
        return { data: { goal: null, current_count: 3, added_30d: 1 } };
      return gap019Get().getMockImplementation()!(path);
    });
    const put = vi.fn(async () => ({ data: {} }));
    const { getByLabelText, getByRole, findByText } = within(document.body);
    renderWithQuery(<AdminDashboardContainer client={gap019Client(get, { put })} />);
    expect(await findByText("獲得目標が未設定です")).toBeInTheDocument();
    const { fireEvent } = await import("@testing-library/react");
    fireEvent.change(getByLabelText("目標タイトル"), { target: { value: "100 社獲得" } });
    fireEvent.change(getByLabelText("目標数"), { target: { value: "100" } });
    fireEvent.change(getByLabelText("期限"), { target: { value: "2026-12-31" } });
    fireEvent.click(getByRole("button", { name: "目標を記録" }));
    const { waitFor } = await import("@testing-library/react");
    await waitFor(() => expect(put).toHaveBeenCalledTimes(1));
    const [path, init] = put.mock.calls[0]! as unknown as [
      string,
      { body: Record<string, unknown> },
    ];
    expect(path).toBe("/admin/goal");
    expect(init.body).toEqual({
      title: "100 社獲得",
      target_count: 100,
      deadline: "2026-12-31",
    });
  });

  it("renders extended KPI bento from platform-stats", async () => {
    renderWithQuery(<AdminDashboardContainer client={gap019Client(gap019Get())} />);
    const kpi = await screen.findByRole("region", { name: "KPI" });
    expect(within(kpi).getByText("タスク実行 / 30日")).toBeInTheDocument();
    expect(within(kpi).getByText("1247")).toBeInTheDocument();
    expect(within(kpi).getByText("平均スコア 0.91")).toBeInTheDocument();
    expect(within(kpi).getByText("未対応 5")).toBeInTheDocument();
    expect(within(kpi).getByText("稼働 Bridge 数")).toBeInTheDocument();
  });

  it("renders the real weekly trend + honest MRR note", async () => {
    renderWithQuery(<AdminDashboardContainer client={gap019Client(gap019Get())} />);
    expect(
      await screen.findByRole("img", { name: "週次トレンド" }),
    ).toBeInTheDocument();
    expect(
      screen.getByText("MRR: ¥0（課金未導入 — ベータ無料運用中のため実額）"),
    ).toBeInTheDocument();
  });

  it("renders channel bars from real records and posts a new acquisition", async () => {
    const post = vi.fn(async () => ({ data: {} }));
    renderWithQuery(
      <AdminDashboardContainer client={gap019Client(gap019Get(), { post })} />,
    );
    expect((await screen.findAllByText("紹介・口コミ")).length).toBeGreaterThan(0);
    expect(screen.getByText("5 件")).toBeInTheDocument();
    const { fireEvent, waitFor } = await import("@testing-library/react");
    fireEvent.change(screen.getByLabelText("獲得チャネル"), {
      target: { value: "sns" },
    });
    fireEvent.click(screen.getByRole("button", { name: "獲得を記録" }));
    await waitFor(() => expect(post).toHaveBeenCalled());
    const [path, init] = post.mock.calls[0]! as unknown as [
      string,
      { body: { channel: string } },
    ];
    expect(path).toBe("/admin/acquisitions");
    expect(init.body.channel).toBe("sns");
  });

  it("renders real health checks (measurements + config facts)", async () => {
    renderWithQuery(<AdminDashboardContainer client={gap019Client(gap019Get())} />);
    expect(await screen.findByText("API ↔ DB 接続")).toBeInTheDocument();
    expect(screen.getByText("DB roundtrip 3ms (実測)")).toBeInTheDocument();
    expect(screen.getByText("ATELIER_EMAIL_API_KEY 未設定")).toBeInTheDocument();
  });

  it("renders beta feedback and resolves it", async () => {
    const post = vi.fn(async () => ({ data: {} }));
    renderWithQuery(
      <AdminDashboardContainer client={gap019Client(gap019Get(), { post })} />,
    );
    expect(await screen.findByText("再生を連打するとエラー")).toBeInTheDocument();
    expect(screen.getByText("不具合")).toBeInTheDocument();
    const { fireEvent, waitFor } = await import("@testing-library/react");
    fireEvent.click(screen.getByRole("button", { name: "対応済みにする" }));
    await waitFor(() => expect(post).toHaveBeenCalled());
    const [path] = post.mock.calls[0]! as unknown as [string];
    expect(path).toBe("/admin/beta-feedback/{feedback_id}/resolve");
  });

  it("renders recorded costs with total and posts a new cost", async () => {
    const post = vi.fn(async () => ({ data: {} }));
    renderWithQuery(
      <AdminDashboardContainer client={gap019Client(gap019Get(), { post })} />,
    );
    expect(await screen.findByText("Fly.io")).toBeInTheDocument();
    expect(screen.getByText("¥906")).toBeInTheDocument();
    const { fireEvent, waitFor } = await import("@testing-library/react");
    fireEvent.change(screen.getByLabelText("コスト項目名"), {
      target: { value: "Sentry" },
    });
    fireEvent.change(screen.getByLabelText("金額 (円)"), {
      target: { value: "120" },
    });
    fireEvent.click(screen.getByRole("button", { name: "記録" }));
    await waitFor(() => expect(post).toHaveBeenCalled());
    const [path, init] = post.mock.calls[0]! as unknown as [
      string,
      { body: { name: string; amount_yen: number } },
    ];
    expect(path).toBe("/admin/costs");
    expect(init.body.name).toBe("Sentry");
    expect(init.body.amount_yen).toBe(120);
  });
});
