/**
 * Bundle I tests: OrgChart / EmployeeEditor / KnowledgeExplorer / PromotionReview / CronSchedule
 */

// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";

import * as React from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

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
import {
  CronSchedule,
  type CronJob,
} from "../../app/cron/s_o01/_components/CronSchedule";

describe("OrgChart (T-UC-06)", () => {
  const nodes: OrgNode[] = [
    { id: "tony", displayName: "Tony", role: "engineer" },
    { id: "wanda", displayName: "Wanda", role: "specialist" },
  ];

  it("groups by role", () => {
    render(<OrgChart nodes={nodes} />);
    expect(screen.getByLabelText("エンジニア")).toBeInTheDocument();
    expect(screen.getByLabelText("スペシャリスト")).toBeInTheDocument();
  });

  it("invokes onSelect on member click", () => {
    const onSelect = vi.fn();
    render(<OrgChart nodes={nodes} onSelect={onSelect} />);
    fireEvent.click(screen.getByRole("button", { name: /Tony の詳細/ }));
    expect(onSelect).toHaveBeenCalledWith("tony");
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
});
