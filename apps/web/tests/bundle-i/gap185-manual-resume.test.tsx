/**
 * GAP-185 — 止まったものを「言えば再開できる」。
 *
 * 経営者判断: 「自動はしなくていいけど、止まった状態で進めてと言ったりしたら
 * 再開はできる状態にしておかないとね」
 *
 * 自動再開はしない (勝手に利用者の Claude プラン枠を使わない)。人が押したときだけ動く。
 */

// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";

import * as React from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import {
  TranscriptUpload,
  type MeetingRow,
} from "../../app/upload/s_m01/_components/TranscriptUpload";

const HISTORY: MeetingRow[] = [
  {
    id: "m1",
    fileName: "打合せ.mp3",
    sizeLabel: "12 MB",
    typeIcon: "audio",
    status: "done",
  },
];

function renderWith(
  analysisError: string,
  onResumeAnalysis?: (id: string) => void,
  resuming = false,
) {
  return render(
    <TranscriptUpload
      onUpload={async () => ({ text: "" })}
      history={HISTORY}
      onOpen={async () => ({
        text: "文字起こし本文",
        analysis: null,
        analysisError,
      })}
      {...(onResumeAnalysis ? { onResumeAnalysis } : {})}
      resuming={resuming}
    />,
  );
}

async function openTheMeeting() {
  fireEvent.click(screen.getByRole("button", { name: "打合せ.mp3" }));
  await waitFor(() =>
    expect(screen.getByText(/構造化解析は未実行です/)).toBeInTheDocument(),
  );
}

describe("GAP-185 止まった解析の手動再開", () => {
  it("PC 未接続で止まったら「今すぐ実行」を出す", async () => {
    const onResume = vi.fn();
    renderWith("bridge_offline", onResume);
    await openTheMeeting();
    expect(
      screen.getByText(/お使いのパソコン \(Bridge\) が未接続でした/),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "解析を今すぐ実行" }));
    expect(onResume).toHaveBeenCalledWith("m1");
  });

  it("プラン枠の上限も「失敗」ではなく再開できる状態で出す", async () => {
    const onResume = vi.fn();
    renderWith("rate_limited", onResume);
    await openTheMeeting();
    expect(
      screen.getByText(/Claude プランの利用枠が上限に達していました/),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "解析を今すぐ実行" }),
    ).toBeInTheDocument();
  });

  it("恒久的な失敗には再開ボタンを出さない (嘘をつかない)", async () => {
    const onResume = vi.fn();
    renderWith("parse_failed", onResume);
    await openTheMeeting();
    expect(
      screen.queryByRole("button", { name: "解析を今すぐ実行" }),
    ).not.toBeInTheDocument();
  });

  it("再開の口が無い環境ではボタン自体を出さない", async () => {
    renderWith("bridge_offline");
    await openTheMeeting();
    expect(
      screen.queryByRole("button", { name: "解析を今すぐ実行" }),
    ).not.toBeInTheDocument();
  });

  it("実行中は二度押しさせない", async () => {
    renderWith("bridge_offline", vi.fn(), true);
    await openTheMeeting();
    const btn = screen.getByRole("button", { name: "解析中…" });
    expect(btn).toBeDisabled();
  });
});
