/**
 * GAP-167 — ナレッジ候補の採用 / 却下 (全部は溜めない)。
 */

// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";

import * as React from "react";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";
import type { ApiClient } from "@atelier/api-client";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createQueryClient } from "../../lib/query-client";
import { KnowledgeCandidates } from "../../app/knowledge/s_k01/_components/KnowledgeCandidates";

const CAND = {
  id: "c1",
  title: "見積は前提条件を明記する",
  content_md: "見積には対象範囲と前提条件を必ず書く。",
  category: "ノウハウ",
  tags: ["auto"],
  status: "pending",
};

function renderWithQuery(ui: React.ReactElement) {
  const qc = createQueryClient();
  return render(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>);
}

function clientOf(post: ReturnType<typeof vi.fn>, items: unknown[] = [CAND]): ApiClient {
  return {
    get: vi.fn(async () => ({ data: items })),
    post,
    put: vi.fn(),
    patch: vi.fn(),
    delete: vi.fn(),
    request: vi.fn(),
  } as unknown as ApiClient;
}

afterEach(() => vi.clearAllMocks());

describe("KnowledgeCandidates (GAP-167)", () => {
  it("候補を出し、「採用したものだけがナレッジになる」ことを明示する", async () => {
    renderWithQuery(<KnowledgeCandidates client={clientOf(vi.fn())} />);
    const box = await screen.findByRole("region", {
      name: "AI が会話から拾ったナレッジ候補",
    });
    expect(within(box).getByText(/AI が会話から拾った候補（1）/)).toBeInTheDocument();
    expect(within(box).getByText(/採用したものだけ/)).toBeInTheDocument();
    expect(within(box).getByText(/却下したものは今後提案されません/)).toBeInTheDocument();
  });

  it("そのまま採用すると approve API を叩く", async () => {
    const post = vi.fn(async () => ({ data: { knowledge_id: "k1" } }));
    renderWithQuery(<KnowledgeCandidates client={clientOf(post)} />);
    fireEvent.click(await screen.findByRole("button", { name: "採用" }));
    await waitFor(() => expect(post).toHaveBeenCalled());
    const [path, init] = post.mock.calls[0]! as unknown as [
      string,
      { params: { path: { candidate_id: string } }; body: Record<string, unknown> },
    ];
    expect(path).toBe("/knowledge/candidates/{candidate_id}/approve");
    expect(init.params.path.candidate_id).toBe("c1");
    expect(init.body).toEqual({});
    expect(await screen.findByRole("status")).toHaveTextContent("ナレッジに追加しました");
  });

  it("その場で直して採用できる (編集内容が API に載る)", async () => {
    const post = vi.fn(async () => ({ data: { knowledge_id: "k1" } }));
    renderWithQuery(<KnowledgeCandidates client={clientOf(post)} />);
    fireEvent.change(
      await screen.findByLabelText("候補の題名: 見積は前提条件を明記する"),
      { target: { value: "見積は前提条件と対象範囲を明記する" } },
    );
    fireEvent.click(screen.getByRole("button", { name: "編集して採用" }));
    await waitFor(() => expect(post).toHaveBeenCalled());
    const [, init] = post.mock.calls[0]! as unknown as [
      string,
      { body: { title: string; content_md: string } },
    ];
    expect(init.body.title).toBe("見積は前提条件と対象範囲を明記する");
    expect(init.body.content_md).toBe(CAND.content_md);
  });

  it("却下すると reject API を叩き、再提案されない旨を伝える", async () => {
    const post = vi.fn(async () => ({ data: {} }));
    renderWithQuery(<KnowledgeCandidates client={clientOf(post)} />);
    fireEvent.click(await screen.findByRole("button", { name: "却下" }));
    await waitFor(() => expect(post).toHaveBeenCalled());
    const [path] = post.mock.calls[0]! as unknown as [string];
    expect(path).toBe("/knowledge/candidates/{candidate_id}/reject");
    expect(await screen.findByRole("status")).toHaveTextContent(
      "今後提案されません",
    );
  });

  it("候補が無いときは何も出さない (ノイズにしない)", async () => {
    const { container } = renderWithQuery(
      <KnowledgeCandidates client={clientOf(vi.fn(), [])} />,
    );
    await waitFor(() => expect(container.firstChild).toBeNull());
  });
});
