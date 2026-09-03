/**
 * T-UC-22 — S-L03 クライアントプロジェクトビュー 配線テスト (R-T08)
 *
 *   - token あり → fetchProject の結果を描画
 *   - token なし → サインイン誘導
 *   - 403 越境 → 拒否
 */

// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";

import * as React from "react";
import { render, screen } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn() }),
}));

import { createQueryClient } from "../../lib/query-client";
import { ClientProjectViewContainer } from "../../app/client/s_l03/_components/ClientProjectViewContainer";
import {
  ClientPortalError,
  type ClientProjectData,
} from "../../lib/auth/client-portal";

function renderWithQuery(ui: React.ReactElement) {
  const qc = createQueryClient();
  return render(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>);
}

const DATA: ClientProjectData = {
  id: "p1",
  name: "ACME 案件",
  description: "限定ビュー",
  scopes: ["view", "comment"],
  viewed_as_client_display_name: "山田",
};

afterEach(() => vi.clearAllMocks());

describe("S-L03 ClientProjectViewContainer (T-UC-22)", () => {
  it("renders the project view when a client token is present", async () => {
    const fetchProject = vi.fn(async () => DATA);
    renderWithQuery(
      <ClientProjectViewContainer
        projectId="p1"
        getToken={() => "ct"}
        fetchProject={fetchProject}
      />,
    );
    expect(
      await screen.findByRole("heading", { name: "ACME 案件" }),
    ).toBeInTheDocument();
    expect(screen.getByText("コメント")).toBeInTheDocument();
    expect(fetchProject).toHaveBeenCalledWith("p1", "ct");
  });

  it("prompts sign-in when there is no client token", async () => {
    renderWithQuery(
      <ClientProjectViewContainer
        projectId="p1"
        getToken={() => null}
        fetchProject={vi.fn()}
      />,
    );
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "サインインが必要です",
    );
  });

  it("denies cross-project access on 403 (R-T08)", async () => {
    const fetchProject = vi.fn(async () => {
      throw new ClientPortalError("cross", 403);
    });
    renderWithQuery(
      <ClientProjectViewContainer
        projectId="other"
        getToken={() => "ct"}
        fetchProject={fetchProject}
      />,
    );
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "権限がありません",
    );
  });

  it("shows the API reason on 401 instead of a fixed session-expired text (GAP-252)", async () => {
    const fetchProject = vi.fn(async () => {
      throw new ClientPortalError(
        "この招待は取り消されています。引き続きご覧になる場合は、招待した担当者にご連絡ください。",
        401,
      );
    });
    renderWithQuery(
      <ClientProjectViewContainer
        projectId="p1"
        getToken={() => "ct"}
        fetchProject={fetchProject}
      />,
    );
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("取り消されています");
    expect(alert).not.toHaveTextContent("セッションの有効期限");
  });

  it("falls back to the session-expired text when the 401 carries no reason", async () => {
    const fetchProject = vi.fn(async () => {
      throw new ClientPortalError("HTTP 401", 401);
    });
    renderWithQuery(
      <ClientProjectViewContainer
        projectId="p1"
        getToken={() => "ct"}
        fetchProject={fetchProject}
      />,
    );
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "セッションの有効期限が切れました",
    );
  });
});

// --------------------------------------------------------------------------- //
// GAP-029: S-L03 実コンテンツ (overview / outputs / mocks / comments + 投稿)
// --------------------------------------------------------------------------- //

import { fireEvent, within } from "@testing-library/react";
import type {
  ClientCommentItemData,
  ClientMocksData,
  ClientOutputItemData,
  ClientProjectOverviewData,
} from "../../lib/auth/client-portal";

const OVERVIEW: ClientProjectOverviewData = {
  phases: [
    { name: "ヒアリング", order: 1, status: "completed" },
    { name: "要件", order: 2, status: "in_progress" },
    { name: "納品", order: 3, status: "pending" },
  ],
  progress_percent: 33,
  operator_workspace_name: "ENGINE BASE 株式会社",
  operator_name: "高本まさと",
  link_expires_at: "2026-08-15T00:00:00Z",
  link_remaining_days: 4,
};

