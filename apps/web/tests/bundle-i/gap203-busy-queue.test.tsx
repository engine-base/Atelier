/**
 * GAP-203 — 混雑を「故障」に見せない
 *
 * これまでの実態:
 *   サーバーは 503 と一緒に日本語で理由を返していたのに、画面側は本文を読まず
 *   `HTTP 503` としてだけ扱っていた。その結果、混んでいるだけなのに
 *   「AI 応答の取得に失敗しました」という汎用エラーが出て、しかも
 *   **打った文章まで消えていた**。
 *
 * ここで固定すること:
 *   - `queued` チャンクで「順番待ち N 番目」を出す (エラーにしない)
 *   - 目安の秒数が無いときは**数字を出さない**
 *   - 席が回ってきたら順番待ち表示が消えて本文が流れる
 *   - 送信が失敗したら **サーバーが返した日本語**をそのまま出す
 *   - 失敗しても **打った文章を入力欄に戻す**
 */

// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";

import * as React from "react";
import { fireEvent, render as rtlRender, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ChatContainer } from "../../app/chat/s_e01/_components/ChatContainer";
import {
  ChatStreamError,
  type ChatStreamChunk,
  type StreamChatArgs,
} from "../../app/chat/s_e01/_components/stream";

function render(ui: React.ReactElement) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return rtlRender(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>);
}

afterEach(() => vi.clearAllMocks());

function send(text: string) {
  fireEvent.change(screen.getByLabelText(/メッセージを入力/), {
    target: { value: text },
  });
  fireEvent.click(screen.getByRole("button", { name: "送信" }));
}

function input(): HTMLTextAreaElement {
  return screen.getByLabelText(/メッセージを入力/) as HTMLTextAreaElement;
}

/** 実際の SSE は待っている間ずっと開いたままなので、テストでも開いたままにする。 */
function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

describe("GAP-203 混雑時の順番待ち", () => {
  it("順番待ちの現在地と目安を出す (エラーにしない)", async () => {
    const open = deferred();
    const streamFn = vi.fn(async (args: StreamChatArgs) => {
      const chunks: ChatStreamChunk[] = [
        { type: "queued", metadata: { position: 3, ahead: 5, eta_seconds: 90 } },
      ];
      for (const c of chunks) args.onChunk(c);
      await open.promise; // 並んでいる間は開いたまま
    });
    render(<ChatContainer threadId="t1" streamFn={streamFn} />);
    send("こんにちは");

    // 「文脈を集めています」も live region なので、役割ではなく文言で特定する
    const notice = await screen.findByText(/順番待ち/);
    expect(notice.closest("[role=status]")).not.toBeNull();
    expect(notice.closest("[role=status]")).toHaveTextContent("順番待ち 3 番目");
    expect(notice.closest("[role=status]")).toHaveTextContent("約 2 分");
    // **エラー扱いにしない** (混雑は故障ではない)
    expect(notice.closest("[role=alert]")).toBeNull();
    open.resolve();
  });

  it("目安が無いときは秒数を出さない (数字を作らない)", async () => {
    const open = deferred();
    const streamFn = vi.fn(async (args: StreamChatArgs) => {
      args.onChunk({
        type: "queued",
        metadata: { position: 1, ahead: 1, eta_seconds: null },
      });
      await open.promise;
    });
    render(<ChatContainer threadId="t1" streamFn={streamFn} />);
    send("こんにちは");

    const notice = await screen.findByText(/順番待ち/);
    expect(notice.closest("[role=status]")).toHaveTextContent("順番待ち 1 番目");
    expect(notice.closest("[role=status]")).not.toHaveTextContent("目安");
    open.resolve();
  });

  it("席が回ってきたら順番待ち表示が消えて本文が流れる", async () => {
    const streamFn = vi.fn(async (args: StreamChatArgs) => {
      args.onChunk({ type: "queued", metadata: { position: 1, eta_seconds: 10 } });
      await new Promise((r) => setTimeout(r, 10));
      args.onChunk({ type: "start" });
      args.onChunk({ type: "delta", content: "順番が来ました" });
      args.onChunk({ type: "end" });
    });
    render(<ChatContainer threadId="t1" streamFn={streamFn} />);
    send("こんにちは");

    await waitFor(() => {
      expect(screen.getByText("順番が来ました")).toBeInTheDocument();
    });
    expect(screen.queryByText(/順番待ち/)).toBeNull();
  });
});

describe("GAP-203 混雑の理由を画面に出す", () => {
  it("サーバーが返した日本語をそのまま出す (汎用エラーで潰さない)", async () => {
    const busy =
      "ただいま大変混み合っています。時間をおいてもう一度お試しください。（お客様の文章は消えていません）";
    const streamFn = vi.fn(async () => {
      throw new ChatStreamError(503, busy);
    });
    render(<ChatContainer threadId="t1" streamFn={streamFn} />);
    send("こんにちは");

    await waitFor(() => {
      expect(screen.getByRole("alert")).toHaveTextContent("大変混み合っています");
    });
    expect(screen.getByRole("alert")).not.toHaveTextContent(
      "AI 応答の取得に失敗しました",
    );
  });

  it("理由が取れないときだけ従来の汎用メッセージにする", async () => {
    const streamFn = vi.fn(async () => {
      throw new Error("boom");
    });
    render(<ChatContainer threadId="t1" streamFn={streamFn} />);
    send("こんにちは");

    await waitFor(() => {
      expect(screen.getByRole("alert")).toHaveTextContent(
        "AI 応答の取得に失敗しました",
      );
    });
  });

  it("失敗しても打った文章を入力欄に戻す", async () => {
    const streamFn = vi.fn(async () => {
      throw new ChatStreamError(503, "ただいま大変混み合っています。");
    });
    render(<ChatContainer threadId="t1" streamFn={streamFn} />);
    send("この長い文章を消されたくない");

    // 送信時にいったん空になるが、失敗したら戻ってくる
    await waitFor(() => {
      expect(input().value).toBe("この長い文章を消されたくない");
    });
  });
});
