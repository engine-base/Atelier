/**
 * T-UC-12 / GAP-023 — S-G01 成果物ビューア 配線テスト
 *
 *   - GET /outputs/{id} + /content-url(format) + /versions + /anchors +
 *     /fix-proposals + /comments を取得し iframe + コメント表示
 *   - format タブは実在するものだけ (Rule 10) / バージョン選択で遷移
 *   - 「編集」= スティーブへの修正依頼 (POST /outputs/{id}/revise)
 *   - 対象位置チップ + 本文へジャンプ (#element_id) / 返信 (parent_comment_id)
 *   - AI 修正提案: 依頼 → pending → 承認 (新バージョン遷移) / 却下
 *   - HTML 未生成(409) / 権限(403) の文言表示
 */

// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";

import * as React from "react";
import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";
import { ApiError, type ApiClient } from "@atelier/api-client";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createQueryClient } from "../../lib/query-client";
import { OutputViewerContainer } from "../../app/outputs/s_g01/_components/OutputViewerContainer";

const { routerPush } = vi.hoisted(() => ({ routerPush: vi.fn() }));
vi.mock("next/navigation", () => ({
  useSearchParams: () => new URLSearchParams("output=o1"),
  useRouter: () => ({ push: routerPush }),
}));

function renderWithQuery(ui: React.ReactElement) {
  const qc = createQueryClient();
  return render(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>);
}

function apiError(status: number): ApiError {
  return new ApiError({
    status,
    statusText: "x",
    payload: undefined,
    path: "/outputs",
    method: "get",
  });
}

const META = {
  id: "o1",
  summary: "要件定義書",
  stage: "requirements",
  version: 1,
  html_path: "outputs/x/doc.html",
  json_path: null,
  md_path: null,
  meta: {},
  created_at: "2026-07-01T10:00:00Z",
};

const VERSIONS = [
  { ...META },
  {
    ...META,
    id: "o2",
    version: 2,
    created_at: "2026-07-02T09:00:00Z",
    meta: { author: "steve", revision_instruction: "可視範囲を追記" },
  },
];

/** 標準系 get: meta / content-url / versions / anchors / fix-proposals / comments。 */
function standardGet(overrides?: {
  meta?: () => { data: unknown };
  comments?: () => { data: unknown[] };
  proposals?: () => { data: unknown[] };
}) {
  return vi.fn(async (path: string) => {
    if (path.includes("content-url"))
      return { data: { url: "https://storage/signed/out.html?token=x" } };
    if (path.includes("versions")) return { data: VERSIONS };
    if (path.includes("anchors"))
      return {
        data: [
          { element_id: "sec-1", label: "1. プロジェクト概要" },
          { element_id: "sec-2", label: "2. 成功の定義" },
        ],
      };
    if (path.includes("fix-proposals"))
      return overrides?.proposals ? overrides.proposals() : { data: [] };
    if (path === "/comments")
      return overrides?.comments ? overrides.comments() : { data: [] };
    return overrides?.meta ? overrides.meta() : { data: META };
  });
}

function clientOf(get: unknown, post?: unknown, patch?: unknown): ApiClient {
  const noop = vi.fn(async () => ({ data: [] }));
  return {
    get,
    post: post ?? noop,
    patch: patch ?? noop,
    delete: noop,
    put: noop,
    request: noop,
  } as unknown as ApiClient;
}

afterEach(() => vi.clearAllMocks());

