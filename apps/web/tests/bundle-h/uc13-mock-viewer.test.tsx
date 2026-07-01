/**
 * T-UC-13 — S-H01 モックビューア 配線テスト
 *
 *   - GET /mocks/{id} + /content-url を取得し iframe src に署名付き URL を渡す
 *   - storage 未設定(503) の文言表示
 *   - 403 拒否
 */

// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";

import * as React from "react";
import { render, screen } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";
import { ApiError, type ApiClient } from "@atelier/api-client";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createQueryClient } from "../../lib/query-client";
import { MockViewerContainer } from "../../app/mocks/s_h01/_components/MockViewerContainer";

function renderWithQuery(ui: React.ReactElement) {
  const qc = createQueryClient();
  return render(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>);
}

function apiError(status: number): ApiError {
  return new ApiError({
    status,
    statusText: "x",
    payload: undefined,
    path: "/mocks",
    method: "get",
  });
}

function fakeClient(get: unknown): ApiClient {
  const noop = vi.fn(async () => ({ data: {} }));
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

describe("S-H01 MockViewerContainer (T-UC-13)", () => {
  it("renders the iframe with the signed content URL", async () => {
    const get = vi.fn(async (path: string) => {
      if (path.includes("content-url"))
        return { data: { url: "https://storage/signed/login.html?token=x" } };
      return { data: { screen_name: "ログイン画面" } };
    });
    renderWithQuery(
      <MockViewerContainer mockId="m1" client={fakeClient(get)} />,
    );
    const frame = (await screen.findByTitle(
      "ログイン画面",
    )) as HTMLIFrameElement;
    expect(frame).toHaveAttribute(
      "src",
      "https://storage/signed/login.html?token=x",
    );
  });

  it("shows an unconfigured-storage message on 503", async () => {
    const get = vi.fn(async (path: string) => {
      if (path.includes("content-url")) throw apiError(503);
      return { data: { screen_name: "ログイン画面" } };
    });
    renderWithQuery(
      <MockViewerContainer mockId="m1" client={fakeClient(get)} />,
    );
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "保存先が未設定",
    );
  });

  it("shows a forbidden message on 403", async () => {
    const get = vi.fn(async () => {
      throw apiError(403);
    });
    renderWithQuery(
      <MockViewerContainer mockId="m1" client={fakeClient(get)} />,
    );
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "権限がありません",
    );
  });
});
