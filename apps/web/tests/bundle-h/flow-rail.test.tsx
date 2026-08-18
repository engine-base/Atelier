/**
 * GAP-150 — S-E01 FlowRail (プロジェクト進行フロー) のテスト。
 *
 * COO ハブ&スポーク運用の UI 面: ステージ表示 / 現在ステージから話す /
 * ソフトゲート (順序外は警告つき) / hard_gate の明示承認 / スキップ理由必須 /
 * 完了後の引き継ぎバナー。
 */

// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";

import * as React from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createQueryClient } from "../../lib/query-client";
import {
  FlowRail,
  type FlowStage,
} from "../../app/chat/s_e01/_components/FlowRail";

function renderWithQuery(ui: React.ReactElement) {
  const qc = createQueryClient();
  return render(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>);
}

function stage(over: Partial<FlowStage> & { stage_key: string; seq: number }): FlowStage {
  return {
    id: `st-${over.stage_key}`,
    title: over.stage_key,
    department: "product",
    status: "pending",
    skippable: false,
    hard_gate: false,
    current: false,
    ...over,
  } as FlowStage;
}

const FLOW: FlowStage[] = [
  stage({
    stage_key: "hearing",
    seq: 1,
    title: "商談・ヒアリング",
    status: "done",
    employee_name: "スティーブ",
    employee_id: "e-steve",
    thread_id: "t-steve",
  }),
  stage({
    stage_key: "proposal",
    seq: 2,
    title: "提案",
    current: true,
    skippable: true,
    employee_name: "トニー",
    employee_id: "e-tony",
    thread_id: "t-tony",
  }),
  stage({
    stage_key: "contract",
    seq: 3,
    title: "契約",
    hard_gate: true,
    employee_name: "トニー",
    employee_id: "e-tony",
  }),
];

afterEach(() => vi.clearAllMocks());

