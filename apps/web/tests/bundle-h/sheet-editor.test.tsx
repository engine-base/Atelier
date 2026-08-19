/**
 * GAP-163 — Excel / CSV をツール内で表として見て直す。
 */

// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";

import * as React from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";
import { ApiError, type ApiClient } from "@atelier/api-client";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createQueryClient } from "../../lib/query-client";
import { SheetEditor } from "../../app/outputs/s_g01/_components/SheetEditor";

function renderWithQuery(ui: React.ReactElement) {
  const qc = createQueryClient();
  return render(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>);
}

const SHEET = {
  file_name: "見積明細.xlsx",
  mime: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  editable: true,
  note: "値のみを表示・編集します (数式・書式・グラフは保持されません)",
  sheets: [{ name: "明細", rows: [["項目", "金額"], ["設計", "300000"]] }],
};

afterEach(() => vi.clearAllMocks());

describe("SheetEditor (GAP-163)", () => {
  it("Excel を表として表示し、保持しないもの (数式・書式) を明示する", async () => {
    const client = {
      get: vi.fn(async () => ({ data: SHEET })),
      post: vi.fn(),
      put: vi.fn(),
      patch: vi.fn(),
      delete: vi.fn(),
      request: vi.fn(),
    } as unknown as ApiClient;
    renderWithQuery(<SheetEditor outputId="o1" client={client} />);
    expect(await screen.findByText("見積明細.xlsx")).toBeInTheDocument();
    expect(screen.getByText(/数式・書式・グラフは保持されません/)).toBeInTheDocument();
    expect(screen.getByLabelText("明細 2行 1列")).toHaveValue("設計");
    expect(screen.getByLabelText("明細 2行 2列")).toHaveValue("300000");
  });

  it("セルを直して保存すると新バージョンとして保存され、その旨を伝える", async () => {
    const post = vi.fn(async () => ({ data: { id: "o2", version: 2 } }));
    const client = {
      get: vi.fn(async () => ({ data: SHEET })),
      post,
      put: vi.fn(),
      patch: vi.fn(),
      delete: vi.fn(),
      request: vi.fn(),
    } as unknown as ApiClient;
    const onSaved = vi.fn();
    renderWithQuery(<SheetEditor outputId="o1" client={client} onSaved={onSaved} />);
    const cell = await screen.findByLabelText("明細 2行 2列");
    fireEvent.change(cell, { target: { value: "450000" } });
    fireEvent.click(screen.getByRole("button", { name: "新しい版として保存" }));
    await waitFor(() => expect(post).toHaveBeenCalled());
    const [path, init] = post.mock.calls[0]! as unknown as [
      string,
      { body: { sheets: { name: string; rows: string[][] }[] } },
    ];
    expect(path).toBe("/outputs/{output_id}/sheet");
    expect(init.body.sheets[0]!.rows[1]).toEqual(["設計", "450000"]);
    expect(await screen.findByRole("status")).toHaveTextContent(
      "v2 として保存しました (元の版は残っています)",
    );
    expect(onSaved).toHaveBeenCalledWith("o2");
  });

  it("PDF 等 (409) は API が返す理由をそのまま出す — 編集できるふりをしない", async () => {
    const client = {
      get: vi.fn(async () => {
        throw new ApiError({
          status: 409,
          statusText: "conflict",
          payload: {
            detail:
              "PDF はこの画面で表示できますが、直接の編集はできません。修正は元の成果物を AI に直してもらってから出し直してください",
          },
          path: "/outputs/{output_id}/sheet",
          method: "get",
        });
      }),
      post: vi.fn(),
      put: vi.fn(),
      patch: vi.fn(),
      delete: vi.fn(),
      request: vi.fn(),
    } as unknown as ApiClient;
    renderWithQuery(<SheetEditor outputId="o1" client={client} />);
    expect(await screen.findByText(/直接の編集はできません/)).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "新しい版として保存" }),
    ).not.toBeInTheDocument();
  });
});
