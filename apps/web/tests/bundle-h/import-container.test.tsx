/**
 * GAP-156 — 既存資料の取り込みコンテナのテスト。
 *
 * ファイル選択 → base64 POST /projects/{id}/import → per-file 結果 →
 * 完了工程の提案チェック → ユーザー確定で flow complete (confirm: true)。
 */

// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";

import * as React from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";
import type { ApiClient } from "@atelier/api-client";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createQueryClient } from "../../lib/query-client";
import { ImportContainer } from "../../app/import/_components/ImportContainer";

function renderWithQuery(ui: React.ReactElement) {
  const qc = createQueryClient();
  return render(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>);
}

const IMPORT_RESULT = {
  results: [
    {
      file_name: "見積書.html",
      type: "output",
      title: "御見積書",
      stage: "estimate",
      version: 1,
    },
    { file_name: "top.html", type: "mock", title: "トップページ", version: 1 },
    { file_name: "archive.zip", error: "対応していない形式です" },
  ],
  imported: 2,
  failed: 1,
  suggested_stage_keys: ["estimate", "design"],
};

afterEach(() => vi.clearAllMocks());

describe("ImportContainer (GAP-156)", () => {
  it("取り込み → per-file 結果 + 提案 → ユーザー確定で flow complete (confirm)", async () => {
    const post = vi.fn(async (path: string) => {
      if (path === "/projects/{project_id}/import") return { data: IMPORT_RESULT };
      return { data: [] };
    });
    const client = {
      post,
      get: vi.fn(),
      put: vi.fn(),
      patch: vi.fn(),
      delete: vi.fn(),
      request: vi.fn(),
    } as unknown as ApiClient;
    renderWithQuery(<ImportContainer projectId="p1" client={client} />);

    const input = screen.getByLabelText(
      "取り込むファイルを選択",
    ) as HTMLInputElement;
    const file = new File(["<html><title>御見積書</title></html>"], "見積書.html", {
      type: "text/html",
    });
    fireEvent.change(input, { target: { files: [file] } });
    fireEvent.click(screen.getByRole("button", { name: "取り込む" }));

    // per-file の結果 (成功 + honest エラー)
    expect(await screen.findByText(/成功 2 \/ 失敗 1/)).toBeInTheDocument();
    expect(screen.getByText(/「御見積書」 v1（見積）/)).toBeInTheDocument();
    expect(screen.getByText(/対応していない形式です/)).toBeInTheDocument();
    // import ペイロード (base64)
    const importCall = post.mock.calls.find(
      (c) => c[0] === "/projects/{project_id}/import",
    ) as unknown as [
      string,
      { body: { files: { file_name: string; content_b64: string }[] } },
    ];
    expect(importCall[1].body.files[0]!.file_name).toBe("見積書.html");
    expect(importCall[1].body.files[0]!.content_b64.length).toBeGreaterThan(10);

    // 提案は既定で全チェック — ユーザー確定で工程ごとに complete (confirm: true)
    fireEvent.click(
      screen.getByRole("button", { name: "2 工程を完了として反映" }),
    );
    await waitFor(() =>
      expect(
        post.mock.calls.filter(
          (c) => c[0] === "/projects/{project_id}/flow/{stage_key}/complete",
        ),
      ).toHaveLength(2),
    );
    const completeCalls = post.mock.calls.filter(
      (c) => c[0] === "/projects/{project_id}/flow/{stage_key}/complete",
    ) as unknown as [
      string,
      { params: { path: { stage_key: string } }; body: { confirm: boolean } },
    ][];
    expect(completeCalls.map((c) => c[1].params.path.stage_key)).toEqual([
      "estimate",
      "design",
    ]);
    expect(completeCalls.every((c) => c[1].body.confirm === true)).toBe(true);
    expect(await screen.findByRole("status")).toHaveTextContent(
      "2 工程を完了として反映しました",
    );
  });

  it("提案のチェックを外した工程は反映しない (ユーザー確定の実質)", async () => {
    const post = vi.fn(async (path: string) => {
      if (path === "/projects/{project_id}/import") return { data: IMPORT_RESULT };
      return { data: [] };
    });
    const client = {
      post,
      get: vi.fn(),
      put: vi.fn(),
      patch: vi.fn(),
      delete: vi.fn(),
      request: vi.fn(),
    } as unknown as ApiClient;
    renderWithQuery(<ImportContainer projectId="p1" client={client} />);
    const input = screen.getByLabelText(
      "取り込むファイルを選択",
    ) as HTMLInputElement;
    fireEvent.change(input, {
      target: { files: [new File(["x"], "a.html", { type: "text/html" })] },
    });
    fireEvent.click(screen.getByRole("button", { name: "取り込む" }));
    await screen.findByText(/成功 2/);
    // design のチェックを外す
    fireEvent.click(screen.getByRole("checkbox", { name: /デザイン・モック/ }));
    fireEvent.click(
      screen.getByRole("button", { name: "1 工程を完了として反映" }),
    );
    await waitFor(() =>
      expect(
        post.mock.calls.filter(
          (c) => c[0] === "/projects/{project_id}/flow/{stage_key}/complete",
        ),
      ).toHaveLength(1),
    );
  });
});
