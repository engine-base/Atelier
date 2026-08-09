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

describe("S-E01 メッセージフィードバック (GAP-031 ① 役立った)", () => {
  const history = [
    { id: "m-user", role: "user" as const, content: "質問" },
    { id: "m-asst", role: "assistant" as const, content: "回答です" },
  ];

  it("persisted な assistant メッセージに 役立った / コピー が出て POST される", async () => {
    const feedbackFn = vi.fn(async () => undefined);
    render(
      <ChatContainer
        threadId="t1"
        streamFn={vi.fn(async () => undefined)}
        fetchMessagesFn={async () => history}
        feedbackFn={feedbackFn}
      />,
    );
    const btn = await screen.findByRole("button", {
      name: /フィードバック: 役立った/,
    });
    expect(
      screen.getByRole("button", { name: "メッセージをコピー" }),
    ).toBeInTheDocument();
    fireEvent.click(btn);
    await waitFor(() => expect(feedbackFn).toHaveBeenCalledWith("m-asst", "up"));
    // 送信済み表示 (二重送信防止の disabled + ✓)
    await waitFor(() => expect(btn).toBeDisabled());
    expect(btn).toHaveTextContent("役立った ✓");
  });

  it("ストリーミング中の楽観行 (ローカル ID) にはアクション行を出さない", async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const streamFn = vi.fn(async (args: StreamChatArgs) => {
      args.onChunk({ type: "delta", content: "生成中" });
      await gate;
    });
    render(
      <ChatContainer
        threadId="t1"
        streamFn={streamFn}
        fetchMessagesFn={async () => []}
      />,
    );
    send("q");
    await screen.findByText("生成中");
    // 楽観 assistant 行は persisted でないため 役立った は無い
    expect(screen.queryByRole("button", { name: /役立った/ })).toBeNull();
    release();
  });

  it("フィードバック失敗時は inline error を表示する", async () => {
    const feedbackFn = vi.fn(async () => {
      throw new Error("500");
    });
    render(
      <ChatContainer
        threadId="t1"
        streamFn={vi.fn(async () => undefined)}
        fetchMessagesFn={async () => history}
        feedbackFn={feedbackFn}
      />,
    );
    fireEvent.click(
      await screen.findByRole("button", { name: /フィードバック: 役立った/ }),
    );
    await waitFor(() =>
      expect(screen.getByRole("alert")).toHaveTextContent(
        "フィードバックの送信に失敗しました",
      ),
    );
  });
});

describe("S-E01 メッセージ分岐 (GAP-031 ①)", () => {
  const history = [
    { id: "m-user", role: "user" as const, content: "質問" },
    { id: "m-asst", role: "assistant" as const, content: "回答です" },
  ];

  it("分岐ボタン → branchFn(実 POST /branch) → onBranched に新スレッド ID", async () => {
    const branchFn = vi.fn(async (_id: string) => "t-branched");
    const onBranched = vi.fn();
    render(
      <ChatContainer
        threadId="t1"
        streamFn={vi.fn(async () => undefined)}
        fetchMessagesFn={async () => history}
        branchFn={branchFn}
        onBranched={onBranched}
      />,
    );
    const btn = await screen.findByRole("button", {
      name: "このメッセージから分岐",
    });
    fireEvent.click(btn);
    await waitFor(() => expect(branchFn).toHaveBeenCalledWith("m-asst"));
    await waitFor(() => expect(onBranched).toHaveBeenCalledWith("t-branched"));
  });

  it("onBranched 未指定なら分岐ボタンを出さない (Rule 10)", async () => {
    render(
      <ChatContainer
        threadId="t1"
        streamFn={vi.fn(async () => undefined)}
        fetchMessagesFn={async () => history}
      />,
    );
    await screen.findByRole("button", { name: "メッセージをコピー" });
    expect(
      screen.queryByRole("button", { name: "このメッセージから分岐" }),
    ).toBeNull();
  });

  it("分岐失敗は inline error (楽観遷移しない)", async () => {
    const branchFn = vi.fn(async () => {
      throw new Error("boom");
    });
    const onBranched = vi.fn();
    render(
      <ChatContainer
        threadId="t1"
        streamFn={vi.fn(async () => undefined)}
        fetchMessagesFn={async () => history}
        branchFn={branchFn}
        onBranched={onBranched}
      />,
    );
    fireEvent.click(
      await screen.findByRole("button", { name: "このメッセージから分岐" }),
    );
    await screen.findByText("分岐に失敗しました。時間をおいて再試行してください。");
    expect(onBranched).not.toHaveBeenCalled();
  });
});

