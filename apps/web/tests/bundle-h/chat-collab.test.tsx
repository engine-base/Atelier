/**
 * Bundle H tests: ChatPanel / ProcessContextBar / OutputViewer / MockViewer /
 *                 TranscriptUpload / SalesDocDraft
 */

// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";

import * as React from "react";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import {
  ChatPanel,
  type ChatMessage,
} from "../../app/chat/s_e01/_components/ChatPanel";
import { ProcessContextBar } from "../../app/chat/s_e01/_components/ProcessContextBar";
import {
  OutputViewer,
  type OutputComment,
} from "../../app/outputs/s_g01/_components/OutputViewer";
import { MockViewer } from "../../app/mocks/s_h01/_components/MockViewer";
import { TranscriptUpload } from "../../app/upload/s_m01/_components/TranscriptUpload";
import { SalesDocDraft } from "../../app/sales/s_n01/_components/SalesDocDraft";

describe("ChatPanel (T-UC-08)", () => {
  const msgs: ChatMessage[] = [
    { id: "m1", role: "user", content: "こんにちは" },
    { id: "m2", role: "assistant", content: "お手伝いします" },
  ];

  it("renders messages with role labels", () => {
    render(<ChatPanel messages={msgs} onSend={() => undefined} />);
    expect(screen.getByText("こんにちは")).toBeInTheDocument();
    expect(screen.getByText("お手伝いします")).toBeInTheDocument();
    expect(screen.getByText("あなた")).toBeInTheDocument();
  });

  it("uses log role with aria-live polite", () => {
    render(<ChatPanel messages={msgs} onSend={() => undefined} />);
    const log = screen.getByRole("log");
    expect(log.getAttribute("aria-live")).toBe("polite");
  });

  it("disables send when input is empty", () => {
    render(<ChatPanel messages={[]} onSend={() => undefined} />);
    expect(screen.getByRole("button", { name: "送信" })).toBeDisabled();
  });

  it("calls onSend on submit and clears input", () => {
    const onSend = vi.fn();
    render(<ChatPanel messages={[]} onSend={onSend} />);
    const ta = screen.getByLabelText("メッセージを入力");
    fireEvent.change(ta, { target: { value: "hi" } });
    fireEvent.click(screen.getByRole("button", { name: "送信" }));
    expect(onSend).toHaveBeenCalledWith("hi");
    expect((ta as HTMLTextAreaElement).value).toBe("");
  });
});

describe("ProcessContextBar (T-UC-09)", () => {
  it("marks current phase with aria-current", () => {
    render(
      <ProcessContextBar
        phases={["A", "B"]}
        currentPhaseId="B"
        onChange={() => undefined}
      />,
    );
    const b = screen.getByRole("button", { name: "B" });
    expect(b.getAttribute("aria-current")).toBe("true");
  });

  it("invokes onChange on click", () => {
    const onChange = vi.fn();
    render(
      <ProcessContextBar
        phases={["A", "B"]}
        currentPhaseId="A"
        onChange={onChange}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "B" }));
    expect(onChange).toHaveBeenCalledWith("B");
  });
});

describe("OutputViewer (T-UC-12)", () => {
  const comments: OutputComment[] = [
    { id: "p1", author: "wanda", content: "x", createdAt: "2026-06-20 10:00" },
  ];

  it("renders title, content iframe, and comments", () => {
    render(
      <OutputViewer title="T" contentUrl="about:blank" comments={comments} />,
    );
    expect(screen.getByRole("heading", { name: "T" })).toBeInTheDocument();
    expect(screen.getByTitle("T")).toHaveAttribute("src", "about:blank");
    expect(screen.getByText(/wanda/)).toBeInTheDocument();
  });

  it("renders the comment list", () => {
    render(
      <OutputViewer title="T" contentUrl="about:blank" comments={comments} />,
    );
    expect(
      screen.getByRole("list", { name: "コメント一覧" }),
    ).toBeInTheDocument();
  });
});

