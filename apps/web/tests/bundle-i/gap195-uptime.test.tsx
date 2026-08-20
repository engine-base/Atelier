/**
 * GAP-195 — 外形監視の表示 (S-T05)。
 *
 * 直前の実態: サーバーが完全に落ちると自前のログには何も残らず、画面にも
 * 「落ちていた」痕跡が一切出なかった。
 *
 * ここで固定するのは 2 点 —
 *   ① 落ちていた事実と 24h 稼働率がそのまま出ること
 *   ② 観測が 1 件も無いときに「異常なし」に見せないこと
 */

// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";

import * as React from "react";
import { render, screen, waitFor } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";
import { ApiError, type ApiClient } from "@atelier/api-client";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createQueryClient } from "../../lib/query-client";
import { UptimePanel } from "../../app/admin/s_t05/_components/UptimePanel";

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

afterEach(() => vi.clearAllMocks());

describe("GAP-195 外形監視", () => {
  it("応答なしの対象を赤字で出し、停止開始時刻と稼働率を表示する", async () => {
    const get = vi.fn(async () => ({
      interval_minutes: 15,
      last_observed_at: "2026-08-20T04:00:00Z",
      data: [
        {
          target: "api",
          ok: false,
          last_checked_at: "2026-08-20T04:00:00Z",
          since: "2026-08-20T03:00:00Z",
          availability_24h: 87.5,
          checks_24h: 96,
          last_error: "HTTP 503",
          last_latency_ms: null,
        },
      ],
    }));
    renderWithQuery(<UptimePanel client={fakeClient(get)} />);

    await waitFor(() =>
      expect(screen.getByText("応答なし")).toBeInTheDocument(),
    );
    expect(screen.getByText("サーバー (API)")).toBeInTheDocument();
    expect(screen.getByText("HTTP 503")).toBeInTheDocument();
    expect(screen.getByText("87.5%")).toBeInTheDocument();
    expect(screen.getByText("(96 回)")).toBeInTheDocument();
  });

  it("応答ありなら遅延を表示する", async () => {
    const get = vi.fn(async () => ({
      interval_minutes: 15,
      last_observed_at: "2026-08-20T04:00:00Z",
      data: [
        {
          target: "web",
          ok: true,
          last_checked_at: "2026-08-20T04:00:00Z",
          since: "2026-08-18T00:00:00Z",
          availability_24h: 100,
          checks_24h: 96,
          last_error: null,
          last_latency_ms: 142,
        },
      ],
    }));
    renderWithQuery(<UptimePanel client={fakeClient(get)} />);

    await waitFor(() =>
      expect(screen.getByText("応答あり")).toBeInTheDocument(),
    );
    expect(screen.getByText("画面 (Web)")).toBeInTheDocument();
    expect(screen.getByText("142 ms")).toBeInTheDocument();
  });

  it("観測が 1 件も無いとき「異常なし」に見せない", async () => {
    const get = vi.fn(async () => ({
      interval_minutes: 15,
      last_observed_at: null,
      data: [],
    }));
    renderWithQuery(<UptimePanel client={fakeClient(get)} />);

    await waitFor(() =>
      expect(
        screen.getByText(/外からの観測がまだ 1 件もありません/),
      ).toBeInTheDocument(),
    );
    expect(
      screen.getByText(/監視が動いていない可能性があります/),
    ).toBeInTheDocument();
  });

  it("運営 admin 以外 (403) では何も描画しない", async () => {
    const get = vi.fn(async () => {
      throw new ApiError({
        status: 403,
        statusText: "forbidden",
        payload: undefined,
        path: "/admin/uptime",
        method: "get",
      });
    });
    const { container } = renderWithQuery(
      <UptimePanel client={fakeClient(get)} />,
    );
    await waitFor(() => expect(container.querySelector("section")).toBeNull());
  });
});
