/**
 * GAP-158 — 出力デザインテンプレのスタジオ (Open Design 方式) のテスト。
 *
 * 位置づけの検証が主眼: これは「クライアントに見せる最終 HTML/PDF の見た目の型」
 * を作る場所であり、内容 (md/json の構成) はスキルが担う — その分離が UI 文言と
 * API 配線 (POST design-templates/{stage}) の両方で成立していること。
 */

// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";

import * as React from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";
import { ApiError, type ApiClient } from "@atelier/api-client";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createQueryClient } from "../../lib/query-client";
import {
  DesignTemplateStudio,
  TEMPLATE_KINDS,
} from "../../app/templates/_components/DesignTemplateStudio";

const WS = "ws-1";

function renderWithQuery(ui: React.ReactElement) {
  const qc = createQueryClient();
  return render(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>);
}

const V2 = {
  id: "t2",
  stage: "estimate",
  stage_label: "見積書",
  version: 2,
  note: "ヘッダーを紺の帯に変更",
  created_at: "2026-08-19T10:00:00Z",
};
const V1 = {
  id: "t1",
  stage: "estimate",
  stage_label: "見積書",
  version: 1,
  note: "白基調・明細罫線あり",
  created_at: "2026-08-18T09:00:00Z",
};

function clientOf(opts?: {
  versions?: unknown[];
  post?: ReturnType<typeof vi.fn>;
}): ApiClient {
  const versions = opts?.versions ?? [];
  return {
    get: vi.fn(async (path: string) => {
      if (path.endsWith("/versions")) return { data: versions };
      if (path.endsWith("/design-templates")) {
        return { data: versions.length > 0 ? [versions[0]] : [] };
      }
      if (path.endsWith("/content-url")) {
        return { data: { url: "http://api.test/signed/tmpl.html" } };
      }
      return { data: [] };
    }),
    post: opts?.post ?? vi.fn(async () => ({ data: V1 })),
    put: vi.fn(),
    patch: vi.fn(),
    delete: vi.fn(),
    request: vi.fn(),
  } as unknown as ApiClient;
}

afterEach(() => vi.clearAllMocks());