describe("MockViewer (T-UC-13)", () => {
  it("renders title and viewport toggles", () => {
    render(<MockViewer src="about:blank" title="M" />);
    expect(screen.getByRole("heading", { name: "M" })).toBeInTheDocument();
    expect(
      screen.getByRole("group", { name: "ビューポート切替" }),
    ).toBeInTheDocument();
  });

  it("switches viewport on click (aria-pressed updates)", () => {
    render(<MockViewer src="about:blank" title="M" />);
    const btn320 = screen.getByRole("button", { name: /320/ });
    fireEvent.click(btn320);
    expect(btn320.getAttribute("aria-pressed")).toBe("true");
  });
});

describe("TranscriptUpload (T-UC-23)", () => {
  it("shows uploading status and transcript on success", async () => {
    const onUpload = vi.fn(async () => ({ text: "transcribed!" }));
    render(<TranscriptUpload onUpload={onUpload} />);
    const file = new File(["x"], "a.wav", { type: "audio/wav" });
    const input = screen.getByLabelText(/音声/) as HTMLInputElement;
    await act(async () => {
      fireEvent.change(input, { target: { files: [file] } });
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(onUpload).toHaveBeenCalled();
    expect(screen.getByText("transcribed!")).toBeInTheDocument();
  });

  it("shows error message on upload failure", async () => {
    const onUpload = vi.fn(async () => {
      throw new Error("boom");
    });
    render(<TranscriptUpload onUpload={onUpload} />);
    const file = new File(["x"], "a.wav", { type: "audio/wav" });
    await act(async () => {
      fireEvent.change(screen.getByLabelText(/音声/), {
        target: { files: [file] },
      });
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(screen.getByRole("alert")).toHaveTextContent("boom");
  });
});

describe("SalesDocDraft (T-UC-24 / GAP-018)", () => {
  const ZERO_COUNTS = {
    proposal: 0,
    estimate: 0,
    contract: 0,
    nda: 0,
    invoice: 0,
  };
  const baseProps = {
    docType: "proposal" as const,
    onDocTypeChange: vi.fn(),
    docs: [],
    counts: ZERO_COUNTS,
    onGenerate: vi.fn(async () => DOC_A),
    onSaveRaw: vi.fn(async () => DOC_A),
    onEdit: vi.fn(async () => undefined),
    onDelete: vi.fn(),
    chatHref: "/chat?project=p1",
    selected: null,
    onSelect: vi.fn(),
  };
  const DOC_A = {
    id: "d1",
    docType: "proposal" as const,
    summary: "# 提案A\n\n本文",
    version: 1,
    createdAt: "2026-07-01T00:00:00Z",
  };

  /** controlled selection の動作検証用ハーネス。 */
  function Harness(props: Partial<React.ComponentProps<typeof SalesDocDraft>>) {
    const [selected, setSelected] = React.useState<
      React.ComponentProps<typeof SalesDocDraft>["selected"]
    >(props.selected ?? null);
    return (
      <SalesDocDraft
        {...baseProps}
        {...props}
        selected={selected}
        onSelect={setSelected}
      />
    );
  }

  it("blocks submit when required fields are empty", async () => {
    const onGenerate = vi.fn();
    render(<SalesDocDraft {...baseProps} onGenerate={onGenerate} />);
    await act(async () => {
      fireEvent.click(
        screen.getByRole("button", { name: "トニーにドラフト生成を依頼" }),
      );
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(onGenerate).not.toHaveBeenCalled();
  });

  it("requests an AI draft from Tony and opens it in the preview", async () => {
    const onGenerate = vi.fn(async () => ({
      ...DOC_A,
      summary: "# generated",
      generatedBy: "tony",
      knowledgeRefs: [{ id: "k1", title: "受託案件の提案書テンプレ v3" }],
      steps: ["ナレッジ参照 (1 件)", "トニーが本文を生成 (fake-llm)"],
    }));
    render(<Harness onGenerate={onGenerate} />);
    fireEvent.change(screen.getByLabelText(/顧客名/), {
      target: { value: "ACME" },
    });
    fireEvent.change(screen.getByLabelText(/案件/), {
      target: { value: "X 検討" },
    });
    fireEvent.change(screen.getByLabelText(/商談概要/), {
      target: { value: "十分に長い商談概要のサンプルテキスト" },
    });
    await act(async () => {
      fireEvent.click(
        screen.getByRole("button", { name: "トニーにドラフト生成を依頼" }),
      );
      await new Promise((r) => setTimeout(r, 50));
    });
    expect(onGenerate).toHaveBeenCalled();
    expect(screen.getByText("# generated")).toBeInTheDocument();
    // 実生成トレース: 生成プロセスが実工程 + 参照ナレッジ実表示 (参考手順ではない)
    expect(screen.getByText("ナレッジ参照 (1 件)")).toBeInTheDocument();
    expect(
      screen.getByText("受託案件の提案書テンプレ v3"),
    ).toBeInTheDocument();
    expect(screen.queryByText("（参考手順）")).not.toBeInTheDocument();
  });

  it("keeps a non-AI save path (AI を使わず保存)", async () => {
    const onSaveRaw = vi.fn(async () => DOC_A);
    render(<Harness onSaveRaw={onSaveRaw} />);
    fireEvent.change(screen.getByLabelText(/顧客名/), {
      target: { value: "ACME" },
    });
    fireEvent.change(screen.getByLabelText(/案件/), {
      target: { value: "X 検討" },
    });
    fireEvent.change(screen.getByLabelText(/商談概要/), {
      target: { value: "十分に長い商談概要のサンプルテキスト" },
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "AI を使わず保存" }));
      await new Promise((r) => setTimeout(r, 50));
    });
    expect(onSaveRaw).toHaveBeenCalled();
  });

  it("renders all 5 real doc-type tabs with counts (GAP-018)", () => {
    const onDocTypeChange = vi.fn();
    render(
      <SalesDocDraft
        {...baseProps}
        counts={{ proposal: 3, estimate: 1, contract: 2, nda: 1, invoice: 0 }}
        onDocTypeChange={onDocTypeChange}
      />,
    );
    for (const label of ["提案書", "見積書", "業務委託契約", "NDA", "請求書"]) {
      expect(screen.getByRole("tab", { name: new RegExp(label) })).toBeInTheDocument();
    }
    fireEvent.click(screen.getByRole("tab", { name: /業務委託契約/ }));
    expect(onDocTypeChange).toHaveBeenCalledWith("contract");
    expect(screen.getByRole("tab", { name: /提案書/ })).toHaveTextContent("3");
  });

  it("history delete is 2-step", () => {
    const onDelete = vi.fn();
    render(
      <SalesDocDraft
        {...baseProps}
        docs={[{ ...DOC_A, version: 2 }]}
        onDelete={onDelete}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "v2 を削除" }));
    expect(onDelete).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "削除する" }));
    expect(onDelete).toHaveBeenCalledWith("d1");
  });

  it("selecting a history row opens it in the preview", () => {
    render(<Harness docs={[DOC_A]} />);
    fireEvent.click(screen.getByRole("button", { name: /提案A/ }));
    expect(
      screen.getByRole("article", { name: "生成ドラフト" }),
    ).toHaveTextContent("本文");
    // 修正依頼はチャットへの実リンク
    expect(screen.getByRole("link", { name: /修正依頼/ })).toHaveAttribute(
      "href",
      "/chat?project=p1",
    );
  });

  it("downloads the PDF of the selected doc (GAP-018)", () => {
    const onPdf = vi.fn();
    render(<SalesDocDraft {...baseProps} selected={DOC_A} onPdf={onPdf} />);
    fireEvent.click(screen.getByRole("button", { name: "PDF" }));
    expect(onPdf).toHaveBeenCalledWith("d1");
  });

  it("sends the doc by email via the send dialog (GAP-018)", () => {
    const onSend = vi.fn();
    render(<SalesDocDraft {...baseProps} selected={DOC_A} onSend={onSend} />);
    fireEvent.click(screen.getByRole("button", { name: "送信" }));
    const dialog = screen.getByRole("dialog", {
      name: "クライアントにメール送信",
    });
    fireEvent.change(screen.getByPlaceholderText("client@example.com"), {
      target: { value: "client@example.com" },
    });
    fireEvent.submit(dialog);
    expect(onSend).toHaveBeenCalledWith("d1", {
      toEmail: "client@example.com",
      subject: undefined,
      message: undefined,
    });
  });

  it("renders the real send history with an honest dry-run badge (GAP-018)", () => {
    render(
      <SalesDocDraft
        {...baseProps}
        selected={DOC_A}
        onSend={vi.fn()}
        sends={[
          {
            id: "s1",
            toEmail: "client@example.com",
            subject: "【提案書ドラフト】提案A",
            dryRun: true,
            createdAt: "2026-08-10T09:00:00Z",
          },
        ]}
      />,
    );
    expect(screen.getByText("client@example.com")).toBeInTheDocument();
    expect(screen.getByText("dry-run（メール未設定）")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "クライアントにメール送信" }),
    ).toBeInTheDocument();
  });

  it("shows the generic process card as 参考手順 for manual docs", () => {
    render(<SalesDocDraft {...baseProps} selected={DOC_A} />);
    expect(screen.getByText("（参考手順）")).toBeInTheDocument();
    // 参照ナレッジカードはトレースが無ければ出さない (推測ソースを出さない)
    expect(screen.queryByText("参照ナレッジ")).not.toBeInTheDocument();
  });
});


