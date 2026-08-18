/**
 * GAP-118 — ChatPanel の未カバー挙動テスト (Gate #4 touched 80%)
 *
 * MessageContent 配線 (GAP-118) で ChatPanel が touched になったため、
 * 既存テストで踏んでいなかった実挙動を検証で埋める:
 *   - tool ロールの実行ログカード描画 + toolNameOf の 3 分岐
 *   - assistant メッセージのコピー ボタン (clipboard)
 *   - メンション / ナレッジ / コマンド ピッカー (候補あり/なし・挿入・Escape)
 *   - 添付チップの fmtBytes (B/KB/MB) と開く/外す操作
 *   - ツール承認カードの承認/差戻
 *   - エラー通知の閉じる操作
 */

// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";

import * as React from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  ChatPanel,
  type ChatMessage,
} from "../../app/chat/s_e01/_components/ChatPanel";

afterEach(() => vi.restoreAllMocks());

const noop = () => undefined;

describe("ChatPanel tool メッセージ (GAP-118 coverage)", () => {
  it("renders a tool log card with tool name from JSON {tool}", () => {
    const msgs: ChatMessage[] = [
      {
        id: "t1",
        role: "tool",
        content: '{"tool": "create_task", "input": {"title": "見積"}}',
        created_at: "2026-08-17T09:00:00Z",
      },
    ];
    render(<ChatPanel messages={msgs} onSend={noop} />);
    expect(screen.getByText("create_task")).toBeInTheDocument();
  });

  it("falls back to JSON {name} then to the first plain-text line", () => {
    const msgs: ChatMessage[] = [
      { id: "t1", role: "tool", content: '{"name": "search_docs"}' },
      { id: "t2", role: "tool", content: "grep_logs\n...output..." },
      {
        id: "t3",
        role: "tool",
        content: `${"x".repeat(60)}\nlong first line falls back to generic label`,
      },
    ];
    render(<ChatPanel messages={msgs} onSend={noop} />);
    expect(screen.getByText("search_docs")).toBeInTheDocument();
    expect(screen.getByText("grep_logs")).toBeInTheDocument();
    // 40 文字超の先頭行はツール名とみなさない
    expect(screen.getByText("tool")).toBeInTheDocument();
  });
});

describe("ChatPanel assistant アクション行 (GAP-118 coverage)", () => {
  it("copies the assistant message content to clipboard", async () => {
    const writeText = vi.fn(() => Promise.resolve());
    Object.assign(navigator, { clipboard: { writeText } });
    const msgs: ChatMessage[] = [
      { id: "a1", role: "assistant", content: "回答本文", persisted: true },
    ];
    render(<ChatPanel messages={msgs} onSend={noop} />);
    fireEvent.click(screen.getByRole("button", { name: "メッセージをコピー" }));
    expect(writeText).toHaveBeenCalledWith("回答本文");
    await waitFor(() =>
      expect(screen.getByText("コピーしました")).toBeInTheDocument(),
    );
  });
});

