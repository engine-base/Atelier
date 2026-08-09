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
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
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
            (c as unknown as [string, GetInit | undefined])[1]?.params?.query
              ?.scope === "project",
        ),
      ).toBe(true),
    );
  });

  it("expands a node and fetches children via parent_id", async () => {
    const get = vi.fn(async (_path: string, init?: GetInit) => {
      if (init?.params?.query?.parent_id === "r1") {
        return { data: [knode({ id: "c1", title: "子ノード", parent_id: "r1" })] };
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
          (c as unknown as [string, GetInit | undefined])[1]?.params?.query
            ?.parent_id === "r1",
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

  it("deletes the selected node via DELETE /knowledge/{id} after confirm", async () => {
    const get = vi.fn(async (_path: string, init: GetInit) =>
      init.params.query.parent_id
        ? { data: [] }
        : { data: [knode({ id: "r1", title: "消す対象" })] },
    );
    const del = vi.fn(async () => undefined);
    renderWithQuery(
      <KnowledgeExplorer
        client={fakeClient({ get, delete: del })}
        workspaceId="w1"
      />,
    );
    fireEvent.click(await screen.findByRole("treeitem", { name: "消す対象" }));
    // 右パネルの「削除」→ 2 段階確認 →「削除する」で初めて DELETE が飛ぶ。
    fireEvent.click(await screen.findByRole("button", { name: "削除" }));
    expect(del).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "削除する" }));
    await waitFor(() => expect(del).toHaveBeenCalledTimes(1));
    const [path, init] = del.mock.calls[0]! as unknown as [
      string,
      { params: { path: { knowledge_id: string } } },
    ];
    expect(path).toBe("/knowledge/{knowledge_id}");
    expect(init.params.path.knowledge_id).toBe("r1");
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

// ── v2 (RAG 検索 / リストビュー / 複製 / 関連ナレッジ) ─────────────────────

describe("S-K01 v2: 検索・リスト・複製・関連", () => {
  it("runs real RAG search on submit and lists hits with scores", async () => {
    const get = vi.fn(async () => ({
      data: [knode({ id: "r1", title: "ルート" })],
    }));
    const post = vi.fn(async (path: string) => {
      if (path === "/knowledge/search")
        return {
          data: {
            query: "RLS",
            total: 1,
            hits: [
              { knowledge: knode({ id: "h1", title: "RLS パターン" }), score: 0.91 },
            ],
          },
        };
      return { data: {} };
    });
    renderWithQuery(
      <KnowledgeExplorer client={fakeClient({ get, post })} workspaceId="w1" />,
    );
    await screen.findByRole("treeitem", { name: "ルート" });
    fireEvent.change(screen.getByLabelText("ナレッジを検索（RAG）"), {
      target: { value: "RLS" },
    });
    fireEvent.submit(screen.getByLabelText("ナレッジを検索（RAG）"));
    expect(await screen.findByText("RLS パターン")).toBeInTheDocument();
    expect(screen.getByText("0.91")).toBeInTheDocument();
    const call = post.mock.calls.find((c) => c[0] === "/knowledge/search");
    expect(
      (call as unknown as [string, { body: { query: string } }])[1].body.query,
    ).toBe("RLS");
    // クリアでツリーに戻る
    fireEvent.click(screen.getByRole("button", { name: "検索をクリア" }));
    expect(await screen.findByRole("treeitem", { name: "ルート" })).toBeInTheDocument();
  });

  it("switches to list view showing a flat table of the scope", async () => {
    const get = vi.fn(async (path: string) => {
      if (path === "/knowledge")
        return {
          data: [
            knode({ id: "r1", title: "親", usage_count: 4, confidence_score: 0.8 }),
            knode({ id: "c1", title: "子", parent_id: "r1" }),
          ],
        };
      return { data: [] };
    });
    renderWithQuery(
      <KnowledgeExplorer client={fakeClient({ get })} workspaceId="w1" />,
    );
    await screen.findByRole("treeitem", { name: "親" });
    // 子はツリーのルートに出ない (parent_id フィルタの是正)
    expect(screen.queryByRole("treeitem", { name: "子" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /リスト/ }));
    const table = await screen.findByRole("table");
    expect(within(table).getByText("親")).toBeInTheDocument();
    expect(within(table).getByText("子")).toBeInTheDocument(); // リストはフラット全件
  });

  it("duplicates the selected note via POST /knowledge", async () => {
    const get = vi.fn(async () => ({
      data: [knode({ id: "r1", title: "複製元", tags: ["a"] })],
    }));
    const post = vi.fn(async (..._args: unknown[]) => ({ data: {} }));
    renderWithQuery(
      <KnowledgeExplorer client={fakeClient({ get, post })} workspaceId="w1" />,
    );
    fireEvent.click(await screen.findByRole("treeitem", { name: "複製元" }));
    fireEvent.click(screen.getByRole("button", { name: /複製/ }));
    await waitFor(() =>
      expect(post.mock.calls.some((c) => (c as unknown[])[0] === "/knowledge")).toBe(true),
    );
    const call = post.mock.calls.find(
      (c) => (c as unknown[])[0] === "/knowledge",
    );
    const body = (
      call as unknown as [string, { body: { title: string; tags: string[] } }]
    )[1].body;
    expect(body.title).toBe("複製元（複製）");
    expect(body.tags).toEqual(["a"]);
  });

  it("shows related knowledge from RAG search excluding self", async () => {
    const get = vi.fn(async () => ({
      data: [knode({ id: "r1", title: "選択ノート" })],
    }));
    const post = vi.fn(async (path: string) => {
      if (path === "/knowledge/search")
        return {
          data: {
            query: "選択ノート",
            total: 2,
            hits: [
              { knowledge: knode({ id: "r1", title: "選択ノート" }), score: 1 },
              { knowledge: knode({ id: "k2", title: "関連ノート" }), score: 0.84 },
            ],
          },
        };
      return { data: {} };
    });
    renderWithQuery(
      <KnowledgeExplorer client={fakeClient({ get, post })} workspaceId="w1" />,
    );
    fireEvent.click(await screen.findByRole("treeitem", { name: "選択ノート" }));
    expect(await screen.findByText("関連ノート")).toBeInTheDocument();
    expect(screen.getByText("類似度 0.84")).toBeInTheDocument();
    // 自分自身は関連に出ない (関連セクション内に「選択ノート」ボタンが無い)
    expect(screen.queryByRole("button", { name: /類似度 1\.00/ })).toBeNull();
  });

  it("shows backlinks from GET /knowledge/{id}/references on node select (GAP-012)", async () => {
    const get = vi.fn(async (path: string) =>
      path === "/knowledge/{knowledge_id}/references"
        ? {
            data: {
              knowledge_id: "r1",
              total: 2,
              references: [
                {
                  id: "ref1",
                  referrer_type: "chat_thread",
                  referrer_id: "t1",
                  referrer_title: "RLS 設計の相談",
                  context: "チャット応答で参照（RAG）",
                  reference_count: 3,
                  last_referenced_at: "2026-08-04T00:00:00Z",
                },
                {
                  id: "ref2",
                  referrer_type: "task",
                  referrer_id: "tk1",
                  referrer_title: "T-001 Supabase RLS 設計",
                  context: "タスク実装時に参照",
                  reference_count: 1,
                  last_referenced_at: "2026-08-03T00:00:00Z",
                },
              ],
            },
          }
        : { data: [knode({ id: "r1", title: "選択ノート" })] },
    );
    renderWithQuery(
      <KnowledgeExplorer client={fakeClient({ get })} workspaceId="w1" />,
    );
    fireEvent.click(await screen.findByRole("treeitem", { name: "選択ノート" }));
    const section = await screen.findByRole("region", { name: "バックリンク" });
    expect(section).toHaveTextContent("バックリンク（2）");
    expect(section).toHaveTextContent("RLS 設計の相談");
    expect(section).toHaveTextContent("チャット · チャット応答で参照（RAG） · 3 回");
    expect(section).toHaveTextContent("T-001 Supabase RLS 設計");
    // 再参照 1 回の行は「n 回」を出さない
    expect(section).toHaveTextContent("タスク · タスク実装時に参照");
  });

  it("shows honest empty state when a selected node has no backlinks", async () => {
    const get = vi.fn(async (path: string) =>
      path === "/knowledge/{knowledge_id}/references"
        ? { data: { knowledge_id: "r1", total: 0, references: [] } }
        : { data: [knode({ id: "r1", title: "孤立ノート" })] },
    );
    renderWithQuery(
      <KnowledgeExplorer client={fakeClient({ get })} workspaceId="w1" />,
    );
    fireEvent.click(await screen.findByRole("treeitem", { name: "孤立ノート" }));
    const section = await screen.findByRole("region", { name: "バックリンク" });
    expect(section).toHaveTextContent("まだ参照されていません");
  });
});

describe("S-K01 グラフビュー (GAP-010)", () => {
  const graphData = {
    nodes: [
      {
        id: "g1",
        title: "親ノート",
        category: "tech",
        scope: "common",
        tags: ["rls"],
        usage_count: 4,
      },
      {
        id: "g2",
        title: "子ノート",
        category: "tech",
        scope: "common",
        tags: [],
        usage_count: 0,
      },
    ],
    edges: [{ source: "g1", target: "g2", kind: "parent" }],
    total_nodes: 2,
    truncated: false,
  };

  it("renders real nodes/edges from GET /knowledge/graph and selects on click", async () => {
    const get = vi.fn(async (path: string) =>
      path === "/knowledge/graph"
        ? { data: graphData }
        : path === "/knowledge/{knowledge_id}"
          ? { data: knode({ id: "g1", title: "親ノート" }) }
          : { data: [knode({ id: "g1", title: "親ノート" })] },
    );
    renderWithQuery(
      <KnowledgeExplorer client={fakeClient({ get })} workspaceId="w1" />,
    );
    await screen.findByRole("treeitem", { name: "親ノート" });
    fireEvent.click(screen.getByRole("button", { name: "グラフ" }));
    // 実ノード + エッジ数の説明
    const graph = await screen.findByRole("figure", { name: "ナレッジグラフ" });
    expect(graph).toHaveTextContent("ノード 2 件 · リンク 1 本");
    // ノードクリック → 実 GET /knowledge/{id} → ノートビューへ
    fireEvent.click(screen.getByRole("button", { name: "ナレッジ: 親ノート" }));
    await waitFor(() =>
      expect(
        get.mock.calls.some((c) => c[0] === "/knowledge/{knowledge_id}"),
      ).toBe(true),
    );
    expect(
      await screen.findByRole("heading", { level: 2, name: "親ノート" }),
    ).toBeInTheDocument();
  });

  it("shows honest empty state when the graph has no nodes", async () => {
    const get = vi.fn(async (path: string) =>
      path === "/knowledge/graph"
        ? { data: { nodes: [], edges: [], total_nodes: 0, truncated: false } }
        : { data: [] },
    );
    renderWithQuery(
      <KnowledgeExplorer client={fakeClient({ get })} workspaceId="w1" />,
    );
    fireEvent.click(await screen.findByRole("button", { name: "グラフ" }));
    expect(
      await screen.findByText("グラフに表示できるナレッジがありません"),
    ).toBeInTheDocument();
  });
});

describe("S-K01 Obsidian 連携 (GAP-011)", () => {
  it("renders 「Obsidian で開く」 with obsidian:// URI for the selected note", async () => {
    const get = vi.fn(async (_path: string, init?: GetInit) =>
      init?.params?.query?.parent_id
        ? { data: [] }
        : { data: [knode({ id: "r1", title: "RLS ノート", content_md: "# body" })] },
    );
    renderWithQuery(
      <KnowledgeExplorer client={fakeClient({ get })} workspaceId="w1" />,
    );
    // 未選択時はリンクを出さない
    expect(screen.queryByRole("link", { name: "Obsidian で開く" })).toBeNull();
    fireEvent.click(await screen.findByRole("treeitem", { name: "RLS ノート" }));
    const link = await screen.findByRole("link", { name: "Obsidian で開く" });
    expect(link).toHaveAttribute(
      "href",
      `obsidian://new?name=${encodeURIComponent("RLS ノート")}&content=${encodeURIComponent("# body")}`,
    );
  });

  it("downloads the vault zip via GET /knowledge/vault-export (GAP-011)", async () => {
    const get = vi.fn(async (_path: string, init?: GetInit) =>
      init?.params?.query?.parent_id
        ? { data: [] }
        : { data: [knode({ id: "r1", title: "書出対象" })] },
    );
    const realFetch = global.fetch;
    const fetchMock = vi.fn(async (..._args: unknown[]) =>
      new Response(new Blob(["zip-bytes"]), { status: 200 }),
    );
    global.fetch = fetchMock as unknown as typeof fetch;
    const realCreate = URL.createObjectURL;
    URL.createObjectURL = vi.fn(() => "blob:mock");
    URL.revokeObjectURL = vi.fn();
    try {
      renderWithQuery(
        <KnowledgeExplorer client={fakeClient({ get })} workspaceId="w1" />,
      );
      fireEvent.click(await screen.findByRole("treeitem", { name: "書出対象" }));
      fireEvent.click(
        await screen.findByRole("button", { name: "Obsidian Vault に書出" }),
      );
      await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
      const url = String(fetchMock.mock.calls[0]![0]);
      expect(url).toContain("/knowledge/vault-export?account_id=w1");
    } finally {
      global.fetch = realFetch;
      URL.createObjectURL = realCreate;
    }
  });
});