describe("TranscriptUpload 構造化解析 (GAP-015)", () => {
  const analyzed = {
    text: "こんにちは。LP の件です。",
    analysis: {
      summary: "LP 制作の要件を確認した。",
      speakers: [{ name: "田中", role: "クライアント" }],
      requirements: ["トップ + 問い合わせの 2 ページ"],
      action_items: [{ title: "見積ドラフト作成", owner: "ワンダ" }],
    },
  };

  it("analysis があればサマリー/話者/抽出要件/アクションアイテムを描画", async () => {
    const onUpload = vi.fn(async () => analyzed);
    render(<TranscriptUpload onUpload={onUpload} />);
    const input = screen.getByLabelText(/音声/) as HTMLInputElement;
    await act(async () => {
      fireEvent.change(input, {
        target: { files: [new File(["x"], "a.wav", { type: "audio/wav" })] },
      });
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(screen.getByText("LP 制作の要件を確認した。")).toBeInTheDocument();
    expect(screen.getByText("田中")).toBeInTheDocument();
    expect(screen.getByText("（クライアント）")).toBeInTheDocument();
    expect(
      screen.getByText("トップ + 問い合わせの 2 ページ"),
    ).toBeInTheDocument();
    expect(screen.getByText("見積ドラフト作成")).toBeInTheDocument();
  });

  it("analysis_error は誠実な未実行表示 (偽の解析を出さない)", async () => {
    const onUpload = vi.fn(async () => ({
      text: "本文",
      analysisError: "llm_unconfigured",
    }));
    render(<TranscriptUpload onUpload={onUpload} />);
    const input = screen.getByLabelText(/音声/) as HTMLInputElement;
    await act(async () => {
      fireEvent.change(input, {
        target: { files: [new File(["x"], "a.wav", { type: "audio/wav" })] },
      });
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(screen.getByText(/構造化解析は未実行です/)).toBeInTheDocument();
    // GAP-177: 解析は本人の PC の Claude で走る。未接続なら保留され、繋がれば
    // 自動で解析されるので、その旨をユーザーに伝える文言になった。
    expect(
      screen.getByText(/接続すると自動で解析されます/),
    ).toBeInTheDocument();
    expect(screen.queryByText("サマリー")).toBeNull();
  });
});
