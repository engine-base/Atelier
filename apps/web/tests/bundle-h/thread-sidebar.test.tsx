/**
 * S-E01 ThreadSidebar — スレッド一覧 + 新規作成の配線テスト
 *
 * connector(getJson/sendJson) を mock し、一覧描画と POST /chat/threads を検証する。
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

import { ThreadSidebar } from "../../app/chat/s_e01/_components/ThreadSidebar";

function renderWithQuery(ui: React.ReactElement) {
  const qc = createQueryClient();
  return render(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>);
}

function wireDefaults() {
  getJson.mockImplementation(async (path: string) => {
    if (path.startsWith("/chat/threads"))
      return { data: [{ id: "t1", project_id: "p1", ai_employee_id: "e1", title: "既存スレッド" }] };
    if (path.startsWith("/projects"))
      return { data: [{ id: "p1", name: "小松案件" }] };
    if (path.startsWith("/ai-employees"))
      return { data: [{ id: "e1", name: "tony", display_name: "トニー" }] };
    return { data: [] };
  });
}

afterEach(() => vi.clearAllMocks());

describe("S-E01 ThreadSidebar", () => {
  it("lists existing threads and selects one", async () => {
    wireDefaults();
    const onSelect = vi.fn();
    renderWithQuery(<ThreadSidebar selectedId={null} onSelect={onSelect} />);
    fireEvent.click(await screen.findByText("既存スレッド"));
    expect(onSelect).toHaveBeenCalledWith("t1");
  });

  it("creates a thread via POST /chat/threads and selects it", async () => {
    wireDefaults();
    sendJson.mockResolvedValue({ id: "t2", project_id: "p1", ai_employee_id: "e1", title: null });
    const onSelect = vi.fn();
    renderWithQuery(<ThreadSidebar selectedId={null} onSelect={onSelect} />);

    fireEvent.click(await screen.findByRole("button", { name: "新規スレッド" }));
    // 選択肢が揃うのを待つ
    await screen.findByRole("option", { name: "小松案件" });
    fireEvent.change(screen.getByLabelText("プロジェクト"), { target: { value: "p1" } });
    fireEvent.change(screen.getByLabelText("AI 社員"), { target: { value: "e1" } });
    fireEvent.click(screen.getByRole("button", { name: "スレッドを作成" }));

    await waitFor(() => expect(sendJson).toHaveBeenCalledTimes(1));
    const [method, path, body] = sendJson.mock.calls[0]! as [string, string, { project_id: string; ai_employee_id: string }];
    expect(method).toBe("POST");
    expect(path).toBe("/chat/threads");
    expect(body).toEqual({ project_id: "p1", ai_employee_id: "e1" });
    await waitFor(() => expect(onSelect).toHaveBeenCalledWith("t2"));
  });
});