const OUTPUTS: ClientOutputItemData[] = [
  {
    id: "o1",
    stage: "hearing",
    stage_label: "ヒアリングサマリー",
    version: 2,
    updated_at: "2026-08-01T00:00:00Z",
    formats: ["html", "md"],
    summary: null,
  },
];

const MOCKS: ClientMocksData = {
  items: [
    {
      id: "m1",
      screen_name: "トップページ",
      version: 3,
      updated_at: "2026-08-02T00:00:00Z",
    },
  ],
  total_screens: 1,
};

const COMMENTS: ClientCommentItemData[] = [
  {
    id: "c1",
    target_type: "workflow_output",
    target_id: "o1",
    target_label: "ヒアリングサマリー",
    content: "§2 の内訳を確認したい",
    author_name: null,
    is_client_author: true,
    created_at: "2026-08-03T00:00:00Z",
  },
  {
    id: "c2",
    target_type: "workflow_output",
    target_id: "o1",
    target_label: "ヒアリングサマリー",
    content: "運営からの返信です",
    author_name: "高本",
    is_client_author: false,
    created_at: "2026-08-04T00:00:00Z",
  },
];

function contentProps() {
  return {
    fetchOverview: vi.fn(async () => OVERVIEW),
    fetchOutputs: vi.fn(async () => OUTPUTS),
    fetchMocks: vi.fn(async () => MOCKS),
    fetchComments: vi.fn(async () => COMMENTS),
  };
}

describe("S-L03 GAP-029 実コンテンツ", () => {
  it("renders progress, link expiry, outputs, mocks and comments from real APIs", async () => {
    renderWithQuery(
      <ClientProjectViewContainer
        projectId="p1"
        getToken={() => "ct"}
        fetchProject={vi.fn(async () => DATA)}
        {...contentProps()}
        postComment={vi.fn()}
      />,
    );
    expect(
      await screen.findByText(/リンク有効期限：残り 4 日/),
    ).toBeInTheDocument();
    expect(screen.getByText("33%")).toBeInTheDocument();
    expect(screen.getByText(/運営：ENGINE BASE 株式会社 · 高本まさと/)).toBeInTheDocument();
    const outputsSection = screen.getByRole("region", { name: "成果物" });
    expect(
      within(outputsSection).getByText("ヒアリングサマリー"),
    ).toBeInTheDocument();
    expect(within(outputsSection).getByText(/v2 · HTML \/ MD/)).toBeInTheDocument();
    const mocksSection = screen.getByRole("region", { name: "モック" });
    expect(within(mocksSection).getByText("トップページ")).toBeInTheDocument();
    expect(screen.getByText("全 1 画面")).toBeInTheDocument();
    const commentsSection = screen.getByRole("region", {
      name: "あなたのコメント",
    });
    expect(
      within(commentsSection).getByText("あなたのコメント（1）"),
    ).toBeInTheDocument();
    expect(
      within(commentsSection).getByText("運営からの返信です"),
    ).toBeInTheDocument();
    expect(within(commentsSection).getByText(/運営 · 高本/)).toBeInTheDocument();
  });

  it("posts a comment with the selected target and shows the notice", async () => {
    const postComment = vi.fn(async () => COMMENTS[0]!);
    renderWithQuery(
      <ClientProjectViewContainer
        projectId="p1"
        getToken={() => "ct"}
        fetchProject={vi.fn(async () => DATA)}
        {...contentProps()}
        postComment={postComment}
      />,
    );
    const form = await screen.findByRole("region", { name: "コメントを投稿" });
    // outputs 取得後に対象 option が実データから生成されるのを待つ
    await within(form).findByRole("option", {
      name: "ヒアリングサマリー v2",
    });
    fireEvent.change(within(form).getByLabelText(/コメント対象/), {
      target: { value: "workflow_output:o1" },
    });
    fireEvent.change(within(form).getByLabelText(/コメント内容/), {
      target: { value: "確認お願いします" },
    });
    fireEvent.click(
      within(form).getByRole("button", { name: "コメントを投稿" }),
    );
    expect(
      await screen.findByText("コメントを投稿しました。運営側に共有されます。"),
    ).toBeInTheDocument();
    expect(postComment).toHaveBeenCalledWith("p1", "ct", {
      target_type: "workflow_output",
      target_id: "o1",
      content: "確認お願いします",
    });
  });

  it("hides the comment form when the comment scope is missing", async () => {
    renderWithQuery(
      <ClientProjectViewContainer
        projectId="p1"
        getToken={() => "ct"}
        fetchProject={vi.fn(async () => ({ ...DATA, scopes: ["view"] }))}
        {...contentProps()}
        postComment={vi.fn()}
      />,
    );
    await screen.findByRole("region", { name: "成果物" });
    expect(
      screen.queryByRole("region", { name: "コメントを投稿" }),
    ).toBeNull();
  });

  it("shows honest failure messages when content APIs fail but keeps the view", async () => {
    renderWithQuery(
      <ClientProjectViewContainer
        projectId="p1"
        getToken={() => "ct"}
        fetchProject={vi.fn(async () => DATA)}
        fetchOverview={vi.fn(async () => {
          throw new ClientPortalError("boom", 500);
        })}
        fetchOutputs={vi.fn(async () => {
          throw new ClientPortalError("boom", 500);
        })}
        fetchMocks={vi.fn(async () => MOCKS)}
        fetchComments={vi.fn(async () => COMMENTS)}
        postComment={vi.fn()}
      />,
    );
    expect(
      await screen.findByText("成果物を取得できませんでした。"),
    ).toBeInTheDocument();
    expect(
      screen.getByText("進捗情報を取得できませんでした。"),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("heading", { name: "ACME 案件" }),
    ).toBeInTheDocument();
    expect(screen.getByText("トップページ")).toBeInTheDocument();
  });
});

