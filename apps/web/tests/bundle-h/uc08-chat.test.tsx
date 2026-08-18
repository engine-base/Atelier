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
import { fireEvent, render as rtlRender, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ChatContainer } from "../../app/chat/s_e01/_components/ChatContainer";

// GAP-129: ChatContainer は接続モード (PC 操作トグルの可視判定) を useQuery で
// 引くため、全 render を QueryClientProvider で包む (接続クエリは retry せず
// 失敗し、トグル非表示のまま従来のテスト対象に影響しない)。
function render(ui: React.ReactElement) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return rtlRender(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>);
}
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

describe("S-E01 チャット添付 (GAP-001)", () => {
  it("添付を選ぶとチップ表示され、送信で upload → stream body に attachments", async () => {
    const uploadAttachmentFn = vi.fn(async (_tid: string, file: File) => ({
      file_name: file.name,
      mime_type: file.type,
      file_size_bytes: file.size,
      storage_path: `chat-attachments/t1/x/${file.name}`,
    }));
    const streamFn = vi.fn(async (args: StreamChatArgs) => {
      args.onChunk({ type: "delta", content: "了解" });
      args.onChunk({ type: "end" });
    });
    render(
      <ChatContainer
        threadId="t1"
        streamFn={streamFn}
        fetchMessagesFn={async () => []}
        approvalsFn={async () => []}
        uploadAttachmentFn={uploadAttachmentFn}
      />,
    );
    const file = new File(["pdf-bytes"], "spec.pdf", { type: "application/pdf" });
    fireEvent.change(screen.getByLabelText("添付ファイルを選択"), {
      target: { files: [file] },
    });
    expect(await screen.findByText(/spec\.pdf/)).toBeInTheDocument();
    send("添付を見て");
    await waitFor(() => expect(streamFn).toHaveBeenCalledTimes(1));
    expect(uploadAttachmentFn).toHaveBeenCalledWith("t1", file);
    const arg = streamFn.mock.calls[0]![0]!;
    expect(arg.attachments).toEqual([
      {
        file_name: "spec.pdf",
        mime_type: "application/pdf",
        file_size_bytes: file.size,
        storage_path: "chat-attachments/t1/x/spec.pdf",
      },
    ]);
  });

  it("許可外ファイルは即時 inline error (upload を呼ばない)", async () => {
    const uploadAttachmentFn = vi.fn(async (..._args: unknown[]) => {
      throw new Error("should not be called");
    });
    render(
      <ChatContainer
        threadId="t1"
        streamFn={vi.fn(async () => undefined)}
        fetchMessagesFn={async () => []}
        approvalsFn={async () => []}
        uploadAttachmentFn={uploadAttachmentFn as never}
      />,
    );
    fireEvent.change(screen.getByLabelText("添付ファイルを選択"), {
      target: {
        files: [new File(["x"], "evil.exe", { type: "application/x-msdownload" })],
      },
    });
    expect(
      await screen.findByText(/対応していないファイル形式です/),
    ).toBeInTheDocument();
    expect(uploadAttachmentFn).not.toHaveBeenCalled();
  });

  it("永続メッセージの添付チップをクリックすると署名付き URL を開く", async () => {
    const attachmentUrlFn = vi.fn(async () => "http://storage.test/signed/spec.pdf");
    const openUrlFn = vi.fn();
    render(
      <ChatContainer
        threadId="t1"
        streamFn={vi.fn(async () => undefined)}
        fetchMessagesFn={async () => [
          {
            id: "m1",
            role: "user",
            content: "添付あり",
            attachments: [
              {
                file_name: "spec.pdf",
                mime_type: "application/pdf",
                file_size_bytes: 2048,
                storage_path: "chat-attachments/t1/x/spec.pdf",
              },
            ],
          },
        ]}
        approvalsFn={async () => []}
        attachmentUrlFn={attachmentUrlFn}
        openUrlFn={openUrlFn}
      />,
    );
    const chip = await screen.findByRole("button", {
      name: "添付を開く: spec.pdf",
    });
    expect(chip).toHaveTextContent("spec.pdf (2 KB)");
    fireEvent.click(chip);
    await waitFor(() =>
      expect(attachmentUrlFn).toHaveBeenCalledWith("m1", 0),
    );
    expect(openUrlFn).toHaveBeenCalledWith("http://storage.test/signed/spec.pdf");
  });
});

