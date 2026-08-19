/**
 * GAP-153 — ナレッジ自動キュレーション承認キュー (S-T06) のテスト。
 */

// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";

import * as React from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";
import { ApiError, type ApiClient } from "@atelier/api-client";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createQueryClient } from "../../lib/query-client";
import { CurationQueue } from "../../app/admin/s_t06/_components/CurationQueue";

function renderWithQuery(ui: React.ReactElement) {
  const qc = createQueryClient();
  return render(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>);
}

const PENDING = {
  id: "c1",
  source_node_id: "k1",
  source_title: "見積レビューの観点",
  source_workspace_name: "秘密商事",
  proposed_title: "[一般化] 見積レビューの観点",
  proposed_content_md: "# 一般化ノウハウ\n工数は幅を持たせる",
  proposed_category: "ノウハウ",
  proposed_tags: ["curated"],
  reason: "業種を問わず有用",
  security_notes: "除去: 社名",
  status: "pending",
};

function clientOf(post?: ReturnType<typeof vi.fn>): ApiClient {
  return {
    get: vi.fn(async () => ({ data: [PENDING] })),
    post: post ?? vi.fn(async () => ({ data: {} })),
    put: vi.fn(),
    patch: vi.fn(),
    delete: vi.fn(),
    request: vi.fn(),
  } as unknown as ApiClient;
}

afterEach(() => vi.clearAllMocks());

describe("CurationQueue (GAP-153)", () => {
  it("承認待ちの提案 (匿名化済み + 出所 + 判定理由) を表示し、承認で approve API", async () => {
    const post = vi.fn(async (path: string) => {
      if (path.includes("approve"))
        return { data: { curation: { ...PENDING, status: "approved" } } };
      return { data: {} };
    });
    renderWithQuery(<CurationQueue client={clientOf(post)} />);
    expect(
      await screen.findByText("[一般化] 見積レビューの観点"),
    ).toBeInTheDocument();
    expect(screen.getByText(/出所: 秘密商事/)).toBeInTheDocument();
    expect(screen.getByText(/判定理由: 業種を問わず有用/)).toBeInTheDocument();
    fireEvent.click(
      screen.getByRole("button", { name: "承認して全アカウント共有" }),
    );
    await waitFor(() => expect(post).toHaveBeenCalled());
    const [path, init] = post.mock.calls[0]! as unknown as [
      string,
      { params: { path: { curation_id: string } } },
    ];
    expect(path).toBe("/admin/knowledge/curation/{curation_id}/approve");
    expect(init.params.path.curation_id).toBe("c1");
    expect(await screen.findByRole("status")).toHaveTextContent(
      "全アカウントに共有されます",
    );
  });

  it("「今すぐ走らせる」→ run API → 実測統計を表示、503 は honest 表示", async () => {
    const post = vi.fn(async (path: string) => {
      if (path.endsWith("/run"))
        return {
          data: { scanned: 5, proposed: 2, skipped_not_useful: 2, rejected_security: 1 },
        };
      return { data: {} };
    });
    renderWithQuery(<CurationQueue client={clientOf(post)} />);
    fireEvent.click(
      await screen.findByRole("button", { name: "今すぐ走らせる" }),
    );
    expect(await screen.findByRole("status")).toHaveTextContent(
      "走査 5 件 → 提案 2 / 対象外 2 / セキュリティ除外 1",
    );

    // 503 (運営キー未設定)
    const post503 = vi.fn(async () => {
      throw new ApiError({
        status: 503,
        statusText: "unavailable",
        payload: undefined,
        path: "/admin/knowledge/curation/run",
        method: "post",
      });
    });
    renderWithQuery(<CurationQueue client={clientOf(post503)} />);
    fireEvent.click(
      (await screen.findAllByRole("button", { name: "今すぐ走らせる" })).at(-1)!,
    );
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "ANTHROPIC_API_KEY が未設定",
    );
  });
});