describe("ChatPanel ピッカー (GAP-118 coverage)", () => {
  it("inserts a mention at the cursor and closes the picker", () => {
    render(
      <ChatPanel
        messages={[]}
        onSend={noop}
        mentionCandidates={[{ id: "e1", name: "jarvis", color: "#123456" }]}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /@メンション/ }));
    fireEvent.click(screen.getByRole("option", { name: /jarvis/ }));
    expect(
      (screen.getByLabelText(/メッセージを入力/) as HTMLTextAreaElement).value,
    ).toBe("@jarvis ");
    expect(screen.queryByRole("listbox")).toBeNull();
  });

  it("shows an honest empty state when no mention candidates", () => {
    render(<ChatPanel messages={[]} onSend={noop} />);
    fireEvent.click(screen.getByRole("button", { name: /@メンション/ }));
    expect(
      screen.getByText("メンションできる AI 社員がいません。"),
    ).toBeInTheDocument();
  });

  it("inserts a knowledge reference and shows empty state without candidates", () => {
    const { unmount } = render(
      <ChatPanel
        messages={[]}
        onSend={noop}
        knowledgeCandidates={[{ id: "k1", title: "API 設計指針" }]}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /ナレッジ参照/ }));
    fireEvent.click(screen.getByRole("option", { name: /API 設計指針/ }));
    expect(
      (screen.getByLabelText(/メッセージを入力/) as HTMLTextAreaElement).value,
    ).toBe("[ナレッジ: API 設計指針] ");
    unmount();

    render(<ChatPanel messages={[]} onSend={noop} />);
    fireEvent.click(screen.getByRole("button", { name: /ナレッジ参照/ }));
    expect(
      screen.getByText(/このプロジェクトのナレッジはまだありません/),
    ).toBeInTheDocument();
  });

  it("prepends a command from the command palette (commandsEnabled)", () => {
    render(<ChatPanel messages={[]} onSend={noop} commandsEnabled />);
    fireEvent.click(screen.getByRole("button", { name: /\/コマンド/ }));
    const options = screen.getAllByRole("option");
    expect(options.length).toBeGreaterThan(0);
    fireEvent.click(options[0]!);
    expect(
      (screen.getByLabelText(/メッセージを入力/) as HTMLTextAreaElement).value,
    ).not.toBe("");
    expect(screen.queryByRole("listbox")).toBeNull();
  });

  it("closes the picker with Escape", () => {
    render(<ChatPanel messages={[]} onSend={noop} />);
    fireEvent.click(screen.getByRole("button", { name: /@メンション/ }));
    expect(screen.getByRole("listbox")).toBeInTheDocument();
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByRole("listbox")).toBeNull();
  });
});

describe("ChatPanel 添付チップ (GAP-118 coverage)", () => {
  it("formats sizes in B/KB/MB and opens persisted attachments", () => {
    const onOpenAttachment = vi.fn();
    const msgs: ChatMessage[] = [
      {
        id: "m1",
        role: "user",
        content: "資料です",
        persisted: true,
        attachments: [
          { file_name: "a.txt", mime_type: "text/plain", file_size_bytes: 512 },
          { file_name: "b.pdf", mime_type: "application/pdf", file_size_bytes: 2048 },
          {
            file_name: "c.zip",
            mime_type: "application/zip",
            file_size_bytes: 3 * 1024 * 1024,
          },
        ],
      },
    ];
    render(
      <ChatPanel messages={msgs} onSend={noop} onOpenAttachment={onOpenAttachment} />,
    );
    expect(screen.getByText(/a\.txt \(512 B\)/)).toBeInTheDocument();
    expect(screen.getByText(/b\.pdf \(2 KB\)/)).toBeInTheDocument();
    expect(screen.getByText(/c\.zip \(3\.0 MB\)/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "添付を開く: b.pdf" }));
    expect(onOpenAttachment).toHaveBeenCalledWith("m1", 1);
  });

  it("removes a pending attachment before send", () => {
    const onRemoveAttachment = vi.fn();
    render(
      <ChatPanel
        messages={[]}
        onSend={noop}
        pendingAttachments={[new File(["x"], "draft.md")]}
        onRemoveAttachment={onRemoveAttachment}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "添付を外す: draft.md" }));
    expect(onRemoveAttachment).toHaveBeenCalledWith(0);
  });
});

