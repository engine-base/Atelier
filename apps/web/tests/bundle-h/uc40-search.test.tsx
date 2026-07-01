/**
 * T-UC-40 — グローバル検索 配線テスト
 *
 *   - 入力(debounce)後 GET /search?q=&kind= を叩き結果を表示
 *   - 種別フィルタで kind を切替
 *   - 空入力時は案内表示
 */

// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";

import * as React from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";
import { type ApiClient } from "@atelier/api-client";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createQueryClient } from "../../lib/query-client";
import { SearchContainer } from "../../app/t-uc-40/_components/SearchContainer";

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

describe("T-UC-40 SearchContainer", () => {
  it("prompts for input before any query", () => {
    renderWithQuery(
      <SearchContainer client={fakeClient(vi.fn())} debounceMs={0} />,
    );
    expect(
      screen.getByText("キーワードを入力してください。"),
    ).toBeInTheDocument();
  });

  it("searches after debounce and renders hits with kind labels", async () => {
    const get = vi.fn(async () => ({
      data: [
        { id: "p1", kind: "project", title: "Atelier 改善", snippet: "概要" },
        { id: "t1", kind: "task", title: "API 設計", snippet: "" },
      ],
    }));
    renderWithQuery(
      <SearchContainer client={fakeClient(get)} debounceMs={0} />,
    );

    fireEvent.change(screen.getByPlaceholderText("キーワード"), {
      target: { value: "atelier" },
    });

    expect(await screen.findByText("Atelier 改善")).toBeInTheDocument();
    expect(screen.getByText("API 設計")).toBeInTheDocument();
    expect(screen.getAllByText("プロジェクト").length).toBeGreaterThan(0);

    const init = (
      get.mock.calls[0] as unknown as [
        string,
        { params: { query: { q: string; kind: string } } },
      ]
    )[1];
    expect(init.params.query.q).toBe("atelier");
    expect(init.params.query.kind).toBe("all");
  });

  it("narrows the scope with the kind filter", async () => {
    const get = vi.fn(async () => ({ data: [] }));
    renderWithQuery(
      <SearchContainer client={fakeClient(get)} debounceMs={0} />,
    );
    fireEvent.change(screen.getByPlaceholderText("キーワード"), {
      target: { value: "x" },
    });
    await waitFor(() => expect(get).toHaveBeenCalled());
    fireEvent.click(screen.getByRole("button", { name: "タスク" }));
    await waitFor(() => {
      const last = get.mock.calls.at(-1) as unknown as [
        string,
        { params: { query: { kind: string } } },
      ];
      expect(last[1].params.query.kind).toBe("task");
    });
  });
});
