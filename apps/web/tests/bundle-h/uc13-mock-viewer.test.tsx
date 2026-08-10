/**
 * T-UC-13 — S-H01 モックビューア 配線テスト (design-audit v2 拡張)
 *
 *   - GET /mocks/{id} + /content-url を取得し iframe src に署名付き URL を渡す
 *   - GET /mocks/{id}/versions のバージョン履歴パネル (表示中マーク + 旧版リンク)
 *   - GET/POST/PATCH /comments (target_type=mock) の一覧/追加/解決
 *   - storage 未設定(503) は frame 領域のみ fallback (パネルは生きる)
 *   - 403 拒否 / 一覧ピッカー (MockListContainer)
 */

// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";

import * as React from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";
import { ApiError, type ApiClient } from "@atelier/api-client";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createQueryClient } from "../../lib/query-client";
import { MockListContainer } from "../../app/mocks/s_h01/_components/MockListContainer";
import { MockViewerContainer } from "../../app/mocks/s_h01/_components/MockViewerContainer";

const { routerPush } = vi.hoisted(() => ({ routerPush: vi.fn() }));
vi.mock("next/navigation", () => ({
  useSearchParams: () => new URLSearchParams("project=p1"),
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
    path: "/mocks",
    method: "get",
  });
}

const MOCK_META = {
  id: "m2",
  project_id: "p1",
  screen_name: "ログイン画面",
  version: 2,
};

const VERSIONS = [
  {
    id: "m1",
    project_id: "p1",
    screen_name: "ログイン画面",
    version: 1,
    created_at: "2026-07-01T11:05:00Z",
  },
  {
    id: "m2",
    project_id: "p1",
    screen_name: "ログイン画面",
    version: 2,
    created_at: "2026-07-02T14:22:00Z",
    meta_tags: { note: "+ エラーバナー追加" },
  },
];

function fakeClient(get: unknown): ApiClient {
  const noop = vi.fn(async () => ({ data: [] }));
  return {
    get,
    post: noop,
    patch: noop,
    delete: noop,
    put: noop,
    request: noop,
  } as unknown as ApiClient;
}

/** 標準系 get: meta / content-url / versions / comments を返す。 */
function standardGet(overrides?: {
  contentUrl?: () => never | { data: { url: string } };
  comments?: () => { data: unknown[] };
}) {
  return vi.fn(async (path: string) => {
    if (path.includes("content-url")) {
      if (overrides?.contentUrl) return overrides.contentUrl();
      return { data: { url: "https://storage/signed/login.html?token=x" } };
    }
    if (path.includes("versions")) return { data: VERSIONS };
    if (path === "/comments")
      return overrides?.comments ? overrides.comments() : { data: [] };
    return { data: MOCK_META };
  });
}

afterEach(() => vi.clearAllMocks());

