/**
 * GAP-194 — エラー通知の状態表示 (S-T05)。
 *
 * 直前の実態: GAP-182 でエラーは記録されるが誰にも届かず、画面にも
 * 「届いているのかどうか」がどこにも出ていなかった。
 *
 * ここで固定するのは 1 点 — **通知できていないことを隠さない**。
 */

// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";

import * as React from "react";
import { render, screen, waitFor } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";
import { ApiError, type ApiClient } from "@atelier/api-client";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createQueryClient } from "../../lib/query-client";
import { AlertStatusPanel } from "../../app/admin/s_t05/_components/AlertStatusPanel";

function renderWithQuery(ui: React.ReactElement) {
  const qc = createQueryClient();
  return render(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>);
}

function fakeClient(get: unknown): ApiClient {
  const noop = vi.fn(async () => ({ data: [] }));
  return {
    get,
    post: noop,
    patch: noop,
    delete: noop,
    put: noop,
    request: noop,
  } as unknown as ApiClient;
}

const CONFIGURED = {
  channels: ["email"],
  cooldown_minutes: 60,
  notify_warnings: false,
  max_delay_minutes: 15,
  data: [
    {
      fingerprint: "abc123",
      first_seen_at: "2026-08-20T01:00:00Z",
      last_notified_at: "2026-08-20T01:05:00Z",
      notified_count: 2,
      reported_errors: 7,
      last_status: "sent",
      last_detail: "email 送信",
    },
  ],
};

const UNCONFIGURED = {
  channels: [],
  cooldown_minutes: 60,
  notify_warnings: false,
  max_delay_minutes: 15,
  data: [
    {
      fingerprint: "abc123",
      first_seen_at: "2026-08-20T01:00:00Z",
      last_notified_at: null,
      notified_count: 0,
      reported_errors: 0,
      last_status: "skipped",
      last_detail: "送信先が未設定",
    },
  ],
};

afterEach(() => vi.clearAllMocks());

describe("GAP-194 エラー通知の状態", () => {
  it("送信先が設定されていれば、そのチャネルと冷却時間・遅延を表示する", async () => {
    const get = vi.fn(async () => CONFIGURED);
    renderWithQuery(<AlertStatusPanel client={fakeClient(get)} />);

    await waitFor(() => expect(screen.getByText("メール")).toBeInTheDocument());
    expect(screen.getByText("60 分に 1 回まで")).toBeInTheDocument();
    expect(screen.getByText("最大 15 分")).toBeInTheDocument();
    expect(screen.getByText("送信済み")).toBeInTheDocument();
  });

  it("送信先が未設定なら「どこにも通知できていません」と明示する", async () => {
    const get = vi.fn(async () => UNCONFIGURED);
    renderWithQuery(<AlertStatusPanel client={fakeClient(get)} />);

    await waitFor(() =>
      expect(
        screen.getByText("未設定 — どこにも通知できていません"),
      ).toBeInTheDocument(),
    );
    expect(
      screen.getByText(/ATELIER_ALERT_EMAIL_TO/),
    ).toBeInTheDocument();
    expect(
      screen.getByText("送信先が未設定のため未送信"),
    ).toBeInTheDocument();
  });

  it("送信失敗は「次回再試行」として表示する (成功に見せない)", async () => {
    const get = vi.fn(async () => ({
      ...CONFIGURED,
      data: [
        {
          ...CONFIGURED.data[0],
          last_status: "failed",
          last_notified_at: null,
          notified_count: 0,
          reported_errors: 0,
          last_detail: "email 失敗: TimeoutException",
        },
      ],
    }));
    renderWithQuery(<AlertStatusPanel client={fakeClient(get)} />);

    await waitFor(() =>
      expect(screen.getByText("送信失敗（次回再試行）")).toBeInTheDocument(),
    );
    expect(screen.getByText("email 失敗: TimeoutException")).toBeInTheDocument();
  });

  it("運営 admin 以外 (403) では何も描画しない", async () => {
    const get = vi.fn(async () => {
      throw new ApiError({
        status: 403,
        statusText: "forbidden",
        payload: undefined,
        path: "/admin/alerts",
        method: "get",
      });
    });
    const { container } = renderWithQuery(
      <AlertStatusPanel client={fakeClient(get)} />,
    );
    await waitFor(() => expect(container.querySelector("section")).toBeNull());
  });
});
