/**
 * GAP-186 — 議事録の抽出項目を「確認して採用」→ 要件・タスク・決定へ反映。
 *
 * 経営者指示「1,2 だね」の ①。
 *
 * 固定する挙動:
 *   - **自動反映しない**。チェックして押したものだけが反映される
 *   - どこへ行くか（タスク／決定）を隠さない
 *   - 引用を出す = 採用前に「本当にそう言っていたか」を照合できる
 *   - 反映済みは選び直せず、反映先へ辿れる
 */

// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";

import * as React from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { MeetingAdoptPanel } from "../../app/upload/s_m01/_components/MeetingAdoptPanel";
import type { AdoptableItem } from "../../app/upload/s_m01/_components/meeting-adopt";

const ITEMS: AdoptableItem[] = [
  {
    kind: "requirement",
    key: "requirement:問い合わせフォームに自動返信",
    title: "問い合わせフォームに自動返信",
    detail: "送信後にサンクスメールを自動送信する",
    quote: "自動返信は絶対に欲しいです",
    meta: { kind: "functional", priority: "must" },
    adopted: false,
  },
  {
    kind: "action",
    key: "action:見積ドラフト作成",
    title: "見積ドラフト作成",
    detail: "",
    quote: "金曜までに見積もりをください",
    meta: { owner: "ワンダ", due: "今週金曜" },
    adopted: false,
  },
  {
    kind: "decision",
    key: "decision:構成は a 案で確定",
    title: "構成は A 案で確定",
    detail: "",
    quote: "じゃあ A 案でいきましょう",
    meta: {},
    adopted: true,
    target_type: "decision",
    target_id: "d1",
  },
  {
    kind: "open_question",
    key: "open_question:写真素材は誰が用意するか",
    title: "写真素材は誰が用意するか",
    detail: "",
    quote: "写真ってこちらで用意するんでしたっけ",
    meta: {},
    adopted: false,
  },
];

function renderPanel(
  overrides: {
    items?: AdoptableItem[];
    adoptItemsFn?: ReturnType<typeof vi.fn>;
    fetchAdoptableFn?: ReturnType<typeof vi.fn>;
  } = {},
) {
  const fetchAdoptableFn =
    overrides.fetchAdoptableFn ??
    vi.fn(async () => (overrides.items ?? ITEMS) as readonly AdoptableItem[]);
  const adoptItemsFn =
    overrides.adoptItemsFn ??
    vi.fn(async () => ({
      created: [],
      already: [],
      missing: [],
      message: "タスク 1 件 を作成しました。",
    }));
  const view = render(
    <MeetingAdoptPanel
      meetingId="m1"
      projectId="p1"
      fetchAdoptableFn={fetchAdoptableFn as never}
      adoptItemsFn={adoptItemsFn as never}
    />,
  );
  return { ...view, fetchAdoptableFn, adoptItemsFn };
}

describe("GAP-186 議事録の抽出項目の採用", () => {
  it("自動では反映せず、チェックするまで反映ボタンが押せない", async () => {
    const { adoptItemsFn } = renderPanel();
    const button = await screen.findByRole("button", { name: /選んだ 0 件を反映する/ });
    expect(button).toBeDisabled();
    fireEvent.click(button);
    expect(adoptItemsFn).not.toHaveBeenCalled();
  });

  it("どこへ反映されるかを隠さない", async () => {
    renderPanel();
    expect(await screen.findByText("抽出要件")).toBeInTheDocument();
    expect(screen.getAllByText("タスクとして追加されます")).toHaveLength(2);
    expect(screen.getByText("決定として記録されます")).toBeInTheDocument();
    expect(screen.getByText("未決の決定として記録されます")).toBeInTheDocument();
  });

  it("引用を出す（採用前に創作でないか照合できる）", async () => {
    renderPanel();
    expect(
      await screen.findByText("「自動返信は絶対に欲しいです」"),
    ).toBeInTheDocument();
    expect(screen.getByText("「じゃあ A 案でいきましょう」")).toBeInTheDocument();
  });

  it("担当・期限・優先度を項目に添える", async () => {
    renderPanel();
    expect(await screen.findByText("担当 ワンダ")).toBeInTheDocument();
    expect(screen.getByText("期限 今週金曜")).toBeInTheDocument();
    expect(screen.getByText("優先度 必須")).toBeInTheDocument();
  });

  it("チェックした項目だけを反映する", async () => {
    const { adoptItemsFn } = renderPanel();
    const box = await screen.findByLabelText(/問い合わせフォームに自動返信/);
    fireEvent.click(box);
    const button = await screen.findByRole("button", { name: /選んだ 1 件を反映する/ });
    fireEvent.click(button);
    await waitFor(() =>
      expect(adoptItemsFn).toHaveBeenCalledWith("m1", [
        "requirement:問い合わせフォームに自動返信",
      ]),
    );
  });

  it("反映済みの項目は選べず、反映先へ辿れる", async () => {
    renderPanel();
    expect(await screen.findByText("反映済み")).toBeInTheDocument();
    expect(screen.queryByLabelText(/構成は A 案で確定/)).toBeNull();
    expect(screen.getByRole("link", { name: "決定を開く" })).toHaveAttribute(
      "href",
      "/decisions?project=p1",
    );
  });

  it("「すべて選ぶ」は反映済みを含めない", async () => {
    renderPanel();
    fireEvent.click(await screen.findByRole("button", { name: "すべて選ぶ" }));
    // 未反映は 3 件（要件・アクション・未決）
    expect(
      await screen.findByRole("button", { name: /選んだ 3 件を反映する/ }),
    ).toBeInTheDocument();
  });

  it("反映の結果をそのまま画面に出す（件数を偽らない）", async () => {
    const adoptItemsFn = vi.fn(async () => ({
      created: [],
      already: ["requirement:問い合わせフォームに自動返信"],
      missing: [],
      message: "1 件はすでに採用済みのため作成していません。",
    }));
    renderPanel({ adoptItemsFn });
    fireEvent.click(await screen.findByLabelText(/問い合わせフォームに自動返信/));
    fireEvent.click(await screen.findByRole("button", { name: /選んだ 1 件を反映する/ }));
    expect(
      await screen.findByText("1 件はすでに採用済みのため作成していません。"),
    ).toBeInTheDocument();
  });

  it("解析がまだ無いときは行き止まりにせず理由を出す", async () => {
    const fetchAdoptableFn = vi.fn(async () => {
      throw new Error("adoptable failed: 409");
    });
    renderPanel({ fetchAdoptableFn });
    expect(await screen.findByRole("alert")).toHaveTextContent(
      /解析が完了しているか確認してください/,
    );
  });

  it("採用できる項目が無ければ、そう書く", async () => {
    renderPanel({ items: [] });
    expect(
      await screen.findByText(/要件・タスク・決定として残せる項目はありませんでした/),
    ).toBeInTheDocument();
  });
});