describe("S-H01 MockViewerContainer (T-UC-13)", () => {
  it("renders the iframe with the signed content URL", async () => {
    const get = standardGet();
    renderWithQuery(
      <MockViewerContainer mockId="m2" client={fakeClient(get)} />,
    );
    const frame = (await screen.findByTitle(
      "ログイン画面",
    )) as HTMLIFrameElement;
    expect(frame).toHaveAttribute(
      "src",
      "https://storage/signed/login.html?token=x",
    );
  });

  it("renders the version chain with the current marker and links to old versions", async () => {
    const get = standardGet();
    renderWithQuery(
      <MockViewerContainer mockId="m2" client={fakeClient(get)} />,
    );
    expect(
      await screen.findByRole("heading", { name: "バージョン履歴（2）" }),
    ).toBeInTheDocument();
    // 表示中 (v2) はリンクでなく current マーク + ピルは「v2 · 最新」
    expect(screen.getByText("表示中")).toBeInTheDocument();
    expect(screen.getByText("v2 · 最新")).toBeInTheDocument();
    // meta_tags.note を変更概要として表示
    expect(screen.getByText("+ エラーバナー追加")).toBeInTheDocument();
    // 旧版 v1 は /mocks?mock=m1 へのリンク
    const links = screen.getAllByRole("link");
    expect(
      links.some((l) => l.getAttribute("href") === "/mocks?mock=m1"),
    ).toBe(true);
    // 生 ISO を出さない (鉄則5)
    expect(screen.queryByText(/T\d{2}:\d{2}:\d{2}/)).not.toBeInTheDocument();
  });

  it("shows a plain version pill when viewing an old version", async () => {
    const get = vi.fn(async (path: string) => {
      if (path.includes("content-url"))
        return { data: { url: "https://storage/x.html" } };
      if (path.includes("versions")) return { data: VERSIONS };
      if (path === "/comments") return { data: [] };
      return { data: { ...MOCK_META, id: "m1", version: 1 } };
    });
    renderWithQuery(
      <MockViewerContainer mockId="m1" client={fakeClient(get)} />,
    );
    expect((await screen.findAllByText("v1")).length).toBeGreaterThan(0);
    expect(screen.queryByText(/v1 · 最新/)).not.toBeInTheDocument();
  });

  it("lists comments and adds one via POST /comments (target_type=mock)", async () => {
    const commentsData: { id: string; author_user_id: string; content: string }[] =
      [];
    const get = standardGet({ comments: () => ({ data: [...commentsData] }) });
    const post = vi.fn(
      async (_path: string, init: { body: { content: string } }) => {
        commentsData.push({
          id: "c9",
          author_user_id: "u2",
          content: init.body.content,
        });
        return { data: { id: "c9" } };
      },
    );
    const client = {
      get,
      post,
      patch: vi.fn(),
      delete: vi.fn(),
      put: vi.fn(),
      request: vi.fn(),
    };
    renderWithQuery(
      <MockViewerContainer mockId="m2" client={client as never} />,
    );
    const ta = (await screen.findByPlaceholderText(
      "コメントを追加…",
    )) as HTMLTextAreaElement;
    fireEvent.change(ta, { target: { value: "幅を狭くしてほしい" } });
    fireEvent.click(screen.getByRole("button", { name: "コメント" }));
    await waitFor(() => expect(post).toHaveBeenCalledTimes(1));
    const [path, init] = post.mock.calls[0]! as unknown as [
      string,
      { body: { target_type: string; target_id: string; content: string } },
    ];
    expect(path).toBe("/comments");
    expect(init.body).toEqual({
      target_type: "mock",
      target_id: "m2",
      content: "幅を狭くしてほしい",
    });
    expect(screen.getByText("幅を狭くしてほしい")).toBeInTheDocument();
  });

  it("resolves an open comment via PATCH /comments/{id} status=resolved", async () => {
    let status = "open";
    const get = standardGet({
      comments: () => ({
        data: [{ id: "c1", author_user_id: "u1", content: "要修正", status }],
      }),
    });
    const patch = vi.fn(async () => {
      status = "resolved";
      return { data: {} };
    });
    const client = {
      get,
      post: vi.fn(),
      patch,
      delete: vi.fn(),
      put: vi.fn(),
      request: vi.fn(),
    };
    renderWithQuery(
      <MockViewerContainer mockId="m2" client={client as never} />,
    );
    expect(await screen.findByText("未解決 1")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "解決にする" }));
    await waitFor(() => expect(patch).toHaveBeenCalledTimes(1));
    const [path, init] = patch.mock.calls[0]! as unknown as [
      string,
      { params: { path: { comment_id: string } }; body: { status: string } },
    ];
    expect(path).toBe("/comments/{comment_id}");
    expect(init.params.path.comment_id).toBe("c1");
    expect(init.body.status).toBe("resolved");
    expect(await screen.findByText("すべて解決済み")).toBeInTheDocument();
  });

  it("keeps the version/comment panel alive on storage 503 (frame-only fallback)", async () => {
    const get = standardGet({
      contentUrl: () => {
        throw apiError(503);
      },
    });
    renderWithQuery(
      <MockViewerContainer mockId="m2" client={fakeClient(get)} />,
    );
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "保存先が未設定",
    );
    // パネルは 503 でも生きる (dev でもバージョン/コメントを操作できる)
    expect(
      await screen.findByRole("heading", { name: "バージョン履歴（2）" }),
    ).toBeInTheDocument();
    expect(
      screen.getByPlaceholderText("コメントを追加…"),
    ).toBeInTheDocument();
    // 死にリンクを出さない: 新規タブ/HTML は URL が無い間は非描画 (Rule 10)
    expect(screen.queryByRole("link", { name: /新規タブ/ })).not.toBeInTheDocument();
  });

  it("sends a revision request to Wanda (POST /mocks/{id}/revise) and navigates to the new version", async () => {
    // GAP-024: 「編集」= ワンダ (AI デザイナー) への修正依頼 (Open Design パターン)
    const get = standardGet();
    const post = vi.fn(async () => ({
      data: { id: "m3", version: 3 },
    }));
    const client = {
      get,
      post,
      patch: vi.fn(),
      delete: vi.fn(),
      put: vi.fn(),
      request: vi.fn(),
    };
    renderWithQuery(
      <MockViewerContainer mockId="m2" client={client as never} />,
    );
    fireEvent.click(await screen.findByRole("button", { name: /編集/ }));
    expect(
      screen.getByRole("dialog", { name: "ワンダに修正を依頼" }),
    ).toBeInTheDocument();
    fireEvent.change(screen.getByRole("textbox", { name: "修正指示" }), {
      target: { value: "CTA を右上へ移動" },
    });
    fireEvent.click(screen.getByRole("button", { name: "修正を依頼" }));
    await waitFor(() => expect(post).toHaveBeenCalledTimes(1));
    const [path, init] = post.mock.calls[0]! as unknown as [
      string,
      { params: { path: { mock_id: string } }; body: { instruction: string } },
    ];
    expect(path).toBe("/mocks/{mock_id}/revise");
    expect(init.params.path.mock_id).toBe("m2");
    expect(init.body.instruction).toBe("CTA を右上へ移動");
    await waitFor(() =>
      expect(routerPush).toHaveBeenCalledWith("/mocks?mock=m3"),
    );
    expect(
      screen.getByText("ワンダが v3 を作成しました。"),
    ).toBeInTheDocument();
  });

  it("shows an honest 503 message when the AI designer is unconfigured", async () => {
    const get = standardGet();
    const post = vi.fn(async () => {
      throw apiError(503);
    });
    const client = {
      get,
      post,
      patch: vi.fn(),
      delete: vi.fn(),
      put: vi.fn(),
      request: vi.fn(),
    };
    renderWithQuery(
      <MockViewerContainer mockId="m2" client={client as never} />,
    );
    fireEvent.click(await screen.findByRole("button", { name: /編集/ }));
    fireEvent.change(screen.getByRole("textbox", { name: "修正指示" }), {
      target: { value: "直して" },
    });
    fireEvent.click(screen.getByRole("button", { name: "修正を依頼" }));
    // 503 は retry 2 回 (指数バックオフ) を経て確定するため待ちを延ばす
    expect(
      await screen.findByRole("alert", {}, { timeout: 10000 }),
    ).toHaveTextContent("AI デザイナー（ワンダ）または保存先が未設定");
    expect(routerPush).not.toHaveBeenCalled();
  });

  it("shows Wanda as the author of AI-revised versions with the instruction", async () => {
    const get = vi.fn(async (path: string) => {
      if (path.includes("content-url"))
        return { data: { url: "https://storage/x.html" } };
      if (path.includes("versions"))
        return {
          data: [
            ...VERSIONS,
            {
              id: "m3",
              project_id: "p1",
              screen_name: "ログイン画面",
              version: 3,
              created_at: "2026-07-03T10:00:00Z",
              meta_tags: {
                author: "wanda",
                revision_instruction: "ヘッダーを青に",
                revised_from_version: 2,
              },
            },
          ],
        };
      if (path === "/comments") return { data: [] };
      return { data: MOCK_META };
    });
    renderWithQuery(
      <MockViewerContainer mockId="m2" client={fakeClient(get)} />,
    );
    expect(await screen.findByText("ワンダ（更新）")).toBeInTheDocument();
    expect(
      screen.getByText("修正指示: ヘッダーを青に"),
    ).toBeInTheDocument();
  });

  it("duplicates a version via POST /mocks/{id}/duplicate", async () => {
    const get = standardGet();
    const post = vi.fn(async () => ({
      data: { id: "m4", version: 3, meta_tags: { duplicated_from_version: 2 } },
    }));
    const client = {
      get,
      post,
      patch: vi.fn(),
      delete: vi.fn(),
      put: vi.fn(),
      request: vi.fn(),
    };
    renderWithQuery(
      <MockViewerContainer mockId="m2" client={client as never} />,
    );
    fireEvent.click(await screen.findByRole("button", { name: "v2 を複製" }));
    await waitFor(() => expect(post).toHaveBeenCalledTimes(1));
    const [path, init] = post.mock.calls[0]! as unknown as [
      string,
      { params: { path: { mock_id: string } } },
    ];
    expect(path).toBe("/mocks/{mock_id}/duplicate");
    expect(init.params.path.mock_id).toBe("m2");
    expect(
      await screen.findByText("複製から v3 を作成しました。"),
    ).toBeInTheDocument();
  });

  it("discards a version with two-step confirmation and honors the sole-version 409", async () => {
    const get = standardGet();
    const post = vi.fn(async () => {
      throw apiError(409);
    });
    const client = {
      get,
      post,
      patch: vi.fn(),
      delete: vi.fn(),
      put: vi.fn(),
      request: vi.fn(),
    };
    renderWithQuery(
      <MockViewerContainer mockId="m2" client={client as never} />,
    );
    // 2 段階確認: 「破棄」だけでは API を呼ばない
    fireEvent.click(await screen.findByRole("button", { name: "v1 を破棄" }));
    expect(post).not.toHaveBeenCalled();
    expect(screen.getByText("v1 を破棄しますか？")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "破棄を確定" }));
    await waitFor(() => expect(post).toHaveBeenCalledTimes(1));
    const [path, init] = post.mock.calls[0]! as unknown as [
      string,
      { params: { path: { mock_id: string } } },
    ];
    expect(path).toBe("/mocks/{mock_id}/discard");
    expect(init.params.path.mock_id).toBe("m1");
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "唯一のバージョンは破棄できません。",
    );
  });

  it("shows a forbidden message on 403", async () => {
    const get = vi.fn(async () => {
      throw apiError(403);
    });
    renderWithQuery(
      <MockViewerContainer mockId="m1" client={fakeClient(get)} />,
    );
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "権限がありません",
    );
  });
});

