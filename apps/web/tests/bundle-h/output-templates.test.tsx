/**
 * GAP-154 — 出力テンプレート管理 (workspace 設定) のテスト。
 *
 * 種類ピッカー / 設定済みバッジ / 保存 (PUT upsert) / 削除 (以後テンプレ無し)。
 */

// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";

import * as React from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";
import type { ApiClient } from "@atelier/api-client";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createQueryClient } from "../../lib/query-client";
import { OutputTemplatesContainer } from "../../app/workspace-settings/_components/OutputTemplatesContainer";

function renderWithQuery(ui: React.ReactElement) {
  const qc = createQueryClient();
  return render(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>);
}

const EXISTING = {
  id: "t1",
  workspace_id: "ws1",
  stage: "estimate",
  stage_label: "見積書",
  title: "標準見積 v1",
  content_md: "# 御見積書\n- 有効期限30日",
};

function clientOf(overrides?: {
  templates?: unknown[];
  put?: ReturnType<typeof vi.fn>;
  del?: ReturnType<typeof vi.fn>;
}): ApiClient {
  const get = vi.fn(async (path: string) => {
    if (path.includes("output-templates"))
      return { data: overrides?.templates ?? [EXISTING] };
    return { data: [] };
  });
  return {
    get,
    put: overrides?.put ?? vi.fn(async () => ({ data: EXISTING })),
    delete: overrides?.del ?? vi.fn(async () => undefined),
    post: vi.fn(),
    patch: vi.fn(),
    request: vi.fn(),
  } as unknown as ApiClient;
}

afterEach(() => vi.clearAllMocks());

describe("出力テンプレート管理 (GAP-154)", () => {
  it("種類ピッカーに設定済みバッジが出て、既存テンプレ本文がエディタに載る", async () => {
    renderWithQuery(
      <OutputTemplatesContainer client={clientOf()} workspaceId="ws1" />,
    );
    const estimateTab = await screen.findByRole("tab", { name: /見積書/ });
    expect(estimateTab).toHaveTextContent("設定済み");
    // 既定選択 = 見積書 → 既存本文 + 「生成時に必ず使用」の明示
    expect(
      screen.getByText("設定済み — 生成時に必ず使用"),
    ).toBeInTheDocument();
    expect(screen.getByDisplayValue("標準見積 v1")).toBeInTheDocument();
    // 未設定の種類は honest バッジ
    fireEvent.click(screen.getByRole("tab", { name: "テスト仕様書" }));
    expect(
      screen.getByText("未設定 — AI の既定フォーマットで生成"),
    ).toBeInTheDocument();
  });

  it("本文を編集して保存 → PUT /workspaces/{id}/output-templates/{stage}", async () => {
    const put = vi.fn(async () => ({ data: EXISTING }));
    renderWithQuery(
      <OutputTemplatesContainer
        client={clientOf({ put })}
        workspaceId="ws1"
      />,
    );
    const textarea = (await screen.findByPlaceholderText(
      /御見積書/,
    )) as HTMLTextAreaElement;
    fireEvent.change(textarea, {
      target: { value: "# 御見積書\n## お支払い条件" },
    });
    fireEvent.click(screen.getByRole("button", { name: "保存" }));
    await waitFor(() => expect(put).toHaveBeenCalledTimes(1));
    const [path, init] = put.mock.calls[0]! as unknown as [
      string,
      {
        params: { path: { workspace_id: string; stage: string } };
        body: { content_md: string };
      },
    ];
    expect(path).toBe("/workspaces/{workspace_id}/output-templates/{stage}");
    expect(init.params.path).toEqual({ workspace_id: "ws1", stage: "estimate" });
    expect(init.body.content_md).toContain("お支払い条件");
    expect(await screen.findByRole("status")).toHaveTextContent(
      "必ずこのテンプレが使われます",
    );
  });

  it("削除 → DELETE + 「以後テンプレ無しで生成」の honest 通知", async () => {
    const del = vi.fn(async () => undefined);
    renderWithQuery(
      <OutputTemplatesContainer client={clientOf({ del })} workspaceId="ws1" />,
    );
    fireEvent.click(
      await screen.findByRole("button", { name: "テンプレを削除" }),
    );
    await waitFor(() => expect(del).toHaveBeenCalledTimes(1));
    expect(await screen.findByRole("status")).toHaveTextContent(
      "テンプレ無しで生成されます",
    );
  });
});