describe("S-L03 GAP-268 成果物を開く (通し J23-05)", () => {
  it("shows an open button per available format and opens the signed URL", async () => {
    const fetchContentUrl = vi.fn(async () => ({
      url: "https://api.example/outputs/o1/content?exp=1&sig=abc",
      kind: "html" as const,
    }));
    const openUrl = vi.fn();
    renderWithQuery(
      <ClientProjectViewContainer
        projectId="p1"
        getToken={() => "ct"}
        fetchProject={vi.fn(async () => DATA)}
        {...contentProps()}
        fetchContentUrl={fetchContentUrl}
        openUrl={openUrl}
      />,
    );
    const outputsSection = await screen.findByRole("region", { name: "成果物" });
    // 実在する形式 (html / md) だけにボタンが出る。json は出ない
    const html = within(outputsSection).getByRole("button", {
      name: "ヒアリングサマリー を HTML で開く",
    });
    expect(
      within(outputsSection).getByRole("button", {
        name: "ヒアリングサマリー を MD で開く",
      }),
    ).toBeInTheDocument();
    expect(
      within(outputsSection).queryByRole("button", {
        name: "ヒアリングサマリー を JSON で開く",
      }),
    ).not.toBeInTheDocument();
    fireEvent.click(html);
    await vi.waitFor(() =>
      expect(openUrl).toHaveBeenCalledWith(
        "https://api.example/outputs/o1/content?exp=1&sig=abc",
      ),
    );
    expect(fetchContentUrl).toHaveBeenCalledWith("p1", "o1", "html", "ct");
  });

  it("shows the reason when the format is not generated (409) instead of opening a blank tab", async () => {
    const fetchContentUrl = vi.fn(async () => {
      throw new ClientPortalError("not generated", 409);
    });
    const openUrl = vi.fn();
    renderWithQuery(
      <ClientProjectViewContainer
        projectId="p1"
        getToken={() => "ct"}
        fetchProject={vi.fn(async () => DATA)}
        {...contentProps()}
        fetchContentUrl={fetchContentUrl}
        openUrl={openUrl}
      />,
    );
    const outputsSection = await screen.findByRole("region", { name: "成果物" });
    fireEvent.click(
      within(outputsSection).getByRole("button", {
        name: "ヒアリングサマリー を MD で開く",
      }),
    );
    expect(
      await screen.findByText("この形式はまだ作成されていません。"),
    ).toBeInTheDocument();
    expect(openUrl).not.toHaveBeenCalled();
  });
});

