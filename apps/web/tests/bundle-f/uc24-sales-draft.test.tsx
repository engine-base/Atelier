/**
 * T-UC-24 — S-N01 商談ドラフト 配線テスト
 *
 * fake client を注入し real API を叩かずに検証する:
 *   - フォーム送信で POST /sales-docs (doc_type=proposal, project_id, summary)
 *   - 保存後に入力エコー + 保存確認を表示
 */

// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";

import * as React from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { type ApiClient } from "@atelier/api-client";
import { afterEach, describe, expect, it, vi } from "vitest";

import { SalesDocDraftContainer } from "../../app/sales/s_n01/_components/SalesDocDraftContainer";

function fakeClient(post: unknown, patch?: unknown): ApiClient {
  const noop = vi.fn(async () => ({ data: {} }));
  return {
    get: noop,
    post,
    patch: patch ?? noop,
    delete: noop,
    put: noop,
    request: noop,
  } as unknown as ApiClient;
}

afterEach(() => vi.clearAllMocks());

describe("S-N01 SalesDocDraftContainer (T-UC-24)", () => {
  it("creates a sales doc via POST /sales-docs and shows the result", async () => {
    const post = vi.fn(async () => ({ data: { id: "doc-1" } }));
    render(<SalesDocDraftContainer projectId="p1" client={fakeClient(post)} />);

    fireEvent.change(screen.getByLabelText(/顧客名/), {
      target: { value: "顧客X" },
    });
    fireEvent.change(screen.getByLabelText(/案件/), {
      target: { value: "基幹システム刷新" },
    });
    fireEvent.change(screen.getByLabelText(/商談概要/), {
      target: { value: "既存システムの全面刷新を提案する商談" },
    });
    fireEvent.click(screen.getByRole("button", { name: "ドラフト生成" }));

    await waitFor(() => expect(post).toHaveBeenCalledTimes(1));
    const [path, init] = post.mock.calls[0]! as unknown as [
      string,
      { body: { project_id: string; doc_type: string; summary: string } },
    ];
    expect(path).toBe("/sales-docs");
    expect(init.body.project_id).toBe("p1");
    expect(init.body.doc_type).toBe("proposal");
    expect(init.body.summary).toContain("顧客X");

    const draft = await screen.findByLabelText("生成ドラフト");
    expect(draft).toHaveTextContent("基幹システム刷新");
    expect(draft).toHaveTextContent("保存しました");
    expect(draft).toHaveTextContent("doc-1");
  });

  it("edits the generated draft via PATCH /sales-docs/{id}", async () => {
    const post = vi.fn(async () => ({ data: { id: "doc-1" } }));
    const patch = vi.fn(async () => ({ data: {} }));
    render(
      <SalesDocDraftContainer projectId="p1" client={fakeClient(post, patch)} />,
    );
    fireEvent.change(screen.getByLabelText(/顧客名/), {
      target: { value: "顧客X" },
    });
    fireEvent.change(screen.getByLabelText(/案件/), {
      target: { value: "刷新" },
    });
    fireEvent.change(screen.getByLabelText(/商談概要/), {
      target: { value: "全面刷新を提案する商談メモ" },
    });
    fireEvent.click(screen.getByRole("button", { name: "ドラフト生成" }));
    await screen.findByLabelText("生成ドラフト");

    // 編集 → 本文を書き換えて保存 → PATCH。
    fireEvent.click(screen.getByRole("button", { name: "編集" }));
    fireEvent.change(screen.getByLabelText("ドラフト本文"), {
      target: { value: "手直しした提案本文" },
    });
    fireEvent.click(screen.getByRole("button", { name: "保存" }));
    await waitFor(() => expect(patch).toHaveBeenCalledTimes(1));
    const [path, init] = patch.mock.calls[0]! as unknown as [
      string,
      { params: { path: { doc_id: string } }; body: { summary: string } },
    ];
    expect(path).toBe("/sales-docs/{doc_id}");
    expect(init.params.path.doc_id).toBe("doc-1");
    expect(init.body.summary).toBe("手直しした提案本文");
  });
});
