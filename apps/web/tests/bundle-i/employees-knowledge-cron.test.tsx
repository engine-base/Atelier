/**
 * Bundle I tests: OrgChart / EmployeeEditor / KnowledgeExplorer / PromotionReview / CronSchedule
 */

// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";

import * as React from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { describe, expect, it, vi } from "vitest";

import { type ApiClient } from "@atelier/api-client";

import {
  OrgChart,
  type OrgNode,
} from "../../app/employees/s_c01/_components/OrgChart";
import {
  EmployeeEditor,
  type EmployeeValues,
} from "../../app/employees/s_c02/_components/EmployeeEditor";
import {
  PromotionReview,
  type PromotionItem,
} from "../../app/knowledge/s_k02/_components/PromotionReview";
import { NodeDetail } from "../../app/knowledge/s_k01/_components/NodeDetail";
import { type KnowledgeNode } from "../../app/knowledge/s_k01/_components/types";
import {
  CronSchedule,
  type CronJob,
} from "../../app/cron/s_o01/_components/CronSchedule";
import { ScheduleBuilder } from "../../app/cron/s_o01/_components/ScheduleBuilder";
import { ScheduleBuilderContainer } from "../../app/cron/s_o01/_components/ScheduleBuilderContainer";

describe("OrgChart (T-UC-06)", () => {
  const nodes: OrgNode[] = [
    { id: "tony", selectId: "e-tony", displayName: "Tony", department: "dev_qa" },
    { id: "wanda", selectId: "e-wanda", displayName: "Wanda", department: "design" },
  ];

  it("groups by department", () => {
    render(<OrgChart nodes={nodes} />);
    expect(screen.getByLabelText("開発・QA")).toBeInTheDocument();
    expect(screen.getByLabelText("デザイン")).toBeInTheDocument();
  });

  it("invokes onSelect on member click", () => {
    const onSelect = vi.fn();
    render(<OrgChart nodes={nodes} onSelect={onSelect} />);
    fireEvent.click(screen.getByRole("button", { name: /Tony の詳細/ }));
    expect(onSelect).toHaveBeenCalledWith("e-tony");
  });
});

describe("EmployeeEditor (T-UC-07)", () => {
  const defaults: EmployeeValues = {
    display_name: "Tony",
    tone_preset: "friendly",
    custom_tone_text: "",
  };
  it("renders form with defaults", () => {
    render(
      <EmployeeEditor
        employeeId="tony"
        name="Tony"
        role="開発リード"
        department="dev_qa"
        attachedSkills={["task_prioritization"]}
        attachedKnowledgeCats={["dev"]}
        defaultValues={defaults}
        onSubmit={() => undefined}
      />,
    );
    expect((screen.getByLabelText(/表示名/) as HTMLInputElement).value).toBe(
      "Tony",
    );
    expect(
      (screen.getByLabelText(/口調プリセット/) as HTMLSelectElement).value,
    ).toBe("friendly");
  });
});

describe("PromotionReview (T-UC-19)", () => {
  const items: PromotionItem[] = [
    { id: "p1", title: "X", confidence: 0.9, content: "x", source: "src" },
  ];

  it("renders title, confidence, and actions", () => {
    render(
      <PromotionReview
        items={items}
        onApprove={() => undefined}
        onReject={() => undefined}
      />,
    );
    expect(screen.getByText("X")).toBeInTheDocument();
    expect(screen.getByLabelText("信頼度 90%")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "X を昇格" }),
    ).toBeInTheDocument();
  });

  it("invokes onApprove and onReject", () => {
    const onApprove = vi.fn();
    const onReject = vi.fn();
    render(
      <PromotionReview
        items={items}
        onApprove={onApprove}
        onReject={onReject}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "X を昇格" }));
    fireEvent.click(screen.getByRole("button", { name: "X を却下" }));
    expect(onApprove).toHaveBeenCalledWith("p1");
    expect(onReject).toHaveBeenCalledWith("p1");
  });
});