describe("S-G01 OutputViewerContainer (T-UC-12 / GAP-023)", () => {
  it("renders the iframe with the signed URL and the comments", async () => {
    const get = standardGet({
      comments: () => ({
        data: [{ id: "c1", author_user_id: "u1", content: "要修正" }],
      }),
    });
    renderWithQuery(
      <OutputViewerContainer outputId="o1" client={clientOf(get)} />,
    );
    const frame = (await screen.findByTitle("要件定義書")) as HTMLIFrameElement;
    expect(frame).toHaveAttribute(
      "src",
      "https://storage/signed/out.html?token=x",
    );
    expect(screen.getByText("要修正")).toBeInTheDocument();
  });

  it("renders only the formats that exist (Rule 10) and switches tabs", async () => {
    const get = standardGet();
    renderWithQuery(
      <OutputViewerContainer outputId="o1" client={clientOf(get)} />,
    );
    await screen.findByTitle("要件定義書");
    expect(screen.getByRole("tab", { name: "HTML" })).toBeInTheDocument();
    // json/md 未生成 → タブ自体を出さない
    expect(screen.queryByRole("tab", { name: "JSON" })).not.toBeInTheDocument();
    expect(screen.queryByRole("tab", { name: "MD" })).not.toBeInTheDocument();
  });

  it("shows the MD tab when md_path exists and renders the fetched text", async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      text: async () => "# 見出し\n本文",
    }));
    vi.stubGlobal("fetch", fetchMock);
    const get = standardGet({
      meta: () => ({ data: { ...META, md_path: "outputs/x/doc.md" } }),
    });
    renderWithQuery(
      <OutputViewerContainer outputId="o1" client={clientOf(get)} />,
    );
    await screen.findByTitle("要件定義書");
    fireEvent.click(screen.getByRole("tab", { name: "MD" }));
    expect(await screen.findByText(/# 見出し/)).toBeInTheDocument();
    vi.unstubAllGlobals();
  });

  it("renders the real version select and navigates on change", async () => {
    const get = standardGet();
    renderWithQuery(
      <OutputViewerContainer outputId="o1" client={clientOf(get)} />,
    );
    await screen.findByTitle("要件定義書");
    const select = screen.getByRole("combobox", { name: "バージョン選択" });
    // スティーブ改訂バージョンは author を表示
    expect(select).toHaveTextContent("スティーブ（更新）");
    fireEvent.change(select, { target: { value: "o2" } });
    expect(routerPush).toHaveBeenCalledWith("/outputs?output=o2");
  });

  it("sends a revision request to Steve (POST /outputs/{id}/revise) and navigates", async () => {
    const get = standardGet();
    const post = vi.fn(async () => ({ data: { id: "o3", version: 3 } }));
    renderWithQuery(
      <OutputViewerContainer outputId="o1" client={clientOf(get, post)} />,
    );
    await screen.findByTitle("要件定義書");
    fireEvent.click(screen.getByRole("button", { name: "編集" }));
    expect(
      screen.getByRole("dialog", { name: "スティーブに修正を依頼" }),
    ).toBeInTheDocument();
    fireEvent.change(screen.getByRole("textbox", { name: "修正指示" }), {
      target: { value: "2.5 項を追加" },
    });
    fireEvent.click(screen.getByRole("button", { name: "修正を依頼" }));
    await waitFor(() => expect(post).toHaveBeenCalledTimes(1));
    const [path, init] = post.mock.calls[0]! as unknown as [
      string,
      { params: { path: { output_id: string } }; body: { instruction: string } },
    ];
    expect(path).toBe("/outputs/{output_id}/revise");
    expect(init.params.path.output_id).toBe("o1");
    expect(init.body.instruction).toBe("2.5 項を追加");
    await waitFor(() =>
      expect(routerPush).toHaveBeenCalledWith("/outputs?output=o3"),
    );
    expect(
      screen.getByText("スティーブが v3 を作成しました。"),
    ).toBeInTheDocument();
  });

  it("posts a comment with the selected anchor (target_element_id)", async () => {
    const get = standardGet();
    const post = vi.fn(async () => ({ data: { id: "c9" } }));
    renderWithQuery(
      <OutputViewerContainer outputId="o1" client={clientOf(get, post)} />,
    );
    const ta = (await screen.findByPlaceholderText(
      "選択箇所にコメント...",
    )) as HTMLTextAreaElement;
    fireEvent.change(
      screen.getByRole("combobox", { name: "コメント対象位置" }),
      { target: { value: "sec-2" } },
    );
    fireEvent.change(ta, { target: { value: "内訳を分けてほしい" } });
    fireEvent.click(screen.getByRole("button", { name: "投稿" }));
    await waitFor(() => expect(post).toHaveBeenCalledTimes(1));
    const [path, init] = post.mock.calls[0]! as unknown as [
      string,
      { body: Record<string, string> },
    ];
    expect(path).toBe("/comments");
    expect(init.body).toEqual({
      target_type: "workflow_output",
      target_id: "o1",
      content: "内訳を分けてほしい",
      target_element_id: "sec-2",
    });
  });

  it("shows the anchor chip and jumps to the element via URL fragment", async () => {
    const get = standardGet({
      comments: () => ({
        data: [
          {
            id: "c1",
            author_user_id: "u1",
            content: "定義を具体化したい",
            target_element_id: "sec-1",
          },
        ],
      }),
    });
    renderWithQuery(
      <OutputViewerContainer outputId="o1" client={clientOf(get)} />,
    );
    // 対象位置は anchors 由来の実ラベルで表示 (コメントカード内にスコープ)
    const item = await screen.findByRole("listitem");
    await waitFor(() =>
      expect(
        within(item).getByText("1. プロジェクト概要"),
      ).toBeInTheDocument(),
    );
    fireEvent.click(within(item).getByRole("button", { name: "本文へ →" }));
    const frame = screen.getByTitle("要件定義書") as HTMLIFrameElement;
    expect(frame.src).toBe("https://storage/signed/out.html?token=x#sec-1");
  });

  it("replies to a comment with parent_comment_id", async () => {
    const get = standardGet({
      comments: () => ({
        data: [{ id: "c1", author_user_id: "u1", content: "親コメント" }],
      }),
    });
    const post = vi.fn(async () => ({ data: { id: "c2" } }));
    renderWithQuery(
      <OutputViewerContainer outputId="o1" client={clientOf(get, post)} />,
    );
    await screen.findByText("親コメント");
    fireEvent.click(screen.getByRole("button", { name: "返信" }));
    fireEvent.change(screen.getByPlaceholderText("返信を入力…"), {
      target: { value: "了解です" },
    });
    fireEvent.click(screen.getByRole("button", { name: "返信する" }));
    await waitFor(() => expect(post).toHaveBeenCalledTimes(1));
    const [path, init] = post.mock.calls[0]! as unknown as [
      string,
      { body: Record<string, string> },
    ];
    expect(path).toBe("/comments");
    expect(init.body.parent_comment_id).toBe("c1");
    expect(init.body.content).toBe("了解です");
  });

  it("requests a fix proposal from Steve and approves it into a new version", async () => {
    const proposals: unknown[] = [];
    const get = standardGet({
      comments: () => ({
        data: [{ id: "c1", author_user_id: "u1", content: "可視範囲を明示して" }],
      }),
      proposals: () => ({ data: [...proposals] }),
    });
    const post = vi.fn(async (path: string) => {
      if (path === "/comments/{comment_id}/fix-proposal") {
        proposals.push({
          id: "p1",
          comment_id: "c1",
          output_id: "o1",
          proposal: "2.5 項に可視範囲サブセクションを追加します。",
          status: "pending",
        });
        return { data: proposals[0] };
      }
      if (path === "/output-fix-proposals/{proposal_id}/approve") {
        return {
          data: {
            proposal: { id: "p1", status: "approved" },
            new_output: { id: "o3", version: 3 },
          },
        };
      }
      return { data: {} };
    });
    renderWithQuery(
      <OutputViewerContainer outputId="o1" client={clientOf(get, post)} />,
    );
    await screen.findByText("可視範囲を明示して");
    fireEvent.click(
      screen.getByRole("button", { name: "スティーブに修正提案を依頼" }),
    );
    // pending 提案 (ai-fix ブロック) が実描画される
    expect(
      await screen.findByText("2.5 項に可視範囲サブセクションを追加します。"),
    ).toBeInTheDocument();
    expect(screen.getByText("スティーブの修正提案：")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "承認" }));
    await waitFor(() =>
      expect(routerPush).toHaveBeenCalledWith("/outputs?output=o3"),
    );
    expect(
      screen.getByText("提案を承認し、スティーブが v3 を作成しました。"),
    ).toBeInTheDocument();
  });

  it("rejects a fix proposal without changing the document", async () => {
    const get = standardGet({
      comments: () => ({
        data: [{ id: "c1", author_user_id: "u1", content: "別件" }],
      }),
      proposals: () => ({
        data: [
          {
            id: "p1",
            comment_id: "c1",
            output_id: "o1",
            proposal: "追記します。",
            status: "pending",
          },
        ],
      }),
    });
    const post = vi.fn(async () => ({ data: { id: "p1", status: "rejected" } }));
    renderWithQuery(
      <OutputViewerContainer outputId="o1" client={clientOf(get, post)} />,
    );
    await screen.findByText("追記します。");
    fireEvent.click(screen.getByRole("button", { name: "却下" }));
    await waitFor(() => expect(post).toHaveBeenCalledTimes(1));
    const [path] = post.mock.calls[0]! as unknown as [string];
    expect(path).toBe("/output-fix-proposals/{proposal_id}/reject");
    expect(
      await screen.findByText(
        "提案を却下しました（文書は変更されていません）。",
      ),
    ).toBeInTheDocument();
    expect(routerPush).not.toHaveBeenCalled();
  });

  it("renders the viewer with comments (no preview) on 409 — journey v2 是正", async () => {
    // 営業ドラフト等の本文なし成果物: 画面ごと拒否せず、コメント返信と
    // バージョン確認は可能にする (客コメント往復の断絶防止)。
    const get = vi.fn(async (path: string) => {
      if (path.includes("content-url")) throw apiError(409);
      if (
        path.includes("versions") ||
        path.includes("anchors") ||
        path.includes("fix-proposals")
      )
        return { data: [] };
      if (path === "/comments")
        return {
          data: [
            {
              id: "c-client",
              content: "内訳を確認したいです",
              author_invitation_id: "inv-1",
              created_at: "2026-08-11T00:00:00Z",
              status: "open",
            },
          ],
        };
      return { data: { summary: "LP一式お見積" } };
    });
    renderWithQuery(
      <OutputViewerContainer outputId="o1" client={clientOf(get)} />,
    );
    expect(
      await screen.findByText(/この成果物は本文ファイルを持ちません/),
    ).toBeInTheDocument();
    // クライアントのコメントに返信できる (往復の成立)
    expect(screen.getByText("内訳を確認したいです")).toBeInTheDocument();
    expect(screen.getByText("クライアント（招待）")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "返信" })).toBeInTheDocument();
    // 死にボタンを出さない: 編集 (スティーブ) / 原本 / DL はプレビュー無しでは非表示
    expect(screen.queryByRole("button", { name: "編集" })).toBeNull();
    expect(screen.queryByRole("link", { name: "原本" })).toBeNull();
    expect(screen.queryByRole("button", { name: "DL" })).toBeNull();
  });

  it("shows a forbidden message on 403", async () => {
    const get = vi.fn(async () => {
      throw apiError(403);
    });
    renderWithQuery(
      <OutputViewerContainer outputId="o1" client={clientOf(get)} />,
    );
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "権限がありません",
    );
  });
});

