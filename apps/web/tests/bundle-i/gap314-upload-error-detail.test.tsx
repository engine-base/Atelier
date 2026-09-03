/**
 * GAP-314 (通し J34-06 再測) — S-M01: 対応外の形式を上げたとき、サーバーの日本語の理由が
 * そのまま画面に出る (内部文言「Atelier API POST … -> 422」は出さない)。
 */

// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";

import * as React from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import {
  TranscriptUpload,
  userFacingMessage,
} from "../../app/upload/s_m01/_components/TranscriptUpload";

const DETAIL =
  "対応していない形式です (.exe)。音声・動画・テキスト (.txt / .md)・Word (.docx) のみ登録できます。";

function apiError422() {
  const err = new Error("Atelier API POST /meetings/upload-url -> 422 Unprocessable Content");
  return Object.assign(err, { status: 422, payload: { detail: DETAIL } });
}

describe("S-M01 対応外形式のエラー文言 (GAP-314)", () => {
  it("userFacingMessage はサーバーの detail を優先し、内部文言は出さない", () => {
    expect(userFacingMessage(apiError422())).toBe(DETAIL);
    expect(userFacingMessage(new Error("Atelier API POST /x -> 500"))).toMatch(/登録できませんでした/);
    expect(userFacingMessage(Object.assign(new Error("boom"), { status: 502 }))).toMatch(/サーバー側/);
    expect(userFacingMessage(new Error("ネットワークに接続できません"))).toBe("ネットワークに接続できません");
  });

  it("アップロード失敗時に detail がそのまま表示される", async () => {
    const { container } = render(
      <TranscriptUpload
        onUpload={async () => {
          throw apiError422();
        }}
        history={[]}
      />,
    );
    const input = container.querySelector('input[type="file"]') as HTMLInputElement;
    expect(input).not.toBeNull();
    const file = new File(["MZ"], "setup.exe", { type: "application/x-msdownload" });
    fireEvent.change(input, { target: { files: [file] } });
    await waitFor(() => expect(screen.getByText(DETAIL)).toBeInTheDocument());
    expect(screen.queryByText(/Atelier API POST/)).toBeNull();
  });
});
