/**
 * GAP-179 — 自動スケジュール画面がコスト表示を API から取ること。
 *
 * 直前の実態: 画面に「BYOK API 使用」と直書きされており、しかもその自動実行は
 * 一度も実行されていなかった (費用の嘘 + 動作の嘘)。ここでは
 *   - 説明/コスト/担当は GET /cron-actions 由来であること
 *   - 取得できない場合は推測で書かないこと
 *   - 保留 (deferred) を「失敗」と書かないこと
 *   - 停止中に「次回」を出さないこと
 * を固定する。
 */

// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";

import * as React from "react";
import { render, screen, waitFor } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";
import { type ApiClient } from "@atelier/api-client";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createQueryClient } from "../../lib/query-client";
import { CronScheduleContainer } from "../../app/cron/s_o01/_components/CronScheduleContainer";
import {
  CronSchedule,
  runStatusLabel,
} from "../../app/cron/s_o01/_components/CronSchedule";

function renderWithQuery(ui: React.ReactElement) {
  const qc = createQueryClient();
  return render(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>);
}

const SCHEDULES = [
  {
    id: "s1",
    name: "ナレッジ整理",
    cron_expression: "0 9 * * *",
    enabled: true,
    next_run_at: "2026-09-01T00:00:00Z",
    target_action: "knowledge_organize",
  },
];

const ACTIONS = [
  {
    action: "knowledge_organize",
    title: "ナレッジ整理",
    description: "カテゴリやタグが未整備のナレッジに、分類とタグを付けます。",
    group: "knowledge",
    staff: "ティチャラ",
    requires_bridge: true,
    cost_label: "本人の Claude プラン枠",
    cost_note: "あなたの PC の Claude Code で実行します。",
  },
];

function routedClient(routes: Record<string, unknown>): ApiClient {
  const get = vi.fn(async (path: string) => {
    if (path in routes) return { data: routes[path] };
    return { data: [] };
  });
  const noop = vi.fn(async () => ({ data: [] }));
  return {
    get,
    patch: noop,
    post: noop,
    delete: noop,
    put: noop,
    request: noop,
  } as unknown as ApiClient;
}

afterEach(() => vi.clearAllMocks());

describe("GAP-179 コスト表示は API 由来", () => {
  it("shows the cost label and PC requirement from /cron-actions", async () => {
    renderWithQuery(
      <CronScheduleContainer
        projectId="p1"
        client={routedClient({
          "/cron-schedules": SCHEDULES,
          "/cron-actions": ACTIONS,
        })}
      />,
    );
    await waitFor(() =>
      expect(screen.getByText("本人の Claude プラン枠")).toBeInTheDocument(),
    );
    expect(screen.getByText("PC 接続が必要")).toBeInTheDocument();
    expect(
      screen.getByText(
        "カテゴリやタグが未整備のナレッジに、分類とタグを付けます。",
      ),
    ).toBeInTheDocument();
    expect(screen.queryByText(/BYOK/)).not.toBeInTheDocument();
  });

  it("omits cost text entirely when the catalog is unavailable", async () => {
    renderWithQuery(
      <CronScheduleContainer
        projectId="p1"
        client={routedClient({
          "/cron-schedules": [
            { ...SCHEDULES[0], name: "夜間のナレッジ棚卸し" },
          ],
        })}
      />,
    );
    await waitFor(() =>
      expect(
        screen.getAllByText("夜間のナレッジ棚卸し").length,
      ).toBeGreaterThan(0),
    );
    // 推測で「API 使用」「無料」などを書かない
    expect(
      screen.queryByText("本人の Claude プラン枠"),
    ).not.toBeInTheDocument();
    expect(screen.queryByText(/BYOK/)).not.toBeInTheDocument();
  });
});

describe("GAP-183 発火の見張り役を隠さない", () => {
  it("誰が時刻を見張っているかを画面に書く", () => {
    render(<CronSchedule jobs={[]} onToggle={() => {}} />);
    expect(
      screen.getByText(/お使いのパソコン（Bridge）が起動している間/),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/次に起動したときにまとめて実行/),
    ).toBeInTheDocument();
    // 滑り止めがあることも隠さない
    expect(screen.getByText(/15 分ごとに確認/)).toBeInTheDocument();
  });
});

describe("GAP-179 実行結果の表示", () => {
  it("labels deferred runs as 保留 (not 失敗)", () => {
    expect(runStatusLabel("deferred")).toBe("保留");
    expect(runStatusLabel("error")).toBe("失敗");
    expect(runStatusLabel("success")).toBe("成功");
  });

  it("shows the previous result on the schedule row", () => {
    render(
      <CronSchedule
        jobs={[
          {
            id: "s1",
            name: "ナレッジ整理",
            schedule: "0 9 * * *",
            enabled: true,
            nextRunAt: "2026-09-01 00:00",
            targetAction: "knowledge_organize",
            nextRunIso: "2026-09-01T00:00:00Z",
          },
        ]}
        runs={[
          {
            id: "r1",
            name: "ナレッジ整理",
            startedAt: "2026-08-19T00:00:00Z",
            finishedAt: "2026-08-19T00:00:01Z",
            status: "deferred",
            scheduleId: "s1",
          },
        ]}
        onToggle={() => {}}
      />,
    );
    expect(screen.getByText("前回 保留")).toBeInTheDocument();
  });

  it("does not advertise a next run for a stopped schedule", () => {
    render(
      <CronSchedule
        jobs={[
          {
            id: "s1",
            name: "止めたやつ",
            schedule: "0 9 * * *",
            enabled: false,
            nextRunAt: "2026-09-01 00:00",
            targetAction: "daily_digest",
            nextRunIso: null,
          },
        ]}
        onToggle={() => {}}
      />,
    );
    expect(screen.getByText("停止中のため次回なし")).toBeInTheDocument();
    expect(screen.queryByText(/次回 2026/)).not.toBeInTheDocument();
  });
});
