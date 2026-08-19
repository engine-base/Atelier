/**
 * GAP-184 — 議事録の解析結果が「1 時間の打合せの厚み」で出ること。
 *
 * 直前の実態: 要約・話者・要件・アクションの 4 項目だけで、決定事項・論点・
 * 数値/金額/期限・リスク・未決が丸ごと欠落。しかもサーバー側が本文を
 * 24,000 字で打ち切っており、1 時間超の会議は後半が存在しないことになっていた。
 */

// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";

import * as React from "react";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import {
  MeetingAnalysisView,
  toRequirement,
  type MeetingAnalysis,
} from "../../app/upload/s_m01/_components/MeetingAnalysisView";

const RICH: MeetingAnalysis = {
  summary: "LP 制作の要件と予算・納期を確認した。",
  speakers: [{ name: "田中", role: "クライアント" }],
  agenda: ["現状の課題", "構成案の比較"],
  decisions: [
    {
      title: "構成は A 案で確定",
      detail: "トップ + 問い合わせの 2 ページ",
      decided_by: "田中",
      quote: "じゃあ A 案でいきましょう",
    },
  ],
  requirements: [
    {
      title: "問い合わせフォームに自動返信",
      detail: "送信後にサンクスメール",
      kind: "functional",
      priority: "must",
      quote: "自動返信は絶対に欲しいです",
    },
  ],
  open_questions: [
    { question: "写真素材は誰が用意するか", context: "権利が不明", quote: "写真ってこちらで？" },
  ],
  risks: [{ title: "素材の到着遅れ", impact: "公開日が後ろ倒し", quote: "素材が遅れると厳しい" }],
  action_items: [
    { title: "見積ドラフト作成", owner: "ワンダ", due: "今週金曜", quote: "金曜までに" },
  ],
  facts: [{ label: "予算", value: "80 万円", quote: "予算は 80 万くらいで" }],
  next_meeting: { date: "来週水曜 14:00", agenda: "見積のレビュー" },
  segments: 3,
  source_chars: 25000,
};

describe("GAP-184 厚い議事録の表示", () => {
  it("欠落していた 5 種類 (決定/未決/リスク/数値/議題) が出る", () => {
    render(<MeetingAnalysisView analysis={RICH} />);
    expect(screen.getByText("構成は A 案で確定")).toBeInTheDocument();
    expect(screen.getByText("写真素材は誰が用意するか")).toBeInTheDocument();
    expect(screen.getByText("素材の到着遅れ")).toBeInTheDocument();
    expect(screen.getByText("予算")).toBeInTheDocument();
    expect(screen.getByText("80 万円")).toBeInTheDocument();
    expect(screen.getByText("現状の課題")).toBeInTheDocument();
  });

  it("各項目に文字起こしの引用が付く (創作を人が検出できる)", () => {
    render(<MeetingAnalysisView analysis={RICH} />);
    expect(screen.getByText(/じゃあ A 案でいきましょう/)).toBeInTheDocument();
    expect(screen.getByText(/自動返信は絶対に欲しいです/)).toBeInTheDocument();
    expect(screen.getByText(/予算は 80 万くらいで/)).toBeInTheDocument();
  });

  it("要件は必須/推奨と機能/非機能を出し分ける", () => {
    render(<MeetingAnalysisView analysis={RICH} />);
    expect(screen.getByText("必須")).toBeInTheDocument();
    expect(screen.getByText("機能")).toBeInTheDocument();
  });

  it("アクションに期限と担当が出る", () => {
    render(<MeetingAnalysisView analysis={RICH} />);
    expect(screen.getByText("期限 今週金曜")).toBeInTheDocument();
    expect(screen.getByText(/ワンダ/)).toBeInTheDocument();
  });

  it("長い会議を分割して全文読んだことを明示する", () => {
    render(<MeetingAnalysisView analysis={RICH} />);
    expect(
      screen.getByText(/3 区間に分けて全文を解析しました/),
    ).toBeInTheDocument();
    expect(screen.getByText(/25,000 字/)).toBeInTheDocument();
  });

  it("解析しきれなかった場合は隠さず警告する", () => {
    render(<MeetingAnalysisView analysis={{ ...RICH, truncated: true }} />);
    expect(screen.getByRole("alert")).toHaveTextContent(
      /一部が解析されていません/,
    );
  });

  it("空の項目は「無い」と正直に書く (箱だけ並べない)", () => {
    render(
      <MeetingAnalysisView
        analysis={{
          summary: "短い打合せ",
          speakers: [],
          requirements: [],
          action_items: [],
        }}
      />,
    );
    expect(
      screen.getByText("この打合せで確定した事項はありませんでした"),
    ).toBeInTheDocument();
    expect(screen.getByText("具体的な数値は出ませんでした")).toBeInTheDocument();
  });

  it("旧形式 (文字列だけの要件) も壊れずに出る", () => {
    expect(toRequirement("納期 4 週間")).toEqual({ title: "納期 4 週間" });
    render(
      <MeetingAnalysisView
        analysis={{
          summary: "旧データ",
          speakers: [],
          requirements: ["納期 4 週間"],
          action_items: [],
        }}
      />,
    );
    expect(screen.getByText("納期 4 週間")).toBeInTheDocument();
  });
});
