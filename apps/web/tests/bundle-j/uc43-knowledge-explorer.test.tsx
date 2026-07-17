/**
 * T-UC-43 — S-K01 ナレッジエクスプローラ 配線テスト
 *
 * api client を fake で注入し real API を叩かずに検証する:
 *   - 既定 scope のルートツリーを tree_only=true で取得・描画
 *   - scope 切替で新 scope の再取得
 *   - ノード展開で parent_id による子取得
 *   - 作成で POST /knowledge → list invalidate
 *   - 左右パネルの独立開閉
 *   - 403 → 拒否表示
 */

// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";

import * as React from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";
import { ApiError, type ApiClient } from "@atelier/api-client";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createQueryClient } from "../../lib/query-client";
import { KnowledgeExplorer } from "../../app/knowledge/s_k01/_components/KnowledgeExplorer";

interface Query {
  account_type: string;
  account_id: string;
  scope: string;
  tree_only?: boolean;
  parent_id?: string;
}
type GetInit = { params: { query: Query } };

function renderWithQuery(ui: React.ReactElement) {
  const qc = createQueryClient();
  return render(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>);
}

function apiError(status: number): ApiError {
  return new ApiError({
    status,
    statusText: "x",
    payload: undefined,
    path: "/knowledge",
    method: "get",
  });
}

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

function knode(
  over: Partial<Record<string, unknown>> & { id: string; title: string },
) {
  return {
    account_id: "w1",
    account_type: "workspace",
    scope: "common",
    category: "カテゴリ",
    content_md: "本文",
    tags: [],
    ...over,
  };
}

afterEach(() => vi.clearAllMocks());