describe("FlowRail (GAP-150)", () => {
  it("ステージを seq 順に表示し、現在ステージのクリックで既存スレッドへ", async () => {
    const onSelect = vi.fn();
    renderWithQuery(
      <FlowRail
        projectId="p1"
        onSelectThread={onSelect}
        getFlowFn={async () => FLOW}
      />,
    );
    expect(
      await screen.findByRole("region", { name: "プロジェクト進行フロー" }),
    ).toBeInTheDocument();
    expect(screen.getByText("商談・ヒアリング")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "提案 を開く" }));
    await waitFor(() => expect(onSelect).toHaveBeenCalledWith("t-tony"));
  });

  it("順序外 (これから) のステージはソフトゲート — 警告後「それでも開く」で工程スレッド作成", async () => {
    const onSelect = vi.fn();
    const ensureThreadFn = vi.fn(async () => ({ thread_id: "t-new" }));
    renderWithQuery(
      <FlowRail
        projectId="p1"
        onSelectThread={onSelect}
        getFlowFn={async () => FLOW}
        ensureThreadFn={ensureThreadFn}
      />,
    );
    fireEvent.click(await screen.findByRole("button", { name: "契約 を開く" }));
    // まだ作成されない (警告が出る)
    expect(ensureThreadFn).not.toHaveBeenCalled();
    expect(
      screen.getByText(/先に「提案」が残っています。順序を飛ばして開きますか？/),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "それでも開く" }));
    await waitFor(() =>
      expect(ensureThreadFn).toHaveBeenCalledWith("p1", "contract"),
    );
    await waitFor(() => expect(onSelect).toHaveBeenCalledWith("t-new"));
  });

  it("GAP-151: 未選択で開くと現在工程の会話が自動で開く", async () => {
    const onSelect = vi.fn();
    const ensureThreadFn = vi.fn(async () => ({ thread_id: "t-current" }));
    const flow = FLOW.map((s) =>
      s.current ? { ...s, thread_id: null } : s,
    ) as FlowStage[];
    renderWithQuery(
      <FlowRail
        projectId="p1"
        onSelectThread={onSelect}
        autoOpenCurrent
        getFlowFn={async () => flow}
        ensureThreadFn={ensureThreadFn}
      />,
    );
    // 自動で現在工程 (提案) の専用スレッドが確保されて開く
    await waitFor(() =>
      expect(ensureThreadFn).toHaveBeenCalledWith("p1", "proposal"),
    );
    await waitFor(() => expect(onSelect).toHaveBeenCalledWith("t-current"));
  });

  it("現在ステージの完了 → 次ステージへの引き継ぎバナー (COO 案内)", async () => {
    const after: FlowStage[] = [
      { ...FLOW[0]! },
      { ...FLOW[1]!, status: "done", current: false },
      { ...FLOW[2]!, current: true },
    ];
    const postFlowFn = vi.fn(async () => after);
    renderWithQuery(
      <FlowRail
        projectId="p1"
        onSelectThread={vi.fn()}
        getFlowFn={async () => FLOW}
        postFlowFn={postFlowFn}
      />,
    );
    fireEvent.click(await screen.findByRole("button", { name: "提案 を完了" }));
    await waitFor(() =>
      expect(postFlowFn).toHaveBeenCalledWith("p1", "proposal", "complete", {}),
    );
    expect(await screen.findByRole("status")).toHaveTextContent(
      "次は「契約」 — トニーに繋ぎます",
    );
  });

  it("hard_gate (契約) の完了は明示承認が必須 — 承認で confirm:true を送る", async () => {
    const flow: FlowStage[] = [
      { ...FLOW[2]!, current: true, thread_id: "t-x" },
    ];
    const postFlowFn = vi.fn(async () => flow);
    renderWithQuery(
      <FlowRail
        projectId="p1"
        onSelectThread={vi.fn()}
        getFlowFn={async () => flow}
        postFlowFn={postFlowFn}
      />,
    );
    fireEvent.click(await screen.findByRole("button", { name: "契約 を完了" }));
    expect(postFlowFn).not.toHaveBeenCalled(); // 先に承認パネル
    expect(screen.getByText(/「契約」は致命工程です/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "承認して完了" }));
    await waitFor(() =>
      expect(postFlowFn).toHaveBeenCalledWith("p1", "contract", "complete", {
        confirm: true,
      }),
    );
  });

  it("スキップは理由必須 — 入力して送ると skip + reason が送信される", async () => {
    const postFlowFn = vi.fn(async () => FLOW);
    renderWithQuery(
      <FlowRail
        projectId="p1"
        onSelectThread={vi.fn()}
        getFlowFn={async () => FLOW}
        postFlowFn={postFlowFn}
      />,
    );
    fireEvent.click(
      await screen.findByRole("button", { name: "提案 をスキップ" }),
    );
    const input = screen.getByLabelText(/スキップ理由/);
    // 空では送れない
    expect(screen.getByRole("button", { name: "スキップする" })).toBeDisabled();
    fireEvent.change(input, { target: { value: "既存客の追加開発のため" } });
    fireEvent.click(screen.getByRole("button", { name: "スキップする" }));
    await waitFor(() =>
      expect(postFlowFn).toHaveBeenCalledWith("p1", "proposal", "skip", {
        reason: "既存客の追加開発のため",
      }),
    );
  });

  it("完了済みステージは差し戻しできる", async () => {
    const postFlowFn = vi.fn(async () => FLOW);
    renderWithQuery(
      <FlowRail
        projectId="p1"
        onSelectThread={vi.fn()}
        getFlowFn={async () => FLOW}
        postFlowFn={postFlowFn}
      />,
    );
    fireEvent.click(
      await screen.findByRole("button", { name: "商談・ヒアリング を差し戻す" }),
    );
    await waitFor(() =>
      expect(postFlowFn).toHaveBeenCalledWith("p1", "hearing", "reopen", {}),
    );
  });
});