describe("ChatPanel ツール承認カード + エラー通知 (GAP-118 coverage)", () => {
  it("approves and rejects a pending tool call", () => {
    const onApproveTool = vi.fn();
    const onRejectTool = vi.fn();
    render(
      <ChatPanel
        messages={[]}
        onSend={noop}
        toolApprovals={[
          {
            id: "ap1",
            title: "タスクを起票します",
            tool: "create_task",
            tool_input: { title: "見積り作成" },
          },
        ]}
        onApproveTool={onApproveTool}
        onRejectTool={onRejectTool}
      />,
    );
    expect(screen.getByText("見積り作成")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /承認して実行/ }));
    expect(onApproveTool).toHaveBeenCalledWith("ap1");
    fireEvent.click(screen.getByRole("button", { name: "差戻" }));
    expect(onRejectTool).toHaveBeenCalledWith("ap1");
  });

  it("dismisses the error notice", () => {
    const onDismissError = vi.fn();
    render(
      <ChatPanel
        messages={[]}
        onSend={noop}
        errorNotice="Bridge がオフラインです"
        onDismissError={onDismissError}
      />,
    );
    expect(screen.getByRole("alert")).toHaveTextContent("Bridge がオフライン");
    fireEvent.click(screen.getByRole("button", { name: "エラーを閉じる" }));
    expect(onDismissError).toHaveBeenCalledTimes(1);
  });
});

describe("ChatPanel 生成中インジケータ (GAP-128)", () => {
  const pendingMsg = { id: "a1", role: "assistant" as const, content: "" };

  it("context 段階: 文脈収集中の表示 (実イベント連動)", () => {
    render(
      <ChatPanel
        messages={[pendingMsg]}
        onSend={noop}
        employee={{ name: "ジャービス", color: "#494535" }}
        pendingAssistantId="a1"
        pendingStage="context"
      />,
    );
    expect(screen.getByRole("status")).toHaveTextContent(
      "文脈を集めています (会話履歴とナレッジを検索中)…",
    );
  });

  it("answer 段階: 社員名入りの思考中表示", () => {
    render(
      <ChatPanel
        messages={[pendingMsg]}
        onSend={noop}
        employee={{ name: "ジャービス", color: "#494535" }}
        pendingAssistantId="a1"
        pendingStage="answer"
      />,
    );
    expect(screen.getByRole("status")).toHaveTextContent("ジャービスが考えています…");
  });

  it("streaming 段階: 本文 + 点滅カーソル、生成対象でないメッセージには出さない", () => {
    render(
      <ChatPanel
        messages={[
          { id: "a0", role: "assistant", content: "前の応答" },
          { id: "a1", role: "assistant", content: "途中まで" },
        ]}
        onSend={noop}
        employee={{ name: "ジャービス", color: "#494535" }}
        pendingAssistantId="a1"
        pendingStage="streaming"
      />,
    );
    expect(screen.getByText("途中まで")).toBeInTheDocument();
    // インジケータ (role=status) は本文があるので出ない
    expect(screen.queryByRole("status")).toBeNull();
  });
});