describe("DesignTemplateStudio (GAP-158)", () => {
  it("10 種類の成果物デザインを列挙し、「見た目の型 / 内容はスキル」の位置づけを明示する", async () => {
    renderWithQuery(<DesignTemplateStudio client={clientOf()} workspaceId={WS} />);
    expect(
      await screen.findByRole("heading", { name: "出力デザインテンプレート" }),
    ).toBeInTheDocument();
    // 位置づけ: デザインだけを作る場所 (構成・文言はスキル)
    expect(screen.getByText(/内容の構成・文言はスキルが整えます/)).toBeInTheDocument();
    const list = screen.getByRole("list", { name: undefined });
    expect(list).toBeInTheDocument();
    expect(TEMPLATE_KINDS).toHaveLength(10);
    for (const k of ["見積書", "提案書", "請求書", "納品書・完了報告"]) {
      expect(screen.getByRole("button", { name: k })).toBeInTheDocument();
    }
    // テンプレ未作成 → empty state (ワンダに指示で作る案内)
    expect(
      await screen.findByText("「見積書」のテンプレはまだありません"),
    ).toBeInTheDocument();
  });

  it("指示を送ると POST /workspaces/{id}/design-templates/{stage} が呼ばれ、作成通知が出る", async () => {
    const post = vi.fn(async () => ({ data: { ...V1, note: "白基調で作成" } }));
    renderWithQuery(
      <DesignTemplateStudio client={clientOf({ post })} workspaceId={WS} />,
    );
    const box = await screen.findByLabelText(/ワンダへの指示/);
    fireEvent.change(box, {
      target: { value: "白基調でロゴ右上、明細は罫線ありの表" },
    });
    fireEvent.click(screen.getByRole("button", { name: "テンプレを作成" }));
    await waitFor(() => expect(post).toHaveBeenCalledTimes(1));
    const [path, init] = post.mock.calls[0]! as unknown as [
      string,
      {
        params: { path: { workspace_id: string; stage: string } };
        body: { instruction: string };
      },
    ];
    expect(path).toBe("/workspaces/{workspace_id}/design-templates/{stage}");
    expect(init.params.path).toEqual({ workspace_id: WS, stage: "estimate" });
    expect(init.body.instruction).toBe("白基調でロゴ右上、明細は罫線ありの表");
    expect(await screen.findByRole("status")).toHaveTextContent(
      "ワンダが v1 を作成しました — 白基調で作成",
    );
  });

  it("既存版がある種類は版履歴 + A4 プレビュー (署名 URL の iframe) を表示し、過去版も閲覧できる", async () => {
    renderWithQuery(
      <DesignTemplateStudio
        client={clientOf({ versions: [V2, V1] })}
        workspaceId={WS}
      />,
    );
    // 最新 v2 がプレビューされる (content-url 署名 URL の iframe)
    const frame = await screen.findByTitle("見積書 デザインテンプレ v2");
    expect(frame).toHaveAttribute("src", "http://api.test/signed/tmpl.html");
    expect(screen.getByText("版履歴（2）")).toBeInTheDocument();
    expect(screen.getByText("ヘッダーを紺の帯に変更")).toBeInTheDocument();
    // ボタンは「改訂を依頼」に変わる (作成済みなので)
    expect(screen.getByRole("button", { name: "改訂を依頼" })).toBeInTheDocument();
    // 過去版 v1 をクリック → 過去版表示の明示
    fireEvent.click(screen.getByRole("button", { name: /v1/ }));
    expect(await screen.findByText(/過去版を表示中/)).toBeInTheDocument();
  });

  it("503 (Bridge 未接続) は偽の成功を出さず、その場に接続フローを出す (GAP-168)", async () => {
    const post = vi.fn(async () => {
      throw new ApiError({
        status: 503,
        statusText: "unavailable",
        payload: undefined,
        path: "/workspaces/{workspace_id}/design-templates/{stage}",
        method: "post",
      });
    });
    renderWithQuery(
      <DesignTemplateStudio client={clientOf({ post })} workspaceId={WS} />,
    );
    fireEvent.change(await screen.findByLabelText(/ワンダへの指示/), {
      target: { value: "紺基調で" },
    });
    fireEvent.click(screen.getByRole("button", { name: "テンプレを作成" }));
    // GAP-168: 文言だけで終わらせず、接続手順 (トークン発行) までその場に出す
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "お使いのパソコン (Bridge) が未接続のためテンプレの作成を実行できません",
    );
    expect(
      screen.getByRole("button", { name: "接続トークンを発行" }),
    ).toBeInTheDocument();
    expect(screen.queryByText(/作成しました/)).not.toBeInTheDocument();
  });

  it("運営既定を継承中は「運営既定を継承中」と出し、上書きすると「既定に戻す」が出る (GAP-159)", async () => {
    // 自前の版履歴は空 / 一覧には運営既定 (source=platform) が実効デザインとして入る
    const platformLatest = { ...V1, id: "p1", note: "運営既定", source: "platform" as const };
    const client = {
      get: vi.fn(async (path: string) => {
        if (path.endsWith("/versions")) return { data: [] };
        if (path.endsWith("/design-templates")) return { data: [platformLatest] };
        if (path.endsWith("/content-url"))
          return { data: { url: "http://api.test/signed/platform.html" } };
        return { data: [] };
      }),
      post: vi.fn(async () => ({ data: V1 })),
      put: vi.fn(),
      patch: vi.fn(),
      delete: vi.fn(),
      request: vi.fn(),
    } as unknown as ApiClient;
    renderWithQuery(<DesignTemplateStudio client={client} workspaceId={WS} />);
    expect(await screen.findByText("運営既定を継承中")).toBeInTheDocument();
    // 継承中は運営既定がプレビューされ、ボタンは「既定を元に変更する」
    expect(
      await screen.findByTitle("見積書 デザインテンプレ 運営既定"),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "既定を元に変更する" }),
    ).toBeInTheDocument();
    // 継承中は「既定に戻す」は出ない (戻す先と同じなので)
    expect(
      screen.queryByRole("button", { name: "運営の既定デザインに戻す" }),
    ).not.toBeInTheDocument();
  });

  it("自前版があるときは「運営の既定デザインに戻す」で reset API を叩く (GAP-159)", async () => {
    const post = vi.fn(async () => ({ data: { ...V1, note: "運営の既定デザインに戻しました" } }));
    renderWithQuery(
      <DesignTemplateStudio
        client={clientOf({ versions: [V1], post })}
        workspaceId={WS}
      />,
    );
    const resetBtn = await screen.findByRole("button", {
      name: "運営の既定デザインに戻す",
    });
    fireEvent.click(resetBtn);
    await waitFor(() => expect(post).toHaveBeenCalled());
    const [path, init] = post.mock.calls[0]! as unknown as [
      string,
      { params: { path: { workspace_id: string; stage: string } } },
    ];
    expect(path).toBe(
      "/workspaces/{workspace_id}/design-templates/{stage}/reset-to-default",
    );
    expect(init.params.path).toEqual({ workspace_id: WS, stage: "estimate" });
    expect(await screen.findByRole("status")).toHaveTextContent(
      "運営の既定デザインに戻しました",
    );
  });

  it("運営モード (mode=platform) は admin API を使い、全社が継承する既定として作る (GAP-159)", async () => {
    const post = vi.fn(async () => ({ data: { ...V1, note: "全社既定を作成" } }));
    const client = {
      get: vi.fn(async (path: string) => {
        if (path.endsWith("/versions")) return { data: [] };
        return { data: [] };
      }),
      post,
      put: vi.fn(),
      patch: vi.fn(),
      delete: vi.fn(),
      request: vi.fn(),
    } as unknown as ApiClient;
    renderWithQuery(<DesignTemplateStudio client={client} mode="platform" />);
    expect(
      await screen.findByRole("heading", { name: "既定デザインテンプレート（運営）" }),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/全ワークスペースが/),
    ).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText(/ワンダへの指示/), {
      target: { value: "全社共通の見積デザイン" },
    });
    fireEvent.click(screen.getByRole("button", { name: "テンプレを作成" }));
    await waitFor(() => expect(post).toHaveBeenCalled());
    const [adminPath] = post.mock.calls[0]! as unknown as [string];
    expect(adminPath).toBe("/admin/design-templates/{stage}");
  });
});