describe("CronSchedule (T-UC-25)", () => {
  const jobs: CronJob[] = [
    {
      id: "j1",
      name: "job-A",
      schedule: "0 0 * * *",
      enabled: true,
      nextRunAt: "明日",
    },
  ];

  it("renders job name and schedule", () => {
    render(
      <CronSchedule
        jobs={jobs}
        onToggle={() => undefined}
        onRunNow={() => undefined}
      />,
    );
    expect(screen.getByText("job-A")).toBeInTheDocument();
    expect(screen.getByText("0 0 * * *")).toBeInTheDocument();
  });

  it("invokes onToggle on checkbox change", () => {
    const onToggle = vi.fn();
    render(
      <CronSchedule
        jobs={jobs}
        onToggle={onToggle}
        onRunNow={() => undefined}
      />,
    );
    fireEvent.click(screen.getByLabelText(/job-A を 無効 化/));
    expect(onToggle).toHaveBeenCalledWith("j1", false);
  });

  it("invokes onRunNow on run button click", () => {
    const onRunNow = vi.fn();
    render(
      <CronSchedule
        jobs={jobs}
        onToggle={() => undefined}
        onRunNow={onRunNow}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /job-A を今すぐ実行/ }));
    expect(onRunNow).toHaveBeenCalledWith("j1");
  });

  it("deletes only after inline confirm (two-step)", () => {
    const onDelete = vi.fn();
    render(
      <CronSchedule jobs={jobs} onToggle={() => undefined} onDelete={onDelete} />,
    );
    // 1回目クリックは確認待ちで、まだ削除しない。
    fireEvent.click(screen.getByRole("button", { name: /job-A を削除/ }));
    expect(onDelete).not.toHaveBeenCalled();
    // 確認の「削除」で実行。
    fireEvent.click(screen.getByRole("button", { name: /job-A を削除/ }));
    expect(onDelete).toHaveBeenCalledWith("j1");
  });

  it("does not render a delete control when onDelete is absent", () => {
    render(<CronSchedule jobs={jobs} onToggle={() => undefined} />);
    expect(
      screen.queryByRole("button", { name: /job-A を削除/ }),
    ).not.toBeInTheDocument();
  });
});

describe("NodeDetail 昇格 (T-UC-19)", () => {
  const node: KnowledgeNode = {
    id: "k1",
    account_id: "w1",
    account_type: "workspace",
    scope: "project",
    category: "spec",
    title: "認証仕様",
    content_md: "本文",
    tags: [],
  };

  it("invokes onPromote with the node id", () => {
    const onPromote = vi.fn();
    render(<NodeDetail node={node} onPromote={onPromote} />);
    fireEvent.click(screen.getByRole("button", { name: "共通ナレッジに昇格" }));
    expect(onPromote).toHaveBeenCalledWith("k1");
  });

  it("hides the promote action when onPromote is absent", () => {
    render(<NodeDetail node={node} />);
    expect(
      screen.queryByRole("button", { name: "共通ナレッジに昇格" }),
    ).not.toBeInTheDocument();
  });
});

describe("ScheduleBuilder (T-UC-25 create)", () => {
  it("submits name + selected action + preset cron via onCreate", () => {
    const onCreate = vi.fn();
    render(<ScheduleBuilder onCreate={onCreate} />);
    fireEvent.change(screen.getByLabelText("1. 名前"), {
      target: { value: "週次サマリー" },
    });
    fireEvent.click(
      screen.getByRole("button", { name: /進捗レポートを配信する/ }),
    );
    fireEvent.click(screen.getByRole("button", { name: "毎週月曜 4:00" }));
    fireEvent.click(
      screen.getByRole("button", { name: /このスケジュールを作成/ }),
    );
    expect(onCreate).toHaveBeenCalledWith({
      name: "週次サマリー",
      cron_expression: "0 4 * * 1",
      target_action: "report_summary",
    });
  });

  it("disables submit until a name is entered", () => {
    render(<ScheduleBuilder onCreate={() => undefined} />);
    const submit = screen.getByRole("button", {
      name: /このスケジュールを作成/,
    });
    expect(submit).toBeDisabled();
    fireEvent.change(screen.getByLabelText("1. 名前"), {
      target: { value: "x" },
    });
    expect(submit).not.toBeDisabled();
  });
});

describe("ScheduleBuilderContainer (T-UC-25 create wiring)", () => {
  function fakeClient(post: ReturnType<typeof vi.fn>): ApiClient {
    const noop = vi.fn(async () => ({ data: {} }));
    return {
      get: noop,
      post,
      patch: noop,
      delete: noop,
      put: noop,
      request: noop,
    } as unknown as ApiClient;
  }

  it("POSTs /cron-schedules with the project + form payload", async () => {
    const post = vi.fn(async () => ({ data: { id: "c1" } }));
    const qc = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    render(
      <QueryClientProvider client={qc}>
        <ScheduleBuilderContainer projectId="p1" client={fakeClient(post)} />
      </QueryClientProvider>,
    );
    fireEvent.change(screen.getByLabelText("1. 名前"), {
      target: { value: "毎日ダイジェスト" },
    });
    fireEvent.click(
      screen.getByRole("button", { name: /日次ダイジェストを配信する/ }),
    );
    fireEvent.click(screen.getByRole("button", { name: "毎日 深夜 2:00" }));
    fireEvent.click(
      screen.getByRole("button", { name: /このスケジュールを作成/ }),
    );
    await waitFor(() => expect(post).toHaveBeenCalledTimes(1));
    const [path, init] = post.mock.calls[0]! as unknown as [
      string,
      {
        body: {
          project_id: string;
          name: string;
          cron_expression: string;
          target_action: string;
          enabled: boolean;
        };
      },
    ];
    expect(path).toBe("/cron-schedules");
    expect(init.body).toMatchObject({
      project_id: "p1",
      name: "毎日ダイジェスト",
      cron_expression: "0 2 * * *",
      target_action: "daily_digest",
      enabled: true,
    });
  });
});