describe("S-E01 ツール実行の承認 (GAP-031 ① 承認して実行 / 差戻)", () => {
  const approval = {
    id: "ap1",
    status: "pending",
    title: "ツール実行の承認: save_deliverable（要件定義書）",
    tool: "save_deliverable",
    tool_input: { title: "要件定義書" },
    created_at: "2026-08-04T00:00:00Z",
  };

  it("pending 承認カード → 承認して実行 → 実行 API + メッセージ/承認の再取得", async () => {
    const executeFn = vi.fn(async (_id: string) => "保存しました");
    let approvals = [approval];
    const approvalsFn = vi.fn(async () => approvals);
    const fetchMessagesFn = vi.fn(async () => [
      { id: "m1", role: "user" as const, content: "保存して" },
    ]);
    render(
      <ChatContainer
        threadId="t1"
        streamFn={vi.fn(async () => undefined)}
        fetchMessagesFn={fetchMessagesFn}
        approvalsFn={approvalsFn}
        executeApprovalFn={executeFn}
        rejectApprovalFn={vi.fn(async () => undefined)}
      />,
    );
    expect(
      await screen.findByText("承認が必要：ツールの実行を進めてよいですか？"),
    ).toBeInTheDocument();
    expect(screen.getByText("要件定義書")).toBeInTheDocument();
    // Inbox で確認 → 実ルート /approvals
    expect(
      screen.getByRole("link", { name: "Inbox で確認" }),
    ).toHaveAttribute("href", "/approvals");

    approvals = []; // 実行後は pending が消える
    fireEvent.click(screen.getByRole("button", { name: "承認して実行" }));
    await waitFor(() => expect(executeFn).toHaveBeenCalledWith("ap1"));
    await waitFor(() =>
      expect(
        screen.queryByText("承認が必要：ツールの実行を進めてよいですか？"),
      ).toBeNull(),
    );
  });

  it("差戻 → reject API → カード消滅", async () => {
    const rejectFn = vi.fn(async (_id: string) => undefined);
    let approvals = [approval];
    const approvalsFn = vi.fn(async () => approvals);
    render(
      <ChatContainer
        threadId="t1"
        streamFn={vi.fn(async () => undefined)}
        fetchMessagesFn={async () => []}
        approvalsFn={approvalsFn}
        executeApprovalFn={vi.fn(async () => "")}
        rejectApprovalFn={rejectFn}
      />,
    );
    await screen.findByText("承認が必要：ツールの実行を進めてよいですか？");
    approvals = [];
    fireEvent.click(screen.getByRole("button", { name: "差戻" }));
    await waitFor(() => expect(rejectFn).toHaveBeenCalledWith("ap1"));
  });

  it("pending が無ければ承認カードを出さない (Rule 10)", async () => {
    render(
      <ChatContainer
        threadId="t1"
        streamFn={vi.fn(async () => undefined)}
        fetchMessagesFn={async () => []}
        approvalsFn={vi.fn(async () => [])}
        executeApprovalFn={vi.fn(async () => "")}
        rejectApprovalFn={vi.fn(async () => undefined)}
      />,
    );
    await waitFor(() =>
      expect(
        screen.queryByText("承認が必要：ツールの実行を進めてよいですか？"),
      ).toBeNull(),
    );
  });
});
