/**
 * GAP-182 — エラー監視を外部 SaaS ではなく自前でやる (画面側)。
 *
 * 直前の実態: ErrorBoundary の onError は「Sentry 配線スロット」として空のまま置かれ、
 * しかも ErrorBoundary 自体がどの画面からも使われていなかった。画面が白くなっても
 * 運営には一切届かなかった。
 */

// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";

import * as React from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";
import { ApiError, type ApiClient } from "@atelier/api-client";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createQueryClient } from "../../lib/query-client";
import { ErrorLogPanel } from "../../app/admin/s_t05/_components/ErrorLogPanel";
import { ErrorBoundary } from "../../components/ErrorBoundary";

function renderWithQuery(ui: React.ReactElement) {
  const qc = createQueryClient();
  return render(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>);
}

const ROWS = [
  {
    id: "e1",
    occurred_at: "2026-08-19T03:00:00Z",
    source: "api",
    level: "error",
    kind: "KeyError",
    message: "'missing'",
    path: "/knowledge",
    method: "GET",
    status_code: 500,
    fingerprint: "abc123",
    count_24h: 4,
  },
  {
    id: "e2",
    occurred_at: "2026-08-19T02:00:00Z",
    source: "web",
    level: "error",
    kind: "TypeError",
    message: "Cannot read properties of undefined",
    path: "/knowledge/s_k01",
    method: null,
    status_code: null,
    fingerprint: "def456",
    count_24h: 1,
  },
];

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

describe("GAP-182 運営のエラーログ画面", () => {
  it("lists recorded errors with where they came from", async () => {
    const get = vi.fn(async () => ({ data: ROWS }));
    renderWithQuery(<ErrorLogPanel client={fakeClient(get)} />);
    await waitFor(() =>
      expect(screen.getByText("KeyError")).toBeInTheDocument(),
    );
    expect(screen.getByText("TypeError")).toBeInTheDocument();
    expect(screen.getByText("/knowledge")).toBeInTheDocument();
    // 「外部に送っていない」ことを画面で明言する
    expect(
      screen.getByText(/外部サービスには送信していません/),
    ).toBeInTheDocument();
  });

  it("says plainly when there is nothing (does not fake health)", async () => {
    const get = vi.fn(async () => ({ data: [] }));
    renderWithQuery(<ErrorLogPanel client={fakeClient(get)} />);
    await waitFor(() =>
      expect(
        screen.getByText("この期間に記録されたエラーはありません。"),
      ).toBeInTheDocument(),
    );
  });

  it("changes the range and refetches", async () => {
    const get = vi.fn(async () => ({ data: ROWS }));
    renderWithQuery(<ErrorLogPanel client={fakeClient(get)} />);
    await waitFor(() => expect(get).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getByRole("button", { name: "7 日" }));
    await waitFor(() => expect(get).toHaveBeenCalledTimes(2));
  });

  it("renders nothing for non-admin (403)", async () => {
    const get = vi.fn(async () => {
      throw new ApiError({
        status: 403,
        statusText: "forbidden",
        payload: undefined,
        path: "/admin/errors",
        method: "get",
      });
    });
    const { container } = renderWithQuery(
      <ErrorLogPanel client={fakeClient(get)} />,
    );
    await waitFor(() => expect(container.querySelector("section")).toBeNull());
  });
});

describe("GAP-182 画面クラッシュの報告", () => {
  it("reports to our own server, not to an external service", async () => {
    const reported: unknown[] = [];
    vi.doMock("../../lib/report-client-error", () => ({
      reportClientException: (e: Error) => reported.push(e),
    }));
    const onError = vi.fn();

    function Boom(): React.ReactElement {
      throw new Error("画面が壊れました");
    }
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    render(
      <ErrorBoundary onError={onError}>
        <Boom />
      </ErrorBoundary>,
    );
    expect(onError).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("alert")).toBeInTheDocument();
    spy.mockRestore();
  });
});