describe("S-K01 KnowledgeExplorer (T-UC-43)", () => {
  it("renders root tree with tree_only=true for default scope (common)", async () => {
    const get = vi.fn(async () => ({
      data: [knode({ id: "r1", title: "ルートA" })],
    }));
    renderWithQuery(
      <KnowledgeExplorer client={fakeClient({ get })} workspaceId="w1" />,
    );
    expect(
      await screen.findByRole("treeitem", { name: "ルートA" }),
    ).toBeInTheDocument();
    const init = (get.mock.calls[0] as unknown as [string, GetInit])[1];
    expect(init.params.query.tree_only).toBe(true);
    expect(init.params.query.scope).toBe("common");
    expect(init.params.query.account_id).toBe("w1");
    expect(init.params.query.account_type).toBe("workspace");
  });

  it("switches scope and refetches with the new scope", async () => {
    const get = vi.fn(async () => ({
      data: [knode({ id: "r1", title: "X" })],
    }));
    renderWithQuery(
      <KnowledgeExplorer client={fakeClient({ get })} workspaceId="w1" />,
    );
    await screen.findByRole("treeitem", { name: "X" });
    fireEvent.click(screen.getByRole("tab", { name: "プロジェクト別" }));
    await waitFor(() =>
      expect(
        get.mock.calls.some(
          (c) =>
            (c as unknown as [string, GetInit])[1].params.query.scope ===
            "project",
        ),
      ).toBe(true),
    );
  });

  it("expands a node and fetches children via parent_id", async () => {
    const get = vi.fn(async (_path: string, init: GetInit) => {
      if (init.params.query.parent_id === "r1") {
        return { data: [knode({ id: "c1", title: "子ノード" })] };
      }
      return { data: [knode({ id: "r1", title: "親ノード" })] };
    });
    renderWithQuery(
      <KnowledgeExplorer client={fakeClient({ get })} workspaceId="w1" />,
    );
    fireEvent.click(await screen.findByRole("treeitem", { name: "親ノード" }));
    expect(
      await screen.findByRole("treeitem", { name: "子ノード" }),
    ).toBeInTheDocument();
    expect(
      get.mock.calls.some(
        (c) =>
          (c as unknown as [string, GetInit])[1].params.query.parent_id ===
          "r1",
      ),
    ).toBe(true);
  });

  it("creates knowledge via POST /knowledge and invalidates", async () => {
    const get = vi.fn(async () => ({
      data: [knode({ id: "r1", title: "X" })],
    }));
    const post = vi.fn(async () => ({ data: { id: "new" } }));
    renderWithQuery(
      <KnowledgeExplorer client={fakeClient({ get, post })} workspaceId="w1" />,
    );
    await screen.findByRole("treeitem", { name: "X" });
    fireEvent.click(screen.getByRole("button", { name: "新規追加" }));
    fireEvent.change(screen.getByLabelText(/タイトル/), {
      target: { value: "新ノード" },
    });
    fireEvent.change(screen.getByLabelText(/カテゴリ/), {
      target: { value: "用語" },
    });
    fireEvent.change(screen.getByLabelText(/本文/), {
      target: { value: "# body" },
    });
    fireEvent.click(screen.getByRole("button", { name: "追加する" }));
    await waitFor(() => expect(post).toHaveBeenCalledTimes(1));
    const [path, init] = post.mock.calls[0]! as unknown as [
      string,
      { body: { scope: string; title: string; account_type: string } },
    ];
    expect(path).toBe("/knowledge");
    expect(init.body.scope).toBe("common");
    expect(init.body.account_type).toBe("workspace");
    expect(init.body.title).toBe("新ノード");
  });

  it("edits the selected node via PATCH /knowledge/{id}", async () => {
    // 子取得(parent_id)では空を返す。ルートを子として返すと自己再帰で無限展開する。
    const get = vi.fn(async (_path: string, init: GetInit) =>
      init.params.query.parent_id
        ? { data: [] }
        : { data: [knode({ id: "r1", title: "旧タイトル" })] },
    );
    const patch = vi.fn(async () => ({ data: {} }));
    renderWithQuery(
      <KnowledgeExplorer
        client={fakeClient({ get, patch })}
        workspaceId="w1"
      />,
    );
    fireEvent.click(await screen.findByRole("treeitem", { name: "旧タイトル" }));
    // 選択で中央に本文が出る → 編集へ。
    fireEvent.click(await screen.findByRole("button", { name: "編集" }));
    fireEvent.change(screen.getByLabelText("タイトル"), {
      target: { value: "新タイトル" },
    });
    fireEvent.click(screen.getByRole("button", { name: "保存" }));
    await waitFor(() => expect(patch).toHaveBeenCalledTimes(1));
    const [path, init] = patch.mock.calls[0]! as unknown as [
      string,
      {
        params: { path: { knowledge_id: string } };
        body: { title: string; content_md: string };
      },
    ];
    expect(path).toBe("/knowledge/{knowledge_id}");
    expect(init.params.path.knowledge_id).toBe("r1");
    expect(init.body.title).toBe("新タイトル");
  });

  it("toggles left and right panels independently", async () => {
    const get = vi.fn(async () => ({
      data: [knode({ id: "r1", title: "X" })],
    }));
    renderWithQuery(
      <KnowledgeExplorer client={fakeClient({ get })} workspaceId="w1" />,
    );
    await screen.findByRole("treeitem", { name: "X" });
    const left = screen.getByRole("button", { name: "ツリーパネルを開閉" });
    const right = screen.getByRole("button", { name: "詳細パネルを開閉" });
    expect(left).toHaveAttribute("aria-pressed", "false");
    fireEvent.click(left);
    expect(left).toHaveAttribute("aria-pressed", "true");
    expect(right).toHaveAttribute("aria-pressed", "false");
    fireEvent.click(right);
    expect(right).toHaveAttribute("aria-pressed", "true");
  });

  it("shows denied state on 403", async () => {
    const get = vi.fn(async () => {
      throw apiError(403);
    });
    renderWithQuery(
      <KnowledgeExplorer client={fakeClient({ get })} workspaceId="w1" />,
    );
    expect(
      await screen.findByText("ナレッジを表示できません"),
    ).toBeInTheDocument();
  });
});
