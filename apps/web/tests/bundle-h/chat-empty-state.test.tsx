/**
 * GAP-123 — ChatEmptyState (スレッド未選択の右ペイン) のテスト
 */

// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";

import * as React from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createQueryClient } from "../../lib/query-client";

const getJson = vi.fn();
const sendJson = vi.fn();
vi.mock("../../lib/auth/connector", () => ({
  getJson: (...a: unknown[]) => getJson(...a),
  sendJson: (...a: unknown[]) => sendJson(...a),
}));

import { ChatEmptyState } from "../../app/chat/s_e01/_components/ChatEmptyState";

function renderWithQuery(ui: React.ReactElement) {
  const qc = createQueryClient();
  return render(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>);
}

function wire() {
  getJson.mockImplementation(async (path: string) => {
    if (path.startsWith("/ai-employees"))
      return {
        data: [
          { id: "e1", name: "tony", display_name: "トニー", role: "CTO" },
          { id: "e2", name: "wanda", display_name: "ワンダ" },
        ],
      };
    if (path.startsWith("/projects")) return { data: [{ id: "p1", name: "小松案件" }] };
    return { data: [] };
  });
}

afterEach(() => vi.clearAllMocks());

describe("S-E01 ChatEmptyState (GAP-123)", () => {
  it("プロジェクト文脈があれば社員クリックで即スレッド作成 → 開く", async () => {
    wire();
    sendJson.mockResolvedValue({ id: "t9" });
    const onOpenThread = vi.fn();
    renderWithQuery(<ChatEmptyState projectId="p1" onOpenThread={onOpenThread} />);
    fireEvent.click(
      await screen.findByRole("button", { name: "トニーと新しいスレッドを開始" }),
    );
    await waitFor(() => expect(sendJson).toHaveBeenCalledTimes(1));
    expect(sendJson).toHaveBeenCalledWith("POST", "/chat/threads", {
      project_id: "p1",
      ai_employee_id: "e1",
    });
    await waitFor(() => expect(onOpenThread).toHaveBeenCalledWith("t9"));
    // プロジェクト文脈があるときは選択 UI を出さない
    expect(screen.queryByLabelText("プロジェクト")).toBeNull();
  });

  it("プロジェクト文脈が無ければ選択するまで社員カードは無効 (死にボタン禁止の明示)", async () => {
    wire();
    const onOpenThread = vi.fn();
    renderWithQuery(<ChatEmptyState onOpenThread={onOpenThread} />);
    const card = await screen.findByRole("button", {
      name: "トニーと新しいスレッドを開始",
    });
    expect(card).toBeDisabled();
    expect(
      screen.getByText(/プロジェクトを選ぶと社員カードから会話を始められます/),
    ).toBeInTheDocument();
    // プロジェクトを選ぶと有効化される
    await screen.findByRole("option", { name: "小松案件" });
    fireEvent.change(screen.getByRole("combobox"), { target: { value: "p1" } });
    await waitFor(() => expect(card).toBeEnabled());
  });

  it("作成失敗は誠実にエラー表示", async () => {
    wire();
    sendJson.mockRejectedValue(new Error("boom"));
    renderWithQuery(<ChatEmptyState projectId="p1" onOpenThread={() => undefined} />);
    fireEvent.click(
      await screen.findByRole("button", { name: "ワンダと新しいスレッドを開始" }),
    );
    // mutation は既定で 2 回リトライ (指数バックオフ) するため長めに待つ
    expect(
      await screen.findByText("スレッドを作成できませんでした。", undefined, {
        timeout: 8000,
      }),
    ).toBeInTheDocument();
  });
});
