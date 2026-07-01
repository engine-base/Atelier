/**
 * T-UC-23 — S-M01 議事録アップロード 配線テスト
 *
 * 2 段階アップロード + 非同期 transcription の全フローを注入で駆動:
 *   upload-url → PUT → register → transcribe → poll(parsed_at) → 完了表示
 *   および parse_error → エラー表示。
 */

// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";

import * as React from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { type ApiClient } from "@atelier/api-client";
import { afterEach, describe, expect, it, vi } from "vitest";

import { MeetingUploadContainer } from "../../app/upload/s_m01/_components/MeetingUploadContainer";

function fakeClient(impl: { get?: unknown; post?: unknown }): ApiClient {
  const noop = vi.fn(async () => ({ data: {} }));
  return {
    get: impl.get ?? noop,
    post: impl.post ?? noop,
    patch: noop,
    delete: noop,
    put: noop,
    request: noop,
  } as unknown as ApiClient;
}

function selectFile(): void {
  const input = document.querySelector(
    'input[type="file"]',
  ) as HTMLInputElement;
  const file = new File(["audio-bytes"], "rec.m4a", { type: "audio/mp4" });
  fireEvent.change(input, { target: { files: [file] } });
}

afterEach(() => vi.clearAllMocks());

describe("S-M01 MeetingUploadContainer (T-UC-23)", () => {
  it("runs upload-url → PUT → register → transcribe → poll → 完了", async () => {
    const post = vi.fn(async (path: string) => {
      if (path === "/meetings/upload-url") {
        return {
          data: {
            upload_url: "https://storage/up",
            storage_path: "meetings/p1/x/rec.m4a",
          },
        };
      }
      if (path === "/meetings") return { data: { id: "m1" } };
      return { data: {} }; // transcribe
    });
    let polls = 0;
    const get = vi.fn(async () => {
      polls += 1;
      if (polls < 2) return { data: { parsed_at: null, parse_error: null } };
      return {
        data: {
          parsed_at: "2026-06-20T10:00:00Z",
          parse_result_path: "results/m1.json",
        },
      };
    });
    const uploadFile = vi.fn(async () => undefined);

    render(
      <MeetingUploadContainer
        projectId="p1"
        client={fakeClient({ get, post })}
        uploadFile={uploadFile}
        pollIntervalMs={5}
      />,
    );

    selectFile();

    expect(
      await screen.findByText(/文字起こしが完了しました/),
    ).toBeInTheDocument();
    expect(screen.getByText(/results\/m1\.json/)).toBeInTheDocument();

    // 各段が呼ばれたことを検証
    const postPaths = post.mock.calls.map((c) => (c as unknown as [string])[0]);
    expect(postPaths).toContain("/meetings/upload-url");
    expect(postPaths).toContain("/meetings");
    expect(postPaths).toContain("/meetings/{meeting_id}/transcribe");
    expect(uploadFile).toHaveBeenCalledWith(
      "https://storage/up",
      expect.any(File),
    );
    // /meetings 登録 body に storage_path と type=audio
    const registerCall = post.mock.calls.find(
      (c) => (c as unknown as [string])[0] === "/meetings",
    );
    const body = (
      registerCall as unknown as [string, { body: Record<string, unknown> }]
    )[1].body;
    expect(body.storage_path).toBe("meetings/p1/x/rec.m4a");
    expect(body.type).toBe("audio");
  });

  it("surfaces a parse_error from the transcription job", async () => {
    const post = vi.fn(async (path: string) => {
      if (path === "/meetings/upload-url") {
        return {
          data: {
            upload_url: "https://storage/up",
            storage_path: "meetings/p1/x/rec.m4a",
          },
        };
      }
      if (path === "/meetings") return { data: { id: "m1" } };
      return { data: {} };
    });
    const get = vi.fn(async () => ({
      data: { parse_error: "音声が不明瞭です" },
    }));

    render(
      <MeetingUploadContainer
        projectId="p1"
        client={fakeClient({ get, post })}
        uploadFile={vi.fn(async () => undefined)}
        pollIntervalMs={5}
      />,
    );

    selectFile();

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "文字起こしに失敗しました",
    );
  });
});
