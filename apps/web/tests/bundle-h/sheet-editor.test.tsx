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

  it("PDF 等でも「AI にファイルごと直してもらう」を出し、本人の PC へ依頼する (GAP-166)", async () => {
    const post = vi.fn(async () => ({ data: { job_id: "job-1" } }));
    const client = {
      get: vi.fn(async () => {
        throw new ApiError({
          status: 409,
          statusText: "conflict",
          payload: { detail: "PDF はこの画面で表示できますが、直接の編集はできません。" },
          path: "/outputs/{output_id}/sheet",
          method: "get",
        });
      }),
      post,
      put: vi.fn(),
      patch: vi.fn(),
      delete: vi.fn(),
      request: vi.fn(),
    } as unknown as ApiClient;
    renderWithQuery(<SheetEditor outputId="o1" client={client} />);
    const box = await screen.findByPlaceholderText(/第 3 条の支払期日/);
    fireEvent.change(box, { target: { value: "支払期日を月末締め翌月末に" } });
    fireEvent.click(screen.getByRole("button", { name: "AI に修正を依頼" }));
    await waitFor(() => expect(post).toHaveBeenCalled());
    const [path, init] = post.mock.calls[0]! as unknown as [
      string,
      { params: { path: { output_id: string } }; body: { instruction: string } },
    ];
    expect(path).toBe("/outputs/{output_id}/ai-file-edit");
    expect(init.params.path.output_id).toBe("o1");
    expect(init.body.instruction).toBe("支払期日を月末締め翌月末に");
    expect(
      await screen.findByText(/あなたの PC の Claude Code に依頼しました/),
    ).toBeInTheDocument();
  });

  it("Bridge 未接続は正直に断り、その場に接続フローを出す (GAP-166 / GAP-168)", async () => {
    const post = vi.fn(async () => {
      throw new ApiError({
        status: 503,
        statusText: "unavailable",
        payload: undefined,
        path: "/outputs/{output_id}/ai-file-edit",
        method: "post",
      });
    });
    const client = {
      get: vi.fn(async () => ({ data: SHEET })),
      post,
      put: vi.fn(),
      patch: vi.fn(),
      delete: vi.fn(),
      request: vi.fn(),
    } as unknown as ApiClient;
    renderWithQuery(<SheetEditor outputId="o1" client={client} />);
    fireEvent.change(await screen.findByPlaceholderText(/第 3 条の支払期日/), {
      target: { value: "明細に保守費を追加" },
    });
    fireEvent.click(screen.getByRole("button", { name: "AI に修正を依頼" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "未接続のためファイルの AI 修正依頼を実行できません",
    );
    expect(
      screen.getByRole("button", { name: "接続トークンを発行" }),
    ).toBeInTheDocument();
  });
});
