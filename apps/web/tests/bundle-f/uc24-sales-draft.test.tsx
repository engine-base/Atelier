/**
 * T-UC-24 — S-N01 商談ドラフト コンテナ配線テスト (GAP-018 後の API 面)
 *
 * fake client を注入し real API を叩かずに検証する:
 *   - GET /sales-docs?project_id で全 doc_type 一括取得 → タブ件数バッジ実件数
 *   - 「AI を使わず保存」で POST /sales-docs (doc_type はタブ追従, 構造化 summary)
 *   - 履歴選択 → 編集保存で PATCH /sales-docs/{doc_id}
 *   - 履歴削除 (2 段階) で DELETE /sales-docs/{doc_id}
 * (トニー生成 / PDF / 送信 / 生成トレースは bundle-h/chat-collab.test.tsx が担当)
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

/** /sales-docs には DOC、送信履歴には空を返す GET モック。 */
function getWithDoc() {
  return vi.fn(async (path: string) => ({
    data: path === "/sales-docs" ? [DOC] : [],
  }));
}

afterEach(() => vi.clearAllMocks());

describe("S-N01 SalesDocDraftContainer (T-UC-24)", () => {
  it("lists saved docs from GET /sales-docs (一括取得 + タブ実件数バッジ)", async () => {
    const get = getWithDoc();
    renderWithQuery(
      <SalesDocDraftContainer projectId="p1" client={fakeClient({ get })} />,
    );
    expect(await screen.findByText(/既存提案/)).toBeInTheDocument();
    // GAP-018: doc_type 別クエリではなく project_id のみで一括取得し client 側で振り分け
    const [path, init] = get.mock.calls[0]! as unknown as [
      string,
      { params: { query: Record<string, unknown> } },
    ];
    expect(path).toBe("/sales-docs");
    expect(init.params.query).toEqual({ project_id: "p1" });
    expect(screen.getByRole("tab", { name: /提案書/ })).toHaveTextContent("1");
    expect(screen.getByRole("tab", { name: /見積書/ })).toHaveTextContent("0");
  });

  it("creates via 「AI を使わず保存」 with the active tab doc_type", async () => {
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
    fireEvent.click(screen.getByRole("button", { name: "AI を使わず保存" }));
    await waitFor(() => expect(post).toHaveBeenCalledTimes(1));
    const [path, init] = post.mock.calls[0]! as unknown as [
      string,
      { body: { project_id: string; doc_type: string; summary: string } },
    ];
    expect(path).toBe("/sales-docs");
    expect(init.body.project_id).toBe("p1");
    expect(init.body.doc_type).toBe("proposal");
    expect(init.body.summary).toContain("# 新規案件");
    expect(init.body.summary).toContain("顧客: ACME");
  });

  it("edits the selected doc via PATCH /sales-docs/{doc_id}", async () => {
    const get = getWithDoc();
    const patch = vi.fn(async () => ({ data: {} }));
    renderWithQuery(
      <SalesDocDraftContainer
        projectId="p1"
        client={fakeClient({ get, patch })}
      />,
    );
    fireEvent.click(await screen.findByText(/既存提案/));
    fireEvent.click(await screen.findByRole("button", { name: "編集" }));
    const ta = await screen.findByLabelText("ドラフト本文");
    fireEvent.change(ta, { target: { value: "# 既存提案\n\n改訂本文" } });
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

  it("deletes via DELETE /sales-docs/{doc_id} after 2-step confirm", async () => {
    const get = getWithDoc();
    const del = vi.fn(async () => ({ data: {} }));
    renderWithQuery(
      <SalesDocDraftContainer
        projectId="p1"
        client={fakeClient({ get, delete: del })}
      />,
    );
    await screen.findByText(/既存提案/);
    fireEvent.click(screen.getByRole("button", { name: "v1 を削除" }));
    // 1 クリック目では消えない (2 段階確認)
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

describe("S-N01 宛先の検証は日本語で (GAP-305 / 通し J47-06)", () => {
  it("不正な宛先はアプリの日本語で拒否し、送信 API を呼ばない", async () => {
    const post = vi.fn(async () => ({ data: {} }));
    renderWithQuery(
      <SalesDocDraftContainer projectId="p1" client={fakeClient({ get: getWithDoc(), post })} />,
    );
    fireEvent.click(await screen.findByText(/既存提案/));
    fireEvent.click(await screen.findByRole("button", { name: "送信" }));
    const to = await screen.findByLabelText("宛先メールアドレス");
    fireEvent.change(to, { target: { value: "not-an-address" } });
    fireEvent.click(screen.getByRole("button", { name: "送信する" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("宛先メールアドレスの形式が正しくありません");
    expect(post).not.toHaveBeenCalled();
  });
});
