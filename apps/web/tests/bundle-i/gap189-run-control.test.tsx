/**
 * GAP-189 — 実行の制御: 中断 / 実行中の追い足し指示 / 繋ぎ直し。
 *
 * 経営者指摘:
 *   「中断とか入ってないけど、これ Claude だとできるけど」
 *   「止まっても裏のターミナルは変わらないんでしょ？ だったら続けてとかで
 *     自動で後ろは繋がるよね？」
 *
 * 直す前は生成中に入力欄が塞がり、止めることも割り込むこともできず、
 * 画面を閉じると走っている実行に戻る手段が無かった。
 */

// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";

import * as React from "react";
import {
  fireEvent,
  render as rtlRender,
  screen,
  waitFor,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ChatContainer } from "../../app/chat/s_e01/_components/ChatContainer";
import type {
  ChatStreamChunk,
  StreamChatArgs,
} from "../../app/chat/s_e01/_components/stream";
import type { QueuedMessage } from "../../app/chat/s_e01/_components/run-control";

function render(ui: React.ReactElement) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return rtlRender(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>);
}

afterEach(() => vi.clearAllMocks());

/** 何も走っていない・待ちも無い、という既定の注入一式。 */
function idleProps() {
  return {
    fetchMessagesFn: async () => [],
    fetchActiveRunFn: async () => null,
    listQueuedFn: async () => [] as readonly QueuedMessage[],
    consumeQueuedFn: async () => null,
  };
}

function type(text: string) {
  fireEvent.change(screen.getByLabelText(/メッセージを入力/), {
    target: { value: text },
  });
}

describe("GAP-189 中断", () => {
  it("実行 ID が届くまで停止ボタンは出ない（死にボタンを置かない）", async () => {
    const streamFn = vi.fn(async (args: StreamChatArgs) => {
      args.onChunk({ type: "delta", content: "考え中" });
      args.onChunk({ type: "end" });
    });
    render(<ChatContainer threadId="t1" streamFn={streamFn} {...idleProps()} />);
    type("やあ");
    fireEvent.click(screen.getByRole("button", { name: "送信" }));
    await screen.findByText("考え中");
    expect(screen.queryByRole("button", { name: "停止" })).toBeNull();
  });

  it("生成中は停止ボタンが出て、押すとその実行 ID で中断が呼ばれる", async () => {
    // オブジェクト経由で保持する（let だと代入が制御フロー解析に見えず never になる）
    const gate: { release: (() => void) | null } = { release: null };
    const streamFn = vi.fn(async (args: StreamChatArgs) => {
      args.onChunk({ type: "run", metadata: { job_id: "job-1" } });
      args.onChunk({ type: "delta", content: "書いている途中" });
      await new Promise<void>((r) => {
        gate.release = r;
      });
      args.onChunk({ type: "cancelled", metadata: {} });
    });
    const cancelRunFn = vi.fn(async () => ({
      status: "cancelled" as const,
      message: "実行を止めました。ここまでの内容はスレッドに残しています。",
      saved_chars: 7,
    }));
    render(
      <ChatContainer
        threadId="t1"
        streamFn={streamFn}
        cancelRunFn={cancelRunFn}
        {...idleProps()}
      />,
    );
    type("長い作業をお願い");
    fireEvent.click(screen.getByRole("button", { name: "送信" }));

    const stop = await screen.findByRole("button", { name: "停止" });
    fireEvent.click(stop);
    await waitFor(() => expect(cancelRunFn).toHaveBeenCalledWith("job-1"));
    gate.release?.();
  });

  it("中断はエラー表示にしない（失敗ではない）", async () => {
    const streamFn = vi.fn(async (args: StreamChatArgs) => {
      const chunks: ChatStreamChunk[] = [
        { type: "run", metadata: { job_id: "job-2" } },
        { type: "delta", content: "ここまで書けた" },
        { type: "cancelled", metadata: { total_chars: 7 } },
      ];
      for (const c of chunks) args.onChunk(c);
    });
    render(<ChatContainer threadId="t1" streamFn={streamFn} {...idleProps()} />);
    type("やあ");
    fireEvent.click(screen.getByRole("button", { name: "送信" }));
    await screen.findByText("ここまで書けた");
    // 赤いエラー行を出さない
    expect(screen.queryByRole("alert")).toBeNull();
  });
});

