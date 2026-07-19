/**
 * T-UC-24 — S-N01 商談ドラフト コンテナ配線テスト (design-audit v2)
 *
 * fake client を注入し real API を叩かずに検証する:
 *   - GET /sales-docs?project_id&doc_type で保存済み一覧 (提案/見積 両タブぶん)
 *   - フォーム送信で POST /sales-docs (doc_type はタブ追従, project_id, summary)
 *   - 履歴選択 → 編集保存で PATCH /sales-docs/{id}
 *   - 履歴削除 (2 段階) で DELETE /sales-docs/{id}
 */

// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";

import * as React from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";
import { type ApiClient } from "@atelier/api-client";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createQueryClient } from "../../lib/query-client";
import { SalesDocDraftContainer } from "../../app/sales/s_n01/_components/SalesDocDraftContainer";

function renderWithQuery(ui: React.ReactElement) {
  const qc = createQueryClient();
  return render(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>);
}

const DOC = {
  id: "d1",
  doc_type: "proposal",
  summary: "# 既存提案\n\n本文",
  version: 1,
  created_at: "2026-07-01T00:00:00Z",
};

function fakeClient(
  impl: Partial<Record<"get" | "post" | "patch" | "delete", unknown>>,
): ApiClient {
  const noop = vi.fn(async () => ({ data: [] }));
  return {
    get: impl.get ?? noop,
    post: impl.post ?? noop,
    patch: impl.patch ?? noop,
    delete: impl.delete ?? noop,
    put: noop,
    request: noop,
  } as unknown as ApiClient;
}

/** proposal タブにのみ DOC を返す GET モック。 */
function getWithProposal() {
  return vi.fn(async (_p: string, init: unknown) => {
    const q = (init as { params: { query: { doc_type: string } } }).params
      .query;
    return { data: q.doc_type === "proposal" ? [DOC] : [] };
  });
}

afterEach(() => vi.clearAllMocks());

describe("S-N01 SalesDocDraftContainer (T-UC-24)", () => {
  it("lists saved docs from GET /sales-docs (both tabs queried, real counts)", async () => {
    const get = getWithProposal();
    renderWithQuery(
      <SalesDocDraftContainer projectId="p1" client={fakeClient({ get })} />,
    );
    expect(await screen.findByText(/既存提案/)).toBeInTheDocument();
    const queried = get.mock.calls.map(
      (c) =>
        (c[1] as { params: { query: { doc_type: string } } }).params.query
          .doc_type,
    );
    expect(queried).toContain("proposal");
    expect(queried).toContain("estimate");
    // タブバッジは実件数
    expect(screen.getByRole("tab", { name: /提案書/ })).toHaveTextContent("1");
    expect(screen.getByRole("tab", { name: /見積書/ })).toHaveTextContent("0");
  });

  it("creates via POST with the active tab doc_type and shows the saved doc", async () => {
    const post = vi.fn(async () => ({
      data: { ...DOC, id: "d9", summary: "# 新規案件\n\n顧客: ACME" },
    }));
    renderWithQuery(
      <SalesDocDraftContainer projectId="p1" client={fakeClient({ post })} />,
    );
    fireEvent.change(await screen.findByLabelText(/顧客名/), {
      target: { value: "ACME" },
    });
    fireEvent.change(screen.getByLabelText(/案件/), {
      target: { value: "新規案件" },
    });
    fireEvent.change(screen.getByLabelText(/商談概要/), {
      target: { value: "十分に長い商談概要のサンプルテキスト" },
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
    expect(init.body.summary).toContain("顧客: ACME");
    expect(
      await screen.findByRole("article", { name: "生成ドラフト" }),
    ).toHaveTextContent("新規案件");
  });

  it("edits the selected doc via PATCH /sales-docs/{id}", async () => {
    const get = getWithProposal();
    const patch = vi.fn(async () => ({ data: {} }));
    renderWithQuery(
      <SalesDocDraftContainer
        projectId="p1"
        client={fakeClient({ get, patch })}
      />,
    );
    fireEvent.click(await screen.findByRole("button", { name: /既存提案/ }));
    fireEvent.click(screen.getByRole("button", { name: "編集" }));
    fireEvent.change(screen.getByLabelText("ドラフト本文"), {
      target: { value: "# 既存提案\n\n改訂本文" },
    });
    fireEvent.click(screen.getByRole("button", { name: "保存" }));
    await waitFor(() => expect(patch).toHaveBeenCalledTimes(1));
    const [path, init] = patch.mock.calls[0]! as unknown as [
      string,
      { params: { path: { doc_id: string } }; body: { summary: string } },
    ];
    expect(path).toBe("/sales-docs/{doc_id}");
    expect(init.params.path.doc_id).toBe("d1");
    expect(init.body.summary).toContain("改訂本文");
  });

  it("deletes via DELETE /sales-docs/{id} after 2-step confirm", async () => {
    const get = getWithProposal();
    const del = vi.fn(async () => undefined);
    renderWithQuery(
      <SalesDocDraftContainer
        projectId="p1"
        client={fakeClient({ get, delete: del })}
      />,
    );
    fireEvent.click(await screen.findByRole("button", { name: "v1 を削除" }));
    expect(del).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "削除する" }));
    await waitFor(() => expect(del).toHaveBeenCalledTimes(1));
    const [path, init] = del.mock.calls[0]! as unknown as [
      string,
      { params: { path: { doc_id: string } } },
    ];
    expect(path).toBe("/sales-docs/{doc_id}");
    expect(init.params.path.doc_id).toBe("d1");
  });
});
