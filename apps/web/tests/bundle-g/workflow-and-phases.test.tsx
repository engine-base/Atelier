/**
 * T-UC-10 WorkflowGraph + T-UC-11 PhaseList tests
 */

// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";

import * as React from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import {
  type PhaseEdge,
  type PhaseNode,
  WorkflowGraph,
} from "../../app/workflow/s_f01/_components/WorkflowGraph";
import {
  PhaseList,
  type PhaseRow,
} from "../../app/workflow/s_f02/_components/PhaseList";

describe("WorkflowGraph (T-UC-10)", () => {
  const nodes: PhaseNode[] = [
    { id: "a", label: "A", status: "done" },
    { id: "b", label: "B", status: "in_progress" },
  ];
  const edges: PhaseEdge[] = [{ from: "a", to: "b" }];

  it("renders phase nodes with status labels", () => {
    render(<WorkflowGraph nodes={nodes} edges={edges} />);
    expect(screen.getByText("A")).toBeInTheDocument();
    expect(screen.getByText("B")).toBeInTheDocument();
    expect(screen.getByText("完了")).toBeInTheDocument();
    expect(screen.getByText("進行中")).toBeInTheDocument();
  });

  it('renders edges as "from → to" labels', () => {
    render(<WorkflowGraph nodes={nodes} edges={edges} />);
    expect(screen.getByText(/A → B/)).toBeInTheDocument();
  });
});

describe("PhaseList (T-UC-11)", () => {
  const rows: PhaseRow[] = [
    { id: "p1", name: "要件", status: "done", order: 1 },
    { id: "p2", name: "設計", status: "pending", order: 2 },
  ];

  it("renders phases in order", () => {
    render(<PhaseList rows={rows} />);
    expect(screen.getByText("要件")).toBeInTheDocument();
    expect(screen.getByText("設計")).toBeInTheDocument();
  });

  it("calls onTransition when the status select changes", () => {
    const onTransition = vi.fn();
    render(<PhaseList rows={rows} onTransition={onTransition} />);
    const select = screen.getByLabelText("設計 の状態") as HTMLSelectElement;
    fireEvent.change(select, { target: { value: "in_progress" } });
    expect(onTransition).toHaveBeenCalledWith("p2", "in_progress");
  });
});
