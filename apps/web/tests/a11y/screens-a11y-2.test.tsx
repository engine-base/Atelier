/**
 * a11y (axe) 追加バッチ — 配線済み画面の網羅カバレッジ（0 critical/serious）。
 *
 * screens-a11y.test.tsx（8画面）に加え、主要な残り画面を axe 検証する。
 */

// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import "vitest-axe/extend-expect";

import * as React from "react";
import { render, screen } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";
import { type ApiClient } from "@atelier/api-client";
import { axe } from "vitest-axe";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createQueryClient } from "../../lib/query-client";
import { ApprovalsContainer } from "../../app/approvals/s_j01/_components/ApprovalsContainer";
import { CronScheduleContainer } from "../../app/cron/s_o01/_components/CronScheduleContainer";
import { OrgChartContainer } from "../../app/employees/s_c01/_components/OrgChartContainer";
import { TaskBoardContainer } from "../../app/tasks/s_i01/_components/TaskBoardContainer";
import { WorkflowGraphContainer } from "../../app/workflow/s_f01/_components/WorkflowGraphContainer";
import { WorkspaceSettingsContainer } from "../../app/auth/s_a03/_components/WorkspaceSettingsContainer";
import { ProjectDashboardContainer } from "../../app/projects/s_b02/_components/ProjectDashboardContainer";
import { WorkspaceSwitcherContainer } from "../../app/t-uc-38/_components/WorkspaceSwitcherContainer";
import { ProjectSwitcherContainer } from "../../app/t-uc-39/_components/ProjectSwitcherContainer";
import { ClientProjectViewContainer } from "../../app/client/s_l03/_components/ClientProjectViewContainer";

function renderWithQuery(ui: React.ReactElement) {
  const qc = createQueryClient();
  return render(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>);
}

function fakeClient(get: unknown): ApiClient {
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

async function expectNoSeriousViolations(
  container: HTMLElement,
): Promise<void> {
  const results = (await axe(container, { iframes: false })) as unknown as {
    violations: { impact?: string | null; id: string }[];
  };
  const serious = results.violations.filter(
    (v) => v.impact === "critical" || v.impact === "serious",
  );
  expect(serious, JSON.stringify(serious.map((v) => v.id))).toEqual([]);
}

afterEach(() => {
  vi.clearAllMocks();
  window.localStorage.clear();
});

describe("a11y 追加: 配線済み画面 axe (0 critical/serious)", () => {
  it("S-J01 承認インボックス", async () => {
    const get = vi.fn(async () => ({
      data: [
        {
          id: "a1",
          type: "task",
          title: "決裁A",
          payload: {},
          created_at: "2026-06-20T00:00:00Z",
        },
      ],
    }));
    const { container } = renderWithQuery(
      <ApprovalsContainer client={fakeClient(get)} />,
    );
    await screen.findByText("決裁A");
    await expectNoSeriousViolations(container);
  });

  it("S-O01 自動スケジュール", async () => {
    const get = vi.fn(async () => ({
      data: [
        {
          id: "j1",
          name: "JobA",
          cron_expression: "0 9 * * *",
          enabled: true,
          next_run_at: null,
        },
      ],
    }));
    const { container } = renderWithQuery(
      <CronScheduleContainer projectId="p1" client={fakeClient(get)} />,
    );
    await screen.findByText("JobA");
    await expectNoSeriousViolations(container);
  });

  it("S-C01 組織図", async () => {
    const get = vi.fn(async () => ({
      data: [{ id: "e1", name: "tony", display_name: "トニー", department: "executive" }],
    }));
    const { container } = renderWithQuery(
      <OrgChartContainer client={fakeClient(get)} />,
    );
    await screen.findByText("トニー");
    await expectNoSeriousViolations(container);
  });

  it("S-I01 タスクボード", async () => {
    const get = vi.fn(async () => ({
      data: [{ id: "t1", title: "API 設計", lifecycle_stage: "ready" }],
    }));
    const { container } = renderWithQuery(
      <TaskBoardContainer projectId="p1" client={fakeClient(get)} />,
    );
    await screen.findByText("API 設計");
    await expectNoSeriousViolations(container);
  });

  it("S-F01 工程ワークフロー", async () => {
    const get = vi.fn(async () => ({
      data: [
        { id: "ph1", name: "要件定義", status: "completed", order_index: 1 },
      ],
    }));
    const { container } = renderWithQuery(
      <WorkflowGraphContainer projectId="p1" client={fakeClient(get)} />,
    );
    // 要件定義 = 選択中工程: フローバーのノードと工程ヘッダー h1 の両方に出る
    await screen.findAllByText("要件定義");
    await expectNoSeriousViolations(container);
  });

  it("S-A03 ワークスペース設定", async () => {
    const get = vi.fn(async () => ({ data: { name: "My WS" } }));
    const { container } = renderWithQuery(
      <WorkspaceSettingsContainer workspaceId="w1" client={fakeClient(get)} />,
    );
    await screen.findByDisplayValue("My WS");
    await expectNoSeriousViolations(container);
  });

  it("S-B02 プロジェクトダッシュボード", async () => {
    const get = vi.fn(async () => ({
      data: {
        name: "Atelier",
        current_phase: "設計",
        task_counts: { in_progress: 3, done: 5 },
      },
    }));
    const { container } = renderWithQuery(
      <ProjectDashboardContainer projectId="p1" client={fakeClient(get)} />,
    );
    // 新デザイン: プロジェクト名はサブタイトル側
    await screen.findByText("Atelier");
    await expectNoSeriousViolations(container);
  });

  it("T-UC-38 ワークスペース切替", async () => {
    const get = vi.fn(async () => ({ data: [{ id: "w1", name: "Alpha 社" }] }));
    const { container } = renderWithQuery(
      <WorkspaceSwitcherContainer client={fakeClient(get)} />,
    );
    await screen.findAllByText("Alpha 社");
    await expectNoSeriousViolations(container);
  });

  it("T-UC-39 プロジェクト切替", async () => {
    const get = vi.fn(async () => ({
      data: [{ id: "p1", name: "Alpha 案件" }],
    }));
    const { container } = renderWithQuery(
      <ProjectSwitcherContainer client={fakeClient(get)} />,
    );
    await screen.findAllByText("Alpha 案件");
    await expectNoSeriousViolations(container);
  });

  it("S-L03 クライアントプロジェクトビュー", async () => {
    const fetchProject = vi.fn(async () => ({
      id: "p1",
      name: "ACME 案件",
      description: "限定ビュー",
      scopes: ["view", "comment"],
      viewed_as_client_display_name: "山田",
    }));
    const { container } = renderWithQuery(
      <ClientProjectViewContainer
        projectId="p1"
        getToken={() => "ct"}
        fetchProject={fetchProject}
      />,
    );
    await screen.findByRole("heading", { name: "ACME 案件" });
    await expectNoSeriousViolations(container);
  });
});
