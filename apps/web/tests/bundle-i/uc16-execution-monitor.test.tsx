/**
 * T-UC-16 — S-I03 実行モニター 配線テスト
 *
 * streamFn を注入し real SSE を叩かずに検証する:
 *   - ExecLogEvent を逐次受け取りログ行へ変換（status_change / end / error）
 *   - stream 例外で inline error を表示
 */

// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";

import * as React from "react";
import { render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ExecutionMonitorContainer } from "../../app/tasks/s_i03/_components/ExecutionMonitorContainer";
import type {
  ExecLogEvent,
  StreamExecLogsArgs,
} from "../../app/tasks/s_i03/_components/execStream";

afterEach(() => vi.clearAllMocks());

describe("S-I03 ExecutionMonitorContainer (T-UC-16)", () => {
  it("renders streamed exec log events as log lines", async () => {
    const streamFn = vi.fn(async (args: StreamExecLogsArgs) => {
      const events: ExecLogEvent[] = [
        {
          type: "status_change",
          status: "running",
          timestamp: "2026-06-20T10:00:01Z",
        },
        {
          type: "error",
          error_summary: "タイムアウト",
          timestamp: "2026-06-20T10:00:05Z",
        },
        { type: "end", status: "failed", timestamp: "2026-06-20T10:00:06Z" },
      ];
      for (const e of events) args.onEvent(e);
    });
    render(<ExecutionMonitorContainer executionId="e1" streamFn={streamFn} />);

    expect(await screen.findByText("状態: running")).toBeInTheDocument();
    expect(screen.getByText("タイムアウト")).toBeInTheDocument();
    expect(screen.getByText("実行終了（状態: failed）")).toBeInTheDocument();
    expect(streamFn.mock.calls[0]![0]!.executionId).toBe("e1");
  });

  it("shows an inline error when the stream throws", async () => {
    const streamFn = vi.fn(async () => {
      throw new Error("connection lost");
    });
    render(<ExecutionMonitorContainer executionId="e1" streamFn={streamFn} />);
    await waitFor(() =>
      expect(screen.getByRole("alert")).toHaveTextContent(
        "実行ログの取得に失敗",
      ),
    );
  });
});
