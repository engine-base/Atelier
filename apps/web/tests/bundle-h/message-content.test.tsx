/**
 * GAP-118 — S-E01 MessageContent (markdown rich 描画) テスト
 *
 * react-markdown + remark-gfm + rehype-highlight の配線を検証する:
 *   - 見出し (h1→h3 縮退) / リスト / 段落の実描画
 *   - GFM 表が横スクロールコンテナ内の table として描画される
 *   - コードブロックが言語ラベル + コピー ボタン付きカードになり、
 *     コピーで clipboard に生コードが渡る (末尾改行なし)
 *   - インラインコードはチップ描画 (CodeBlock にならない)
 *   - リンクは新規タブ + rel=noopener noreferrer
 *   - 生 HTML は描画されない (XSS 安全: react-markdown 既定)
 */

// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";

import * as React from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { MessageContent } from "../../app/chat/s_e01/_components/MessageContent";

afterEach(() => vi.restoreAllMocks());

describe("S-E01 MessageContent (GAP-118)", () => {
  it("renders headings, paragraphs and lists as real elements", () => {
    render(
      <MessageContent
        content={"# 提案\n\n本文です。\n\n- 項目A\n- 項目B\n\n1. 手順1\n2. 手順2"}
      />,
    );
    // h1 は視覚階層を守るため h3 に縮退させる
    expect(screen.getByRole("heading", { level: 3, name: "提案" })).toBeInTheDocument();
    expect(screen.getByText("本文です。").tagName).toBe("P");
    const lists = screen.getAllByRole("list");
    expect(lists.some((l) => l.tagName === "UL")).toBe(true);
    expect(lists.some((l) => l.tagName === "OL")).toBe(true);
    expect(screen.getAllByRole("listitem")).toHaveLength(4);
  });

  it("renders GFM tables inside a horizontal-scroll wrapper", () => {
    render(
      <MessageContent
        content={"| 項目 | 値 |\n| --- | --- |\n| 単価 | 1000 |\n| 数量 | 3 |"}
      />,
    );
    const table = screen.getByRole("table");
    expect(table).toBeInTheDocument();
    expect(table.parentElement?.className).toContain("overflow-x-auto");
    expect(screen.getByRole("columnheader", { name: "項目" })).toBeInTheDocument();
    expect(screen.getByRole("cell", { name: "1000" })).toBeInTheDocument();
  });

  it("renders code blocks as cards with language label and copies raw code", async () => {
    const writeText = vi.fn(() => Promise.resolve());
    Object.assign(navigator, { clipboard: { writeText } });

    render(
      <MessageContent content={'```python\nprint("hello")\n```'} />,
    );
    // 言語ラベル
    expect(screen.getByText("python")).toBeInTheDocument();
    const copyBtn = screen.getByRole("button", { name: "コードをコピー" });
    expect(copyBtn).toHaveTextContent("コピー");
    fireEvent.click(copyBtn);
    // clipboard には末尾改行を落とした生コードが渡る
    expect(writeText).toHaveBeenCalledWith('print("hello")');
    // コピー完了フィードバック → 一定時間後に戻る
    await waitFor(() => expect(copyBtn).toHaveTextContent("コピー済み"));
  });

  it("labels unknown-language blocks as generic code", () => {
    render(<MessageContent content={"```\nplain text block\n```"} />);
    expect(screen.getByText("code")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "コードをコピー" }),
    ).toBeInTheDocument();
  });

  it("renders inline code as a chip, not a code block card", () => {
    render(<MessageContent content={"実行は `pnpm dev` です"} />);
    const inline = screen.getByText("pnpm dev");
    expect(inline.tagName).toBe("CODE");
    // ブロック用のコピー ボタンは出ない
    expect(screen.queryByRole("button", { name: "コードをコピー" })).toBeNull();
  });

  it("opens links in a new tab with rel=noopener", () => {
    render(<MessageContent content={"[Atelier](https://example.com)"} />);
    const link = screen.getByRole("link", { name: "Atelier" });
    expect(link).toHaveAttribute("href", "https://example.com");
    expect(link).toHaveAttribute("target", "_blank");
    expect(link).toHaveAttribute("rel", "noopener noreferrer");
  });

  it("renders blockquotes and horizontal rules", () => {
    render(<MessageContent content={"> 引用です\n\n---\n\n後続"} />);
    expect(screen.getByText("引用です").closest("blockquote")).not.toBeNull();
    expect(screen.getByRole("separator")).toBeInTheDocument();
  });

  it("does not render raw HTML (XSS safety)", () => {
    render(
      <MessageContent content={'<img src=x onerror="alert(1)">危険<script>alert(2)</script>'} />,
    );
    // img / script は DOM に生成されない
    expect(document.querySelector("img")).toBeNull();
    expect(document.querySelector("script")).toBeNull();
  });

  it("renders GFM strikethrough and task lists", () => {
    render(
      <MessageContent content={"~~取消~~\n\n- [x] 完了タスク\n- [ ] 未了タスク"} />,
    );
    expect(screen.getByText("取消").tagName).toBe("DEL");
    expect(screen.getAllByRole("checkbox")).toHaveLength(2);
  });
});
