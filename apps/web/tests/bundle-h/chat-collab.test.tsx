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
    const onUpload = vi.fn(async () => "transcribed!");
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

describe("SalesDocDraft (T-UC-24)", () => {
  it("blocks submit when required fields are empty", async () => {
    const onDraft = vi.fn();
    render(<SalesDocDraft onDraft={onDraft} />);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "ドラフト生成" }));
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(onDraft).not.toHaveBeenCalled();
  });

  it("generates and displays draft on submit", async () => {
    const onDraft = vi.fn(async () => "# generated");
    render(<SalesDocDraft onDraft={onDraft} />);
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
      fireEvent.click(screen.getByRole("button", { name: "ドラフト生成" }));
      await new Promise((r) => setTimeout(r, 50));
    });
    expect(onDraft).toHaveBeenCalled();
    expect(screen.getByText("# generated")).toBeInTheDocument();
  });
});
