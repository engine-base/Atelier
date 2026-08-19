/**
 * GAP-157 — ヘッダーのフェーズスイッチャー (全体切替 + 確定) のテスト。
 */

// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";

import * as React from "react";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
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
    // GAP-165: 確定範囲メモ (任意) が第 3 引数で渡る — 未入力なら undefined
    await waitFor(() =>
      expect(freezePhaseFn).toHaveBeenCalledWith("p1", "ph2", undefined),
    );
    // 新しい現在フェーズ (フェーズ3) の表示へ
    expect(
      await screen.findByRole("button", { name: /表示中: フェーズ3/ }),
    ).toBeInTheDocument();
    expect(readSelectedPhase("p1")).toBeNull();
  });
});

describe("PhaseSwitcher 確定前チェック (GAP-165)", () => {
  it("確定メニューで「残っている作業」と「確定後も直せる」ことを出し、確定範囲メモを送る", async () => {
    const freezePhaseFn = vi.fn(async () => TWO);
    const freezeCheckFn = vi.fn(async () => ({
      phase_name: "フェーズ2",
      pending_stages: ["アーキ設計", "検証"],
      open_tasks: 3,
      unresolved_comments: 1,
      output_count: 1,
      mock_count: 0,
      warnings: [
        "未完了の工程が 2 つあります（アーキ設計、検証）",
        "完了していないタスクが 3 件あります",
        "未解決のコメントが 1 件あります",
      ],
    }));
    render(
      <PhaseSwitcher
        projectId="p1"
        getPhasesFn={async () => TWO}
        freezePhaseFn={freezePhaseFn}
        freezeCheckFn={freezeCheckFn}
      />,
    );
    fireEvent.click(
      await screen.findByRole("button", { name: /フェーズ切替（表示中: フェーズ2）/ }),
    );
    fireEvent.click(
      screen.getByRole("button", { name: "「フェーズ2」を確定して次フェーズへ…" }),
    );
    await waitFor(() => expect(freezeCheckFn).toHaveBeenCalledWith("p1", "ph2"));

    // 残っている作業が実データで並ぶ (判断は人がする)
    const list = await screen.findByRole("list", { name: "確定前の確認事項" });
    expect(within(list).getByText(/未完了の工程が 2 つあります/)).toBeInTheDocument();
    expect(within(list).getByText(/完了していないタスクが 3 件/)).toBeInTheDocument();
    expect(within(list).getByText(/未解決のコメントが 1 件/)).toBeInTheDocument();

    // 「確定したら直せなくなる」ではないことを明示している
    expect(screen.getByText(/確定後も修正はできます/)).toBeInTheDocument();

    // 確定範囲メモを書いて確定 → 第 3 引数で渡る
    fireEvent.change(screen.getByPlaceholderText(/初期スコープ/), {
      target: { value: "要件と見積まで。決済連携は次フェーズ" },
    });
    fireEvent.click(screen.getByRole("button", { name: "確定して次フェーズへ" }));
    await waitFor(() =>
      expect(freezePhaseFn).toHaveBeenCalledWith(
        "p1",
        "ph2",
        "要件と見積まで。決済連携は次フェーズ",
      ),
    );
  });
});