describe("ChatPanel PC 操作トグル + ツール実況 (GAP-129/130)", () => {
  it("トグルは なし → 承認して実行 → 自動 → なし を循環する", () => {
    const onChange = vi.fn();
    const { rerender } = render(
      <ChatPanel
        messages={[]}
        onSend={noop}
        toolsMode="off"
        onToolsModeChange={onChange}
      />,
    );
    const toggle = screen.getByRole("button", {
      name: "PC 操作を切り替える (現在: なし)",
    });
    expect(toggle).toHaveAttribute("aria-pressed", "false");
    fireEvent.click(toggle);
    expect(onChange).toHaveBeenLastCalledWith("approve");
    rerender(
      <ChatPanel
        messages={[]}
        onSend={noop}
        toolsMode="approve"
        onToolsModeChange={onChange}
      />,
    );
    const approveToggle = screen.getByRole("button", {
      name: "PC 操作を切り替える (現在: 承認して実行)",
    });
    expect(approveToggle).toHaveAttribute("aria-pressed", "true");
    fireEvent.click(approveToggle);
    expect(onChange).toHaveBeenLastCalledWith("auto");
    rerender(
      <ChatPanel
        messages={[]}
        onSend={noop}
        toolsMode="auto"
        onToolsModeChange={onChange}
      />,
    );
    fireEvent.click(
      screen.getByRole("button", { name: "PC 操作を切り替える (現在: 自動)" }),
    );
    expect(onChange).toHaveBeenLastCalledWith("off");
  });

  it("トグル未配線 (agent_sdk 以外) では PC 操作ボタン自体を出さない", () => {
    render(<ChatPanel messages={[]} onSend={noop} />);
    expect(screen.queryByText(/PC 操作/)).toBeNull();
  });

  it("toolActivity は Claude Code 風の実値行 (Bash(npm test) 等) で表示される (GAP-136/148)", () => {
    render(
      <ChatPanel
        messages={[]}
        onSend={noop}
        toolActivity={[
          { tool: "Bash", summary: "npm test" },
          { tool: "Write", summary: "src/index.html" },
        ]}
        toolStartedAt={Date.now() - 5000}
      />,
    );
    expect(screen.getByText("PC 操作を実行中")).toBeInTheDocument();
    // 実入力の要約つきの行 (完了 ✓ / 実行中 ⏺)
    expect(screen.getByText("Bash")).toBeInTheDocument();
    expect(screen.getByText("(npm test)")).toBeInTheDocument();
    expect(screen.getByText("Write")).toBeInTheDocument();
    expect(screen.getByText("(src/index.html)")).toBeInTheDocument();
    // 経過秒 (実イベント由来の開始時刻から算出)
    expect(screen.getByText(/経過 \d+ 秒/)).toBeInTheDocument();
  });

  it("GAP-136: 完了後は toolRunSummary で「PC 操作完了」の痕跡を残す", () => {
    render(
      <ChatPanel
        messages={[]}
        onSend={noop}
        toolRunSummary={{ count: 3, seconds: 42, commands: 2, edits: 1 }}
      />,
    );
    expect(
      screen.getByText(
        "PC 操作完了: 3 ツール実行 · コマンド 2 件 · ファイル編集 1 件 (42 秒)",
      ),
    ).toBeInTheDocument();
  });

  it("GAP-136: 実行中 (disabled) は PC 操作トグルが変更不可", () => {
    const onChange = vi.fn();
    render(
      <ChatPanel
        messages={[]}
        onSend={noop}
        disabled
        toolsMode="approve"
        onToolsModeChange={onChange}
      />,
    );
    const btn = screen.getByRole("button", {
      name: "PC 操作を切り替える (現在: 承認して実行)",
    });
    expect(btn).toBeDisabled();
    fireEvent.click(btn);
    expect(onChange).not.toHaveBeenCalled();
  });
});

describe("ChatPanel PC 操作の承認カード (GAP-130)", () => {
  const approvals = [
    { id: "ap-1", tool: "Bash", summary: "echo hello" },
    { id: "ap-2", tool: "Write", summary: "/tmp/a.txt" },
  ];

  it("先頭 1 件を提示し、許可/拒否がそれぞれ decision 付きで呼ばれる", () => {
    const onDecision = vi.fn();
    render(
      <ChatPanel
        messages={[]}
        onSend={noop}
        pcApprovals={approvals}
        onPcApprovalDecision={onDecision}
      />,
    );
    expect(
      screen.getByRole("region", { name: "PC 操作の承認" }),
    ).toBeInTheDocument();
    expect(screen.getByText("Bash を実行してもよいですか？")).toBeInTheDocument();
    expect(screen.getByText("echo hello")).toBeInTheDocument();
    expect(screen.getByText(/他 1 件待ち/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "許可して実行" }));
    expect(onDecision).toHaveBeenLastCalledWith("ap-1", "allow");
    fireEvent.click(screen.getByRole("button", { name: "拒否" }));
    expect(onDecision).toHaveBeenLastCalledWith("ap-1", "deny");
  });

  it("承認待ちが無ければカードを出さない (Rule 10)", () => {
    render(
      <ChatPanel
        messages={[]}
        onSend={noop}
        pcApprovals={[]}
        onPcApprovalDecision={vi.fn()}
      />,
    );
    expect(screen.queryByRole("region", { name: "PC 操作の承認" })).toBeNull();
  });
});
