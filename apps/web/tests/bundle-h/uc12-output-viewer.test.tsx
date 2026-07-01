/**
 * T-UC-12 — S-G01 成果物ビューア 配線テスト
 *
 *   - GET /outputs/{id} + /content-url + /comments を取得し iframe + コメント表示
 *   - HTML 未生成(409) / 権限(403) の文言表示
 */

// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";

import * as React from "react";
import { render, screen } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";
import { ApiError, type ApiClient } from "@atelier/api-client";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createQueryClient } from "../../lib/query-client";
import { OutputViewerContainer } from "../../app/outputs/s_g01/_components/OutputViewerContainer";

function renderWithQuery(ui: React.ReactElement) {
  const qc = createQueryClient();
  return render(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>);
}

function apiError(status: number): ApiError {
  return new ApiError({
    status,
    statusText: "x",
    payload: undefined,
    path: "/outputs",
    method: "get",
  });
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

describe("S-G01 OutputViewerContainer (T-UC-12)", () => {
  it("renders the iframe with the signed URL and the comments", async () => {
    const get = vi.fn(async (path: string) => {
      if (path.includes("content-url"))
        return { data: { url: "https://storage/signed/out.html?token=x" } };
      if (path === "/comments")
        return {
          data: [{ id: "c1", author_user_id: "u1", content: "要修正" }],
        };
      return { data: { summary: "見積書 v2", stage: "estimate" } };
    });
    renderWithQuery(
      <OutputViewerContainer outputId="o1" client={fakeClient(get)} />,
    );
    const frame = (await screen.findByTitle("見積書 v2")) as HTMLIFrameElement;
    expect(frame).toHaveAttribute(
      "src",
      "https://storage/signed/out.html?token=x",
    );
    expect(screen.getByText("要修正")).toBeInTheDocument();
  });

  it("shows a not-generated message on 409", async () => {
    const get = vi.fn(async (path: string) => {
      if (path.includes("content-url")) throw apiError(409);
      return { data: { summary: "draft" } };
    });
    renderWithQuery(
      <OutputViewerContainer outputId="o1" client={fakeClient(get)} />,
    );
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "まだ生成されていません",
    );
  });

  it("shows a forbidden message on 403", async () => {
    const get = vi.fn(async () => {
      throw apiError(403);
    });
    renderWithQuery(
      <OutputViewerContainer outputId="o1" client={fakeClient(get)} />,
    );
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "権限がありません",
    );
  });
});