describe("S-E01 /コマンド (GAP-002)", () => {
  it("パレットから /決定 を挿入 → 送信でサーバー実行 (SSE は呼ばない)", async () => {
    const commandFn = vi.fn(async () => ({
      command: "decision" as const,
      target_type: "decision",
      target_id: "d1",
      system_message_id: "s1",
      note: "コマンド /決定: 記録しました",
    }));
    const streamFn = vi.fn(async () => undefined);
    const fetchMessagesFn = vi
      .fn()
      .mockResolvedValueOnce([])
      .mockResolvedValue([
        { id: "m1", role: "user", content: "/決定 配色は secondary を正とする" },
        {
          id: "m2",
          role: "system",
          content: "コマンド /決定: 「配色は secondary を正とする」を確定事項として記録しました",
        },
      ]);
    render(
      <ChatContainer
        threadId="t1"
        streamFn={streamFn}
        fetchMessagesFn={fetchMessagesFn}
        approvalsFn={async () => []}
        commandFn={commandFn}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "/コマンド" }));
    fireEvent.click(screen.getByRole("option", { name: /\/決定 <内容>/ }));
    fireEvent.change(screen.getByLabelText(/メッセージを入力/), {
      target: { value: "/決定 配色は secondary を正とする" },
    });
    fireEvent.click(screen.getByRole("button", { name: "送信" }));
    await waitFor(() =>
      expect(commandFn).toHaveBeenCalledWith(
        "t1",
        "decision",
        "配色は secondary を正とする",
      ),
    );
    expect(streamFn).not.toHaveBeenCalled();
    expect(
      await screen.findByText(/確定事項として記録しました/),
    ).toBeInTheDocument();
  });

  it("/要約 は実依頼文に置換して SSE 送信する", async () => {
    const streamFn = vi.fn(async (args: StreamChatArgs) => {
      args.onChunk({ type: "end" });
    });
    render(
      <ChatContainer
        threadId="t1"
        streamFn={streamFn}
        fetchMessagesFn={async () => []}
        approvalsFn={async () => []}
      />,
    );
    fireEvent.change(screen.getByLabelText(/メッセージを入力/), {
      target: { value: "/要約" },
    });
    fireEvent.click(screen.getByRole("button", { name: "送信" }));
    await waitFor(() => expect(streamFn).toHaveBeenCalledTimes(1));
    const arg = streamFn.mock.calls[0]![0]!;
    expect(arg.userMessage).toContain("要点を、決定事項・未解決の論点・次のアクション");
  });

  it("未対応コマンド / 引数なしは inline error (何も実行しない)", async () => {
    const commandFn = vi.fn(async () => {
      throw new Error("should not be called");
    });
    const streamFn = vi.fn(async () => undefined);
    render(
      <ChatContainer
        threadId="t1"
        streamFn={streamFn}
        fetchMessagesFn={async () => []}
        approvalsFn={async () => []}
        commandFn={commandFn as never}
      />,
    );
    fireEvent.change(screen.getByLabelText(/メッセージを入力/), {
      target: { value: "/デプロイ 本番" },
    });
    fireEvent.click(screen.getByRole("button", { name: "送信" }));
    expect(await screen.findByText(/未対応のコマンドです/)).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText(/メッセージを入力/), {
      target: { value: "/決定" },
    });
    fireEvent.click(screen.getByRole("button", { name: "送信" }));
    expect(
      await screen.findByText(/コマンドの内容を入力してください/),
    ).toBeInTheDocument();
    expect(commandFn).not.toHaveBeenCalled();
    expect(streamFn).not.toHaveBeenCalled();
  });
});

describe("S-E01 PC 操作の承認フロー (GAP-130)", () => {
  it("pc_approval chunk で承認カードが出て、許可すると decision API が呼ばれカードが消える", async () => {
    let releaseStream: () => void = () => {};
    const streamFn = vi.fn(async (args: StreamChatArgs) => {
      args.onChunk({
        type: "pc_approval",
        metadata: { id: "ap-9", tool: "Bash", summary: "echo hi" },
      });
      // 承認されるまでストリームは進行中のまま (実挙動と同じ)
      await new Promise<void>((resolve) => {
        releaseStream = resolve;
      });
    });
    const resolveFn = vi.fn(async () => {});
    render(
      <ChatContainer
        threadId="t1"
        streamFn={streamFn}
        fetchMessagesFn={async () => []}
        resolvePcApprovalFn={resolveFn}
      />,
    );
    send("ファイルを作って");
    expect(
      await screen.findByRole("region", { name: "PC 操作の承認" }),
    ).toBeInTheDocument();
    expect(screen.getByText("Bash を実行してもよいですか？")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "許可して実行" }));
    expect(resolveFn).toHaveBeenCalledWith("ap-9", "allow");
    await waitFor(() =>
      expect(
        screen.queryByRole("region", { name: "PC 操作の承認" }),
      ).toBeNull(),
    );
    releaseStream();
  });

  it("pc_approval_resolved chunk (タイムアウト等) でもカードが消える", async () => {
    const streamFn = vi.fn(async (args: StreamChatArgs) => {
      args.onChunk({
        type: "pc_approval",
        metadata: { id: "ap-9", tool: "Write", summary: "/tmp/x" },
      });
      args.onChunk({
        type: "pc_approval_resolved",
        metadata: { id: "ap-9", decision: "timeout" },
      });
      args.onChunk({ type: "delta", content: "了解" });
      args.onChunk({ type: "end" });
    });
    render(
      <ChatContainer
        threadId="t1"
        streamFn={streamFn}
        fetchMessagesFn={async () => []}
        resolvePcApprovalFn={vi.fn(async () => {})}
      />,
    );
    send("ファイルを作って");
    await waitFor(() => expect(screen.getByText("了解")).toBeInTheDocument());
    expect(screen.queryByRole("region", { name: "PC 操作の承認" })).toBeNull();
  });
});
