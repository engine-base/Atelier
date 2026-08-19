/**
 * GAP-180 — 意味検索 (埋め込み) の状態・準備・再試行が画面に出ること。
 *
 * 直前の実態: 使えないことは検索後に小さく出るだけで、理由も復旧手順も無く、
 * 手順として利用者に環境変数名 (VOYAGE_API_KEY) を見せていた。
 */

// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";

import * as React from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";
import { type ApiClient } from "@atelier/api-client";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createQueryClient } from "../../lib/query-client";
import { EmbeddingStatusCard } from "../../app/knowledge/s_k01/_components/EmbeddingStatusCard";

function renderWithQuery(ui: React.ReactElement) {
  const qc = createQueryClient();
  return render(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>);
}

function fakeClient(status: unknown, post?: unknown): ApiClient {
  const noop = vi.fn(async () => ({ data: [] }));
  return {
    get: vi.fn(async () => ({ data: status })),
    post: post ?? vi.fn(async () => ({ data: status })),
    patch: noop,
    delete: noop,
    put: noop,
    request: noop,
  } as unknown as ApiClient;
}

const READY = {
  provider: "local",
  state: "ready",
  reason: "ローカルモデル (intfloat/multilingual-e5-large) で意味検索を行います",
  payer: "費用なし (このサーバー内で計算)",
  model_tag: "local:intfloat/multilingual-e5-large",
  next_steps: [],
  warnings: [],
  semantic_enabled: true,
  indexed: 12,
  total: 12,
};

const PREPARING = {
  ...READY,
  state: "preparing",
  reason: "ローカルモデルを準備中です",
  next_steps: ["初回のみモデルのダウンロードに数分かかります"],
  semantic_enabled: false,
  indexed: 0,
  total: 12,
};

const UNAVAILABLE = {
  provider: "none",
  state: "unavailable",
  reason: "意味検索の部品 (fastembed) がこのサーバーに入っていません (キーワード一致のみ)",
  payer: "費用なし",
  model_tag: null,
  next_steps: ["サーバーで `uv sync` を実行して fastembed を導入する"],
  warnings: [
    "VOYAGE_API_KEY は設定されていますが、明示 opt-in (ATELIER_ALLOW_VOYAGE=1) が無いため使用しません (課金しません)",
  ],
  semantic_enabled: false,
  indexed: 0,
  total: 3,
};

afterEach(() => vi.clearAllMocks());

describe("GAP-180 意味検索の状態カード", () => {
  it("shows the running provider and who pays when ready", async () => {
    renderWithQuery(<EmbeddingStatusCard client={fakeClient(READY)} />);
    await waitFor(() =>
      expect(screen.getByText("意味検索が使えます")).toBeInTheDocument(),
    );
    expect(screen.getByText("費用なし (このサーバー内で計算)")).toBeInTheDocument();
    expect(screen.getByText("埋め込み済み 12 / 12 件")).toBeInTheDocument();
    // 完了しているので準備ボタンは出さない
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });

  it("says it is preparing and offers to start it now", async () => {
    renderWithQuery(<EmbeddingStatusCard client={fakeClient(PREPARING)} />);
    await waitFor(() =>
      expect(
        screen.getByText("準備中（今はキーワード一致で検索します）"),
      ).toBeInTheDocument(),
    );
    expect(
      screen.getByText("初回のみモデルのダウンロードに数分かかります"),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "今すぐ準備する" }),
    ).toBeInTheDocument();
  });

  it("explains why it is unavailable and retries on demand", async () => {
    const post = vi.fn(async () => ({ data: PREPARING }));
    renderWithQuery(<EmbeddingStatusCard client={fakeClient(UNAVAILABLE, post)} />);
    await waitFor(() =>
      expect(
        screen.getByText("意味検索は使えません（キーワード一致のみ）"),
      ).toBeInTheDocument(),
    );
    // Voyage は「キーがあるだけでは使わない」ことを画面で明言する
    expect(screen.getByText(/明示 opt-in/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "再試行する" }));
    await waitFor(() => expect(post).toHaveBeenCalledTimes(1));
  });

  it("renders nothing when the status cannot be fetched (no guessing)", async () => {
    const failing = {
      get: vi.fn(async () => {
        throw new Error("boom");
      }),
      post: vi.fn(),
      patch: vi.fn(),
      delete: vi.fn(),
      put: vi.fn(),
      request: vi.fn(),
    } as unknown as ApiClient;
    const { container } = renderWithQuery(<EmbeddingStatusCard client={failing} />);
    await waitFor(() => expect(container.querySelector("section")).toBeNull());
  });
});
