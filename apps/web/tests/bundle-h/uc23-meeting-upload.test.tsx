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
import { QueryClientProvider } from "@tanstack/react-query";
import { type ApiClient } from "@atelier/api-client";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createQueryClient } from "../../lib/query-client";
import { MeetingUploadContainer } from "../../app/upload/s_m01/_components/MeetingUploadContainer";

function fakeClient(impl: {
  get?: unknown;
  post?: unknown;
  delete?: unknown;
}): ApiClient {
  const noop = vi.fn(async () => ({ data: {} }));
  return {
    get: impl.get ?? noop,
    post: impl.post ?? noop,
    patch: noop,
    delete: impl.delete ?? noop,
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
    const get = vi.fn(async (path: string) => {
      if (path.includes("transcript-url")) {
        return { data: { url: "https://storage/signed/m1.json?token=x" } };
      }
      polls += 1;
      if (polls < 2) return { data: { parsed_at: null, parse_error: null } };
      return {
        data: {
          parsed_at: "2026-06-20T10:00:00Z",
          parse_result_path: "transcripts/queued/m1.json",
        },
      };
    });
    const uploadFile = vi.fn(async () => undefined);
    const fetchText = vi.fn(async () => "これは文字起こし本文です。");

    render(
      <QueryClientProvider client={createQueryClient()}>
      <MeetingUploadContainer
        projectId="p1"
        client={fakeClient({ get, post })}
        uploadFile={uploadFile}
        fetchText={fetchText}
        pollIntervalMs={5}
      />
      </QueryClientProvider>,
    );

    selectFile();

    // 完了時に実際の文字起こし本文が表示される
    expect(
      await screen.findByText("これは文字起こし本文です。"),
    ).toBeInTheDocument();
    expect(fetchText).toHaveBeenCalledWith(
      "https://storage/signed/m1.json?token=x",
    );

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
      <QueryClientProvider client={createQueryClient()}>
      <MeetingUploadContainer
        projectId="p1"
        client={fakeClient({ get, post })}
        uploadFile={vi.fn(async () => undefined)}
        pollIntervalMs={5}
      />
      </QueryClientProvider>,
    );

    selectFile();

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "文字起こしに失敗しました",
    );
  });
});

// ── v2 (モック忠実再構築): 履歴 / 開く / 削除 ─────────────────────────────

const HISTORY = [
  {
    id: "m1",
    type: "audio",
    file_name: "kickoff_call.m4a",
    file_size_bytes: 42 * 1024 * 1024,
    parsed_at: null,
    parse_error: null,
  },
  {
    id: "m2",
    type: "video",
    file_name: "komatsu_meeting.mp4",
    file_size_bytes: 218 * 1024 * 1024,
    parsed_at: "2026-07-18T00:00:00Z",
    parse_error: null,
  },
  {
    id: "m3",
    type: "audio",
    file_name: "team_sync.mp3",
    file_size_bytes: 18 * 1024 * 1024,
    parsed_at: null,
    parse_error: "音声が不明瞭です",
  },
];

describe("S-M01 v2: アップロード履歴", () => {
  it("renders history rows with status pills from GET /meetings", async () => {
    const get = vi.fn(async (path: string) => {
      if (path === "/meetings") return { data: HISTORY };
      return { data: {} };
    });
    render(
      <QueryClientProvider client={createQueryClient()}>
        <MeetingUploadContainer projectId="p1" client={fakeClient({ get })} />
      </QueryClientProvider>,
    );
    expect(await screen.findByText("kickoff_call.m4a")).toBeInTheDocument();
    expect(screen.getByText("解析中")).toBeInTheDocument();
    expect(screen.getByText("完了")).toBeInTheDocument();
    expect(screen.getByText("エラー")).toBeInTheDocument();
    expect(screen.getByText(/42\.0 MB/)).toBeInTheDocument();
  });

  it("opens a completed transcript via transcript-url + fetchText", async () => {
    const get = vi.fn(async (path: string) => {
      if (path === "/meetings") return { data: [HISTORY[1]] };
      if (path === "/meetings/{meeting_id}/transcript-url")
        return { data: { url: "https://signed/m2" } };
      return { data: {} };
    });
    const fetchText = vi.fn(async () => "過去の文字起こし本文");
    render(
      <QueryClientProvider client={createQueryClient()}>
        <MeetingUploadContainer
          projectId="p1"
          client={fakeClient({ get })}
          fetchText={fetchText}
        />
      </QueryClientProvider>,
    );
    fireEvent.click(
      await screen.findByRole("button", { name: "komatsu_meeting.mp4" }),
    );
    expect(await screen.findByText("過去の文字起こし本文")).toBeInTheDocument();
    expect(fetchText).toHaveBeenCalledWith("https://signed/m2");
    // アクション: MD 保存 / スティーブで深掘り
    expect(screen.getByRole("button", { name: "MD 保存" })).toBeInTheDocument();
    expect(
      screen.getByRole("link", { name: "スティーブで深掘り" }),
    ).toHaveAttribute("href", "/chat?project=p1");
  });

  it("deletes a meeting after two-step confirm via DELETE", async () => {
    let deleted = false;
    const get = vi.fn(async (path: string) => {
      if (path === "/meetings") return { data: deleted ? [] : [HISTORY[2]] };
      return { data: {} };
    });
    const del = vi.fn(async () => {
      deleted = true;
      return {};
    });
    render(
      <QueryClientProvider client={createQueryClient()}>
        <MeetingUploadContainer
          projectId="p1"
          client={fakeClient({ get, delete: del })}
        />
      </QueryClientProvider>,
    );
    fireEvent.click(
      await screen.findByRole("button", { name: "team_sync.mp3 を削除" }),
    );
    expect(del).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "team_sync.mp3 を削除" }));
    await screen.findByText("ファイルをアップロードすると、ここに解析状況が表示されます。");
    expect(del).toHaveBeenCalledTimes(1);
  });
});
