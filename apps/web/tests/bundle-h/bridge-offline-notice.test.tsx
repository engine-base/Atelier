/**
 * GAP-168 — Bridge (本人の PC) が要る操作が未接続で止まったとき、
 * **その画面にそのまま接続フローが出る**ことのテスト。
 *
 * 経営者指摘: 「もし接続できていない場合、接続させるフローが出てくる状態に
 * 更新しているはずだけど、なんで出てない？ バグじゃないか？」
 * → 実際、接続フローはチャット画面 (S-E01) の中にしか無かった。
 *   ここでは共通部品と、Bridge を使う各画面での露出を検証する。
 */

// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";

import * as React from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";
import { ApiError, type ApiClient } from "@atelier/api-client";
import { afterEach, describe, expect, it, vi } from "vitest";

import { _internal, createQueryClient } from "../../lib/query-client";
import {
  BridgeOfflineNotice,
  isBridgeOffline,
} from "../../components/bridge/BridgeOfflineNotice";
import { MockViewer } from "../../app/mocks/s_h01/_components/MockViewer";
import { DesignTemplateStudio } from "../../app/templates/_components/DesignTemplateStudio";
import { SheetEditor } from "../../app/outputs/s_g01/_components/SheetEditor";
import type * as Connector from "../../lib/auth/connector";

const sendJson = vi.fn(async () => ({ token: "brg_raw_token_once" }));
vi.mock("../../lib/auth/connector", async () => {
  const actual = await vi.importActual<typeof Connector>("../../lib/auth/connector");
  return {
    ...actual,
    API_BASE: "http://api.test",
    sendJson: (...args: unknown[]) => sendJson(...(args as [])),
  };
});

function renderWithQuery(ui: React.ReactElement) {
  const qc = createQueryClient();
  return render(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>);
}

function throwing503(path: string) {
  return vi.fn(async () => {
    throw new ApiError({
      status: 503,
      statusText: "unavailable",
      payload: undefined,
      path,
      method: "post",
    });
  });
}

afterEach(() => vi.clearAllMocks());

describe("BridgeOfflineNotice (GAP-168)", () => {
  it("何が止まったかを言い、その場に接続手順 (トークン発行) を出す", async () => {
    render(<BridgeOfflineNotice action="テンプレの作成" />);
    const alert = screen.getByRole("alert");
    expect(alert).toHaveTextContent(
      "お使いのパソコン (Bridge) が未接続のためテンプレの作成を実行できません",
    );
    // 「どこで動くか」を画面上で明示する
    expect(alert).toHaveTextContent("あなたの PC の Claude で動きます");
    // 接続フローが同じ場所に展開されている
    expect(screen.getByText("接続の手順")).toBeInTheDocument();
    expect(
      screen.getByRole("link", { name: /ダウンロード — Mac \/ Windows \/ Linux/ }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "接続トークンを発行" }),
    ).toBeInTheDocument();
  });

  it("接続トークンを発行すると POST /bridge-tokens を叩き、アプリ起動リンクを出す", async () => {
    render(<BridgeOfflineNotice action="モックの改訂" />);
    fireEvent.click(screen.getByRole("button", { name: "接続トークンを発行" }));
    await waitFor(() => expect(sendJson).toHaveBeenCalled());
    expect(sendJson.mock.calls[0]!.slice(0, 2)).toEqual([
      "POST",
      "/bridge-tokens",
    ]);
    const link = await screen.findByRole("link", { name: "アプリで接続" });
    expect(link).toHaveAttribute(
      "href",
      "atelier-bridge://connect?api=http%3A%2F%2Fapi.test&token=brg_raw_token_once",
    );
  });

  it("折りたたみ可能 (defaultOpen=false なら「接続する」で開く)", () => {
    render(<BridgeOfflineNotice action="モックの改訂" defaultOpen={false} />);
    expect(screen.queryByText("接続の手順")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "接続する" }));
    expect(screen.getByText("接続の手順")).toBeInTheDocument();
  });

  it("isBridgeOffline は実行経路ゼロ (503) だけを未接続とみなす", () => {
    const mk = (status: number) =>
      new ApiError({
        status,
        statusText: "e",
        payload: undefined,
        path: "/x",
        method: "post",
      });
    expect(isBridgeOffline(mk(503))).toBe(true);
    expect(isBridgeOffline(mk(409))).toBe(false);
    expect(isBridgeOffline(new Error("boom"))).toBe(false);
  });
});

describe("Bridge を使う各画面に接続フローが出る (GAP-168)", () => {
  it("デザインテンプレのスタジオ: 503 → 接続フロー", async () => {
    const client = {
      get: vi.fn(async () => ({ data: [] })),
      post: throwing503("/workspaces/{workspace_id}/design-templates/{stage}"),
      put: vi.fn(),
      patch: vi.fn(),
      delete: vi.fn(),
      request: vi.fn(),
    } as unknown as ApiClient;
    renderWithQuery(<DesignTemplateStudio client={client} workspaceId="ws-1" />);
    fireEvent.change(await screen.findByLabelText(/ワンダへの指示/), {
      target: { value: "紺基調で" },
    });
    fireEvent.click(screen.getByRole("button", { name: "テンプレを作成" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "テンプレの作成を実行できません",
    );
    expect(
      screen.getByRole("button", { name: "接続トークンを発行" }),
    ).toBeInTheDocument();
  });

  it("成果物のファイル編集 (Excel/PDF): 503 → 接続フロー", async () => {
    const client = {
      get: vi.fn(async () => ({
        data: {
          file_name: "見積.xlsx",
          mime: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
          editable: true,
          note: "値のみ",
          sheets: [{ name: "明細", rows: [["項目"]] }],
        },
      })),
      post: throwing503("/outputs/{output_id}/ai-file-edit"),
      put: vi.fn(),
      patch: vi.fn(),
      delete: vi.fn(),
      request: vi.fn(),
    } as unknown as ApiClient;
    renderWithQuery(<SheetEditor outputId="o1" client={client} />);
    fireEvent.change(await screen.findByPlaceholderText(/第 3 条の支払期日/), {
      target: { value: "明細に保守費を追加" },
    });
    fireEvent.click(screen.getByRole("button", { name: "AI に修正を依頼" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "ファイルの AI 修正依頼を実行できません",
    );
    expect(
      screen.getByRole("button", { name: "接続トークンを発行" }),
    ).toBeInTheDocument();
  });

  it("モックスタジオ: 改訂が未接続で止まったら指示欄の隣に接続フロー", () => {
    render(
      <MockViewer
        src="http://api.test/m.html"
        title="トップページ"
        onRevise={vi.fn()}
        bridgeOffline
      />,
    );
    expect(screen.getByRole("alert")).toHaveTextContent(
      "モックの改訂を実行できません",
    );
    expect(
      screen.getByRole("button", { name: "接続トークンを発行" }),
    ).toBeInTheDocument();
  });
});

describe("グローバル toast の文言も実態に合わせる (GAP-168)", () => {
  it("503 は「サーバーでエラー」ではなく「Bridge が未接続」と言う", () => {
    const mk = (status: number) =>
      new ApiError({
        status,
        statusText: "e",
        payload: undefined,
        path: "/x",
        method: "post",
      });
    expect(_internal.toastMessage(mk(503))).toBe(
      "お使いのパソコン (Bridge) が未接続です。画面の案内から接続してください。",
    );
    // 本当のサーバー障害 (500) は従来どおり
    expect(_internal.toastMessage(mk(500))).toBe("サーバーでエラーが発生しました。");
  });
});