describe("S-G01 差分と復元 (GAP-155)", () => {
  const DIFF = {
    from_id: "o1",
    from_version: 1,
    to_id: "o2",
    to_version: 2,
    added: 2,
    removed: 1,
    identical: false,
    diff: "--- v1\n+++ v2\n@@ -1,3 +1,4 @@\n-<p>旧仕様</p>\n+<p>新仕様</p>\n+<p>追記</p>",
  };

  it("最新版表示中は「前版との差分」→ GET diff → モーダル表示 (復元ボタンは出ない)", async () => {
    const get = vi.fn(async (path: string) => {
      if (path === "/outputs/{output_id}/diff/{other_id}")
        return { data: DIFF };
      if (path.includes("content-url"))
        return { data: { url: "https://storage/signed/out.html?token=x" } };
      if (path.includes("versions")) return { data: VERSIONS };
      if (path.includes("anchors")) return { data: [] };
      if (path.includes("fix-proposals")) return { data: [] };
      if (path === "/comments") return { data: [] };
      return { data: { ...META, id: "o2", version: 2 } };
    });
    renderWithQuery(
      <OutputViewerContainer outputId="o2" client={clientOf(get)} />,
    );
    await screen.findByTitle("要件定義書");
    // 最新版 (v2) 表示中: 復元は無意味なので出さない
    expect(
      screen.queryByRole("button", { name: "この版を復元" }),
    ).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "v1 との差分" }));
    expect(
      await screen.findByRole("dialog", { name: "バージョン間差分" }),
    ).toBeInTheDocument();
    expect(screen.getByText("v1 → v2 の差分")).toBeInTheDocument();
    expect(screen.getByText("-<p>旧仕様</p>")).toBeInTheDocument();
    expect(screen.getByText("+<p>新仕様</p>")).toBeInTheDocument();
    const call = get.mock.calls.find(
      (c) => c[0] === "/outputs/{output_id}/diff/{other_id}",
    ) as unknown as [string, { params: { path: Record<string, string> } }];
    expect(call[1].params.path).toEqual({ output_id: "o2", other_id: "o1" });
  });

  it("旧版表示中は「この版を復元」→ POST restore → 新版へ遷移 (履歴は消さない)", async () => {
    const get = standardGet(); // outputId=o1 (v1, 旧版)
    const post = vi.fn(async (path: string) => {
      if (path === "/outputs/{output_id}/restore")
        return {
          data: {
            ...META,
            id: "o3",
            version: 3,
            meta: { author: "restore", restored_from_version: 1 },
          },
        };
      return { data: null };
    });
    renderWithQuery(
      <OutputViewerContainer outputId="o1" client={clientOf(get, post)} />,
    );
    await screen.findByTitle("要件定義書");
    // 旧版 (v1) 表示中: 前版が無いので差分は出さず、復元を出す
    expect(
      screen.queryByRole("button", { name: /との差分/ }),
    ).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "この版を復元" }));
    await waitFor(() => expect(post).toHaveBeenCalledTimes(1));
    const [path, init] = post.mock.calls[0]! as unknown as [
      string,
      { params: { path: { output_id: string } } },
    ];
    expect(path).toBe("/outputs/{output_id}/restore");
    expect(init.params.path.output_id).toBe("o1");
    expect(await screen.findByRole("status")).toHaveTextContent(
      "v3 として復元しました。",
    );
    expect(routerPush).toHaveBeenCalledWith("/outputs?output=o3");
  });

  it("復元 409 (最新版など) はサーバの honest 文言を表示", async () => {
    const get = standardGet();
    const post = vi.fn(async () => {
      throw new ApiError({
        status: 409,
        statusText: "conflict",
        payload: { detail: "v1 はすでに最新版です — 復元は不要です" },
        path: "/outputs/o1/restore",
        method: "post",
      });
    });
    renderWithQuery(
      <OutputViewerContainer outputId="o1" client={clientOf(get, post)} />,
    );
    await screen.findByTitle("要件定義書");
    fireEvent.click(screen.getByRole("button", { name: "この版を復元" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "すでに最新版です",
    );
  });
});
