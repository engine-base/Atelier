/**
 * GAP-157 — ヘッダーのフェーズスイッチャー (全体切替 + 確定) のテスト。
 */

// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";

import * as React from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  PhaseSwitcher,
  type PhaseLite,
} from "../../components/layout/PhaseSwitcher";
import { readSelectedPhase } from "../../lib/currentPhase";

function phase(over: Partial<PhaseLite> & { id: string; seq: number }): PhaseLite {
  return {
    name: `フェーズ${over.seq}`,
    status: "active",
    mock_count: 0,
    output_count: 0,
    task_count: 0,
    ...over,
  } as PhaseLite;
}

const TWO: PhaseLite[] = [
  phase({ id: "ph1", seq: 1, status: "frozen", output_count: 3, mock_count: 2 }),
  phase({ id: "ph2", seq: 2, output_count: 1 }),
];

beforeEach(() => window.localStorage.clear());
afterEach(() => vi.clearAllMocks());

describe("PhaseSwitcher (GAP-157)", () => {
  it("フェーズ一覧から選ぶと全体切替 (localStorage + イベント)、確定選択はピルに明示", async () => {
    const events: (string | null)[] = [];
    window.addEventListener("atelier-phase-changed", (ev: Event) => {
      const d = (ev as CustomEvent).detail as { phaseId?: string | null };
      events.push(d?.phaseId ?? null);
    });
    render(
      <PhaseSwitcher projectId="p1" getPhasesFn={async () => TWO} />,
    );
    const pill = await screen.findByRole("button", {
      name: /フェーズ切替（表示中: フェーズ2）/,
    });
    fireEvent.click(pill);
    // 一覧に実数
    expect(
      screen.getByText("成果物3 · モック2 · タスク0"),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole("menuitem", { name: /フェーズ1/ }));
    // 全体切替: 永続 + イベント + ピル表示
    expect(readSelectedPhase("p1")).toBe("ph1");
    expect(events.at(-1)).toBe("ph1");
    expect(
      await screen.findByRole("button", {
        name: /表示中: フェーズ1/,
      }),
    ).toHaveTextContent("✓確定 (閲覧中)");
  });

  it("「確定して次フェーズへ」は明示承認 → freeze API → 現在フェーズ表示へ戻す", async () => {
    const after: PhaseLite[] = [
      { ...TWO[0]! },
      { ...TWO[1]!, status: "frozen" },
      phase({ id: "ph3", seq: 3 }),
    ];
    const freezePhaseFn = vi.fn(async () => after);
    render(
      <PhaseSwitcher
        projectId="p1"
        getPhasesFn={async () => TWO}
        freezePhaseFn={freezePhaseFn}
      />,
    );
    fireEvent.click(
      await screen.findByRole("button", { name: /フェーズ切替/ }),
    );
    fireEvent.click(
      screen.getByRole("button", { name: "「フェーズ2」を確定して次フェーズへ…" }),
    );
    // 明示承認まで API は呼ばない
    expect(freezePhaseFn).not.toHaveBeenCalled();
    expect(screen.getByText(/確定すると成果物（1 件）が凍結され/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "確定して次フェーズへ" }));
    await waitFor(() => expect(freezePhaseFn).toHaveBeenCalledWith("p1", "ph2"));
    // 新しい現在フェーズ (フェーズ3) の表示へ
    expect(
      await screen.findByRole("button", { name: /表示中: フェーズ3/ }),
    ).toBeInTheDocument();
    expect(readSelectedPhase("p1")).toBeNull();
  });
});
