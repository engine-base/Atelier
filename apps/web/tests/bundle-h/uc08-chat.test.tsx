/**
 * T-UC-08 — S-E01 チャット SSE 配線テスト (F-CTX01)
 *
 * streamFn を注入し real SSE を叩かずに検証する:
 *   - 送信でユーザ発話を楽観追加し、delta を assistant メッセージへ逐次反映
 *   - context chunk で F-CTX01 文脈サマリ(履歴/RAG hit 数)を表示
 *   - error chunk で inline error を表示
 *   - stream 例外で error 表示 + 空 placeholder を除去
 */

// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";

import * as React from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ChatContainer } from "../../app/chat/s_e01/_components/ChatContainer";
import type {
  ChatStreamChunk,
  StreamChatArgs,
} from "../../app/chat/s_e01/_components/stream";

afterEach(() => vi.clearAllMocks());

function send(text: string) {
  fireEvent.change(screen.getByLabelText(/メッセージを入力/), {
    target: { value: text },
  });
  fireEvent.click(screen.getByRole("button", { name: "送信" }));
}

describe("S-E01 ChatContainer (T-UC-08)", () => {
  it("streams deltas into an assistant message and shows context summary", async () => {
    const streamFn = vi.fn(async (args: StreamChatArgs) => {
      const chunks: ChatStreamChunk[] = [
        {
          type: "context",
          metadata: { history_count: 3, rag_hit_ids: ["a", "b"] },
        },
        { type: "start" },
        { type: "delta", content: "こん" },
        { type: "delta", content: "にちは" },
        { type: "end" },
      ];
      for (const c of chunks) args.onChunk(c);
    });
    render(
      <ChatContainer
        threadId="t1"
        streamFn={streamFn}
        fetchMessagesFn={async () => []}
      />,
    );
    send("やあ");

    expect(await screen.findByText("やあ")).toBeInTheDocument();
    await waitFor(() =>
      expect(screen.getByText("こんにちは")).toBeInTheDocument(),
    );
    // context サマリ
    expect(screen.getByLabelText("F-CTX01 文脈サマリ")).toHaveTextContent("3");
    expect(screen.getByLabelText("F-CTX01 文脈サマリ")).toHaveTextContent("2");
    // stream は正しい threadId / user_message で呼ばれる
    const arg = streamFn.mock.calls[0]![0]!;
    expect(arg.threadId).toBe("t1");
    expect(arg.userMessage).toBe("やあ");
  });

  it("shows inline error on an error chunk", async () => {
    const streamFn = vi.fn(async (args: StreamChatArgs) => {
      args.onChunk({ type: "error", content: "LLM 未接続" });
    });
    render(
      <ChatContainer
        threadId="t1"
        streamFn={streamFn}
        fetchMessagesFn={async () => []}
      />,
    );
    send("test");
    expect(await screen.findByRole("alert")).toHaveTextContent("LLM 未接続");
  });

  it("shows error and drops empty placeholder when the stream throws", async () => {
    const streamFn = vi.fn(async () => {
      throw new Error("network down");
    });
    render(
      <ChatContainer
        threadId="t1"
        streamFn={streamFn}
        fetchMessagesFn={async () => []}
      />,
    );
    send("test");
    await waitFor(() =>
      expect(screen.getByRole("alert")).toHaveTextContent(
        "AI 応答の取得に失敗",
      ),
    );
    // ユーザ発話は残り、空の assistant placeholder は消えている (AI 社員ラベルは出ない)
    expect(screen.getByText("test")).toBeInTheDocument();
    expect(screen.queryByText("AI 社員")).toBeNull();
  });
});
