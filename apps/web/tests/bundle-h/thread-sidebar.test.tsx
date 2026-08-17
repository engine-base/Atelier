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
    const [method, path, body] = sendJson.mock.calls[0]! as [string, string, { project_id: string; ai_employee_id: string; title: string }];
    expect(method).toBe("POST");
    expect(path).toBe("/chat/threads");
    // GAP-125: 作成時にデフォルトタイトルを必ず付ける (例: 「新しい会話 8/17 19:30」)
    expect(body).toEqual({
      project_id: "p1",
      ai_employee_id: "e1",
      title: expect.stringMatching(/^新しい会話 /) as unknown as string,
    });
    await waitFor(() => expect(onSelect).toHaveBeenCalledWith("t2"));
  });
});

describe("ThreadSidebar — タイトル表示 / 編集 / 削除 (GAP-125)", () => {
  it("一覧はプレビューではなくタイトルを表示し、タイトル未設定は無題スレッド", async () => {
    getJson.mockImplementation(async (path: string) => {
      if (path.startsWith("/chat/threads"))
        return {
          data: [
            { id: "t1", project_id: "p1", ai_employee_id: "e1", title: null, last_message_preview: "# 直近のやりとり本文" },
          ],
        };
      if (path.startsWith("/ai-employees"))
        return { data: [{ id: "e1", name: "tony", display_name: "トニー" }] };
      return { data: [] };
    });
    renderWithQuery(<ThreadSidebar selectedId={null} onSelect={() => undefined} />);
    expect(await screen.findByText("無題スレッド")).toBeInTheDocument();
    // 直近やりとりのプレビューは一覧に出さない (経営者指示)
    expect(screen.queryByText(/直近のやりとり本文/)).toBeNull();
  });

  it("鉛筆からインライン編集し PATCH /chat/threads/{id} が飛ぶ", async () => {
    wireDefaults();
    sendJson.mockResolvedValue(undefined);
    renderWithQuery(<ThreadSidebar selectedId={null} onSelect={() => undefined} />);
    await screen.findByText("既存スレッド");
    fireEvent.click(
      screen.getByRole("button", { name: "スレッド「既存スレッド」の名前を変更" }),
    );
    const input = screen.getByLabelText("スレッド名を編集");
    expect(input).toHaveValue("既存スレッド");
    fireEvent.change(input, { target: { value: "見積の最終確認" } });
    fireEvent.click(screen.getByRole("button", { name: "スレッド名を保存" }));
    await waitFor(() =>
      expect(sendJson).toHaveBeenCalledWith("PATCH", "/chat/threads/t1", {
        title: "見積の最終確認",
      }),
    );
  });

  it("ごみ箱は はい/いいえ の確認を挟み、はい で DELETE + onDeleted", async () => {
    wireDefaults();
    sendJson.mockResolvedValue(undefined);
    const onDeleted = vi.fn();
    renderWithQuery(
      <ThreadSidebar selectedId={null} onSelect={() => undefined} onDeleted={onDeleted} />,
    );
    await screen.findByText("既存スレッド");
    fireEvent.click(
      screen.getByRole("button", { name: "スレッド「既存スレッド」を削除" }),
    );
    // いいえ でキャンセルできる (戻れるフロー)
    expect(screen.getByText("「既存スレッド」を削除しますか？")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "いいえ" }));
    expect(sendJson).not.toHaveBeenCalled();
    // 改めて はい で削除実行
    fireEvent.click(
      screen.getByRole("button", { name: "スレッド「既存スレッド」を削除" }),
    );
    fireEvent.click(screen.getByRole("button", { name: "はい" }));
    await waitFor(() =>
      expect(sendJson).toHaveBeenCalledWith("DELETE", "/chat/threads/t1"),
    );
    await waitFor(() => expect(onDeleted).toHaveBeenCalledWith("t1"));
  });
});

describe("stripMarkdown (GAP-118 追補 — プレビューの生記号除去)", () => {
  it("見出し/強調/表/コード/リンクの記号を落として平文にする", async () => {
    const { stripMarkdown } = await import("../../app/chat/s_e01/_components/ThreadSidebar");
    expect(
      stripMarkdown("# 見積もりのご提案\n\nご依頼の **API 実装** について"),
    ).toBe("見積もりのご提案 ご依頼の API 実装 について");
    expect(stripMarkdown("| 項目 | 値 |\n| --- | --- |\n| 単価 | 100 |")).toBe(
      "項目 値 単価 100",
    );
    expect(stripMarkdown("実行は `uv run` で [仕様書](https://x) を見る")).toBe(
      "実行は uv run で 仕様書 を見る",
    );
    expect(stripMarkdown("```python\ncode\n```\n- 項目A\n> 引用")).toBe("項目A 引用");
    expect(stripMarkdown("")).toBe("");
  });
});

describe("ThreadSidebar — AI 社員階層 (GAP-123)", () => {
  it("同じ社員のスレッドが社員セクション配下にまとまり件数が出る", async () => {
    getJson.mockImplementation(async (path: string) => {
      if (path.startsWith("/chat/threads"))
        return {
          data: [
            { id: "t1", project_id: "p1", ai_employee_id: "e1", title: "見積の相談", updated_at: "2026-08-17T09:00:00Z" },
            { id: "t2", project_id: "p1", ai_employee_id: "e1", title: "要件の整理", updated_at: "2026-08-17T08:00:00Z" },
            { id: "t3", project_id: "p1", ai_employee_id: "e2", title: "DB 設計", updated_at: "2026-08-17T07:00:00Z" },
          ],
        };
      if (path.startsWith("/projects")) return { data: [{ id: "p1", name: "小松案件" }] };
      if (path.startsWith("/ai-employees"))
        return {
          data: [
            { id: "e1", name: "tony", display_name: "トニー" },
            { id: "e2", name: "strange", display_name: "ストレンジ" },
          ],
        };
      return { data: [] };
    });
    renderWithQuery(<ThreadSidebar selectedId={null} onSelect={() => undefined} />);
    // 社員見出しが 2 つ (トニー / ストレンジ)、トニー配下に 2 スレッド
    await screen.findByText("見積の相談");
    expect(screen.getByText("トニー")).toBeInTheDocument();
    expect(screen.getByText("ストレンジ")).toBeInTheDocument();
    // トニーの件数バッジ = 2
    const tonyHeader = screen.getByText("トニー").parentElement!;
    expect(tonyHeader.textContent).toContain("2");
    // 直近更新が新しい社員 (トニー) が先に並ぶ
    const names = screen.getAllByText(/トニー|ストレンジ/).map((n) => n.textContent);
    expect(names[0]).toBe("トニー");
    // 各スレッドカードには社員名を重複表示しない (見出しに集約)
    expect(screen.getByText("要件の整理")).toBeInTheDocument();
    expect(screen.getByText("DB 設計")).toBeInTheDocument();
  });
});