describe("GAP-189 実行中の追い足し指示", () => {
  it("生成中でも入力できて、送ると待ち行列に積まれる（取りこぼさない）", async () => {
    const gate: { release: (() => void) | null } = { release: null };
    const streamFn = vi.fn(async (args: StreamChatArgs) => {
      args.onChunk({ type: "run", metadata: { job_id: "job-3" } });
      args.onChunk({ type: "delta", content: "実行中" });
      await new Promise<void>((r) => {
        gate.release = r;
      });
      args.onChunk({ type: "end" });
    });
    const queueMessageFn = vi.fn(
      async (_t: string, content: string): Promise<QueuedMessage> => ({
        id: "q1",
        content,
        tools_mode: "off",
      }),
    );
    render(
      <ChatContainer
        threadId="t1"
        streamFn={streamFn}
        queueMessageFn={queueMessageFn}
        {...idleProps()}
      />,
    );
    type("最初のお願い");
    fireEvent.click(screen.getByRole("button", { name: "送信" }));
    await screen.findByText("実行中");

    // 入力欄は塞がっていない
    const box = screen.getByLabelText(/メッセージを入力/);
    expect(box).not.toBeDisabled();

    // 実行中は「あとで送る」になる
    const later = await screen.findByRole("button", { name: /あとで送る/ });
    type("やっぱり色は青で");
    fireEvent.click(later);

    await waitFor(() =>
      expect(queueMessageFn).toHaveBeenCalledWith("t1", "やっぱり色は青で", "off"),
    );
    expect(
      await screen.findByText(/今の実行が終わったら送ります/),
    ).toBeInTheDocument();
    expect(screen.getByText("やっぱり色は青で")).toBeInTheDocument();
    gate.release?.();
  });

  it("実行が終わったら待ちの指示を取り出して続けて流す", async () => {
    const sent: string[] = [];
    const streamFn = vi.fn(async (args: StreamChatArgs) => {
      sent.push(args.userMessage);
      args.onChunk({ type: "delta", content: `応答:${args.userMessage}` });
      args.onChunk({ type: "end" });
    });
    let handed = false;
    const consumeQueuedFn = vi.fn(async (): Promise<QueuedMessage | null> => {
      if (handed) return null;
      handed = true;
      return { id: "q1", content: "追い足しの指示", tools_mode: "off" };
    });
    render(
      <ChatContainer
        threadId="t1"
        streamFn={streamFn}
        {...idleProps()}
        consumeQueuedFn={consumeQueuedFn}
      />,
    );
    type("最初のお願い");
    fireEvent.click(screen.getByRole("button", { name: "送信" }));

    await waitFor(() => expect(sent).toEqual(["最初のお願い", "追い足しの指示"]));
  });

  it("画面を開いたときに残っている待ちの指示を表示する（閉じても消えない）", async () => {
    render(
      <ChatContainer
        threadId="t1"
        streamFn={async () => undefined}
        {...idleProps()}
        listQueuedFn={async () => [
          { id: "q9", content: "前回積んだ指示", tools_mode: "off" as const },
        ]}
      />,
    );
    expect(await screen.findByText("前回積んだ指示")).toBeInTheDocument();
  });

  it("待ちの指示は取り消せる", async () => {
    const dropQueuedFn = vi.fn(async () => undefined);
    render(
      <ChatContainer
        threadId="t1"
        streamFn={async () => undefined}
        {...idleProps()}
        listQueuedFn={async () => [
          { id: "q9", content: "やっぱりやめる指示", tools_mode: "off" as const },
        ]}
        dropQueuedFn={dropQueuedFn}
      />,
    );
    const del = await screen.findByRole("button", {
      name: "あとで送る指示を取り消す: やっぱりやめる指示",
    });
    fireEvent.click(del);
    await waitFor(() => expect(dropQueuedFn).toHaveBeenCalledWith("t1", "q9"));
    await waitFor(() =>
      expect(screen.queryByText("やっぱりやめる指示")).toBeNull(),
    );
  });
});

describe("GAP-189 繋ぎ直し", () => {
  it("開いた時に走っている実行があれば繋ぎ直して続きを表示する", async () => {
    const attachRunFn = vi.fn(
      async (args: { jobId: string; onChunk: (c: ChatStreamChunk) => void }) => {
        args.onChunk({ type: "run", metadata: { job_id: args.jobId } });
        args.onChunk({ type: "delta", content: "閉じている間に書けた分" });
        args.onChunk({ type: "end", metadata: {} });
      },
    );
    render(
      <ChatContainer
        threadId="t1"
        streamFn={async () => undefined}
        {...idleProps()}
        fetchActiveRunFn={async () => ({
          job_id: "job-live",
          status: "running",
        })}
        attachRunFn={attachRunFn}
      />,
    );
    expect(
      await screen.findByText("閉じている間に書けた分"),
    ).toBeInTheDocument();
    expect(attachRunFn).toHaveBeenCalledWith(
      expect.objectContaining({ jobId: "job-live" }),
    );
  });

  it("走っている実行が無ければ繋ぎ直さない", async () => {
    const attachRunFn = vi.fn(async () => undefined);
    render(
      <ChatContainer
        threadId="t1"
        streamFn={async () => undefined}
        {...idleProps()}
        attachRunFn={attachRunFn}
      />,
    );
    await waitFor(() => expect(attachRunFn).not.toHaveBeenCalled());
  });
});
