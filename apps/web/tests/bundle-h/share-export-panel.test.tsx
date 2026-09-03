/**
 * GAP-162 — 成果物をクライアントに渡す (共有リンク + 書き出し) のテスト。
 */

// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";

import * as React from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";
import type { ApiClient } from "@atelier/api-client";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createQueryClient } from "../../lib/query-client";
import { ShareExportPanel } from "../../app/outputs/s_g01/_components/ShareExportPanel";

const OUT = "out-1";

function renderWithQuery(ui: React.ReactElement) {
  const qc = createQueryClient();
  return render(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>);
}

function clientOf(opts?: {
  links?: unknown[];
  post?: ReturnType<typeof vi.fn>;
}): ApiClient {
  return {
    get: vi.fn(async () => ({ data: opts?.links ?? [] })),
    post:
      opts?.post ??
      vi.fn(async () => ({
        data: { id: "l1", share_url: "https://api.test/share/tok", view_count: 0 },
      })),
    put: vi.fn(),
    patch: vi.fn(),
    delete: vi.fn(),
    request: vi.fn(),
  } as unknown as ApiClient;
}

afterEach(() => vi.clearAllMocks());

describe("ShareExportPanel (GAP-162)", () => {
  it("共有リンクを発行すると URL がその場で出る (再取得できない旨も明示)", async () => {
    const post = vi.fn(async () => ({
      data: { id: "l1", share_url: "https://api.test/share/tok", view_count: 0 },
    }));
    renderWithQuery(<ShareExportPanel outputId={OUT} client={clientOf({ post })} />);
    fireEvent.click(await screen.findByRole("button", { name: /共有リンクを発行/ }));
    await waitFor(() => expect(post).toHaveBeenCalled());
    const [path, init] = post.mock.calls[0]! as unknown as [
      string,
      { params: { path: { output_id: string } }; body: { expires_days: number } },
    ];
    expect(path).toBe("/outputs/{output_id}/share-links");
    expect(init.params.path.output_id).toBe(OUT);
    expect(init.body.expires_days).toBe(14);
    expect(await screen.findByText("https://api.test/share/tok")).toBeInTheDocument();
    expect(await screen.findByRole("status")).toHaveTextContent(
      "この場でしか表示されません",
    );
  });

  it("HTML / Excel は認証付きで取得して保存し、PDF は共有ページの印刷から、という案内を出す (GAP-300)", async () => {
    const fetchExport = vi.fn(async () => new Blob(["<html></html>"], { type: "text/html" }));
    const createObjectURL = vi.fn(() => "blob:test");
    const revokeObjectURL = vi.fn();
    Object.assign(URL, { createObjectURL, revokeObjectURL });
    renderWithQuery(
      <ShareExportPanel
        outputId={OUT}
        client={clientOf()}
        exportUrlOf={(id, f) => `http://api.test/outputs/${id}/export?format=${f}`}
        fetchExport={fetchExport}
      />,
    );
    fireEvent.click(await screen.findByRole("button", { name: "HTML で保存" }));
    await waitFor(() =>
      expect(fetchExport).toHaveBeenCalledWith("http://api.test/outputs/out-1/export?format=html"),
    );
    await waitFor(() => expect(createObjectURL).toHaveBeenCalled());
    fireEvent.click(screen.getByRole("button", { name: "Excel で保存" }));
    await waitFor(() =>
      expect(fetchExport).toHaveBeenCalledWith("http://api.test/outputs/out-1/export?format=xlsx"),
    );
    // 素の <a href> は Authorization が付かず 404 になっていた — リンクは出さない
    expect(screen.queryByRole("link", { name: "HTML で保存" })).toBeNull();
    expect(screen.getByText(/PDF は共有リンクを開いて/)).toBeInTheDocument();
  });

  it("有効なリンクを一覧し、無効化で revoke API を叩く", async () => {
    const post = vi.fn(async () => ({ data: {} }));
    renderWithQuery(
      <ShareExportPanel
        outputId={OUT}
        client={clientOf({
          links: [
            {
              id: "l9",
              label: "",
              expires_at: "2026-09-01T00:00:00Z",
              revoked_at: null,
              view_count: 3,
            },
          ],
          post,
        })}
      />,
    );
    expect(await screen.findByText(/2026-09-01 00:00 まで有効/)).toBeInTheDocument();
    expect(screen.getByText("閲覧 3 回")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "この共有リンクを無効化" }));
    await waitFor(() => expect(post).toHaveBeenCalled());
    const [path, init] = post.mock.calls[0]! as unknown as [
      string,
      { params: { path: { link_id: string } } },
    ];
    expect(path).toBe("/share-links/{link_id}/revoke");
    expect(init.params.path.link_id).toBe("l9");
  });
});