describe("S-H01 MockListContainer (一覧ピッカー)", () => {
  it("lists the latest version per screen and links to the viewer", async () => {
    const get = vi.fn(async (path: string) => {
      expect(path).toBe("/mocks");
      return {
        data: [
          {
            id: "m1",
            screen_name: "ログイン画面",
            version: 1,
            updated_at: "2026-07-01T11:05:00Z",
          },
          {
            id: "m2",
            screen_name: "ログイン画面",
            version: 2,
            updated_at: "2026-07-02T14:22:00Z",
          },
          {
            id: "m3",
            screen_name: "ダッシュボード",
            version: 1,
            updated_at: "2026-07-03T09:00:00Z",
          },
        ],
      };
    });
    renderWithQuery(<MockListContainer client={fakeClient(get)} />);
    expect(
      await screen.findByRole("heading", { name: "モック" }),
    ).toBeInTheDocument();
    // 画面ごとに最新のみ (ログイン画面は v2 だけが出る)
    const login = screen.getByRole("link", { name: /ログイン画面/ });
    expect(login).toHaveAttribute("href", "/mocks?mock=m2");
    expect(login.textContent).toContain("v2");
    expect(login.textContent).not.toContain("v1");
    expect(
      screen.getByRole("link", { name: /ダッシュボード/ }),
    ).toHaveAttribute("href", "/mocks?mock=m3");
  });

  it("shows an empty state when the project has no mocks", async () => {
    const get = vi.fn(async () => ({ data: [] }));
    renderWithQuery(<MockListContainer client={fakeClient(get)} />);
    expect(
      await screen.findByText("このプロジェクトにモックはまだありません。"),
    ).toBeInTheDocument();
  });
});
