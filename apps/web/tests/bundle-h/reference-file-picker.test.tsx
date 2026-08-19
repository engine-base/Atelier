/**
 * GAP-161 — スタジオの参考資料ピッカー。
 *
 * 「アップロードして参考にさせる」が実際に配線されているか (署名 URL 取得 →
 * 実 PUT → storage_path を親へ) と、失敗時に「上げたつもり」にさせないこと。
 */

// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";

import * as React from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ApiClient } from "@atelier/api-client";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  ReferenceFilePicker,
  type ReferenceFileRef,
} from "../../components/ReferenceFilePicker";

function clientOf(post: ReturnType<typeof vi.fn>): ApiClient {
  return {
    get: vi.fn(),
    post,
    put: vi.fn(),
    patch: vi.fn(),
    delete: vi.fn(),
    request: vi.fn(),
  } as unknown as ApiClient;
}

const XLSX = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

afterEach(() => vi.clearAllMocks());

describe("ReferenceFilePicker (GAP-161)", () => {
  it("Excel を選ぶと署名 URL を取り、実 PUT してから storage_path を親へ渡す", async () => {
    const post = vi.fn(async () => ({
      data: { upload_url: "https://storage.test/put", storage_path: "reference-uploads/u/見積.xlsx" },
    }));
    const putCalls: RequestInit[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init: RequestInit) => {
        putCalls.push(init);
        return { ok: true } as Response;
      }),
    );
    let got: readonly ReferenceFileRef[] = [];
    render(
      <ReferenceFilePicker
        client={clientOf(post)}
        files={[]}
        onChange={(f) => {
          got = f;
        }}
      />,
    );
    const file = new File(["x"], "見積.xlsx", { type: XLSX });
    fireEvent.change(screen.getByLabelText("参考資料ファイル"), {
      target: { files: [file] },
    });
    await waitFor(() => expect(got).toHaveLength(1));
    const [path, init] = post.mock.calls[0]! as unknown as [
      string,
      { body: { file_name: string; mime_type: string; file_size_bytes: number } },
    ];
    expect(path).toBe("/reference-uploads");
    expect(init.body.file_name).toBe("見積.xlsx");
    expect(init.body.mime_type).toBe(XLSX);
    expect(putCalls[0]?.method).toBe("PUT");
    expect(got[0]).toEqual({
      storage_path: "reference-uploads/u/見積.xlsx",
      file_name: "見積.xlsx",
      mime_type: XLSX,
    });
    vi.unstubAllGlobals();
  });

  it("アップロード失敗は正直に出し、参考資料に加えない", async () => {
    const post = vi.fn(async () => ({
      data: { upload_url: "https://storage.test/put", storage_path: "reference-uploads/u/a.pdf" },
    }));
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, status: 500 }) as Response));
    const onChange = vi.fn();
    render(<ReferenceFilePicker client={clientOf(post)} files={[]} onChange={onChange} />);
    fireEvent.change(screen.getByLabelText("参考資料ファイル"), {
      target: { files: [new File(["x"], "a.pdf", { type: "application/pdf" })] },
    });
    expect(await screen.findByRole("alert")).toHaveTextContent("アップロードに失敗");
    expect(onChange).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it("未対応形式は上げる前に断る (無言で落とさない)", async () => {
    const post = vi.fn();
    const onChange = vi.fn();
    render(<ReferenceFilePicker client={clientOf(post)} files={[]} onChange={onChange} />);
    fireEvent.change(screen.getByLabelText("参考資料ファイル"), {
      target: { files: [new File(["x"], "movie.mp4", { type: "video/mp4" })] },
    });
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "この形式は参考資料に使えません",
    );
    expect(post).not.toHaveBeenCalled();
    expect(onChange).not.toHaveBeenCalled();
  });
});