describe("S-L03 GAP-267 自分のコメントの修正・取り消し (通し J23-03)", () => {
  it("edits the own comment inline and calls the API with the new text", async () => {
    const patchComment = vi.fn(async () => ({
      ...COMMENTS[0]!,
      content: "直した本文",
    }));
    renderWithQuery(
      <ClientProjectViewContainer
        projectId="p1"
        getToken={() => "ct"}
        fetchProject={vi.fn(async () => DATA)}
        {...contentProps()}
        postComment={vi.fn()}
        patchComment={patchComment}
        deleteComment={vi.fn()}
      />,
    );
    const section = await screen.findByRole("region", { name: "あなたのコメント" });
    // 自分のコメントにだけ「修正」「取り消す」が出る (運営の返信には出ない)
    expect(within(section).getAllByRole("button", { name: /^コメントを修正:/ })).toHaveLength(1);
    fireEvent.click(within(section).getByRole("button", { name: /^コメントを修正:/ }));
    const box = within(section).getByRole("textbox", { name: "コメントを修正" });
    fireEvent.change(box, { target: { value: "直した本文" } });
    fireEvent.click(within(section).getByRole("button", { name: "保存" }));
    await vi.waitFor(() =>
      expect(patchComment).toHaveBeenCalledWith("p1", "ct", COMMENTS[0]!.id, "直した本文"),
    );
    expect(await screen.findByText("コメントを修正しました。")).toBeInTheDocument();
  });

  it("deletes the own comment after confirmation and skips when declined", async () => {
    const deleteComment = vi.fn(async () => undefined);
    const confirmDelete = vi.fn(() => false);
    renderWithQuery(
      <ClientProjectViewContainer
        projectId="p1"
        getToken={() => "ct"}
        fetchProject={vi.fn(async () => DATA)}
        {...contentProps()}
        postComment={vi.fn()}
        patchComment={vi.fn()}
        deleteComment={deleteComment}
        confirmDelete={confirmDelete}
      />,
    );
    const section = await screen.findByRole("region", { name: "あなたのコメント" });
    const del = within(section).getByRole("button", { name: /^コメントを取り消す:/ });
    fireEvent.click(del);
    expect(confirmDelete).toHaveBeenCalled();
    expect(deleteComment).not.toHaveBeenCalled();
    confirmDelete.mockReturnValue(true);
    fireEvent.click(del);
    await vi.waitFor(() =>
      expect(deleteComment).toHaveBeenCalledWith("p1", "ct", COMMENTS[0]!.id),
    );
    expect(await screen.findByText("コメントを取り消しました。")).toBeInTheDocument();
  });

  it("hides edit/delete for view-only scope", async () => {
    renderWithQuery(
      <ClientProjectViewContainer
        projectId="p1"
        getToken={() => "ct"}
        fetchProject={vi.fn(async () => ({ ...DATA, scopes: ["view"] }))}
        {...contentProps()}
        patchComment={vi.fn()}
        deleteComment={vi.fn()}
      />,
    );
    const section = await screen.findByRole("region", { name: "あなたのコメント" });
    expect(within(section).queryByRole("button", { name: /^コメントを修正:/ })).not.toBeInTheDocument();
    expect(within(section).queryByRole("button", { name: /^コメントを取り消す:/ })).not.toBeInTheDocument();
  });
});
