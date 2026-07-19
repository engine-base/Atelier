/**
 * S-M01 議事録アップロード コンテナ — T-UC-23 (実 meetings API 配線)
 *
 * 2 段階アップロード + 非同期 transcription を実 API に配線する:
 *   1. POST /meetings/upload-url         → 署名付き URL + storage_path
 *   2. PUT {upload_url} (実ファイル)      → storage へ直接アップロード
 *   3. POST /meetings                    → メタデータ登録 (meeting id)
 *   4. POST /meetings/{id}/transcribe    → Whisper キュー登録 (202)
 *   5. GET  /meetings/{id} を polling     → parsed_at / parse_error まで待つ
 *   6. GET  /meetings/{id}/transcript-url → 署名付き URL を取得し本文を fetch 表示
 *
 * 文字起こし本文は storage 上 (parse_result_path) にあり、署名付き閲覧 URL 経由で取得する。
 * client / uploadFile / fetchText / poll 間隔はテスト用に注入可能。
 */

"use client";

import * as React from "react";
import { useMemo } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { type ApiClient } from "@atelier/api-client";

import { createAuthedApiClient } from "../../../../lib/auth/connector";
import { TranscriptUpload, type MeetingRow } from "./TranscriptUpload";

interface UploadUrlData {
  upload_url: string;
  storage_path: string;
}
interface MeetingData {
  id: string;
}
interface MeetingStatus {
  parsed_at?: string | null;
  parse_error?: string | null;
  parse_result_path?: string | null;
}

interface ApiMeeting {
  id: string;
  type?: string;
  file_name: string;
  file_size_bytes?: number;
  parsed_at?: string | null;
  parse_error?: string | null;
}

function sizeLabel(bytes: number | undefined): string {
  if (!bytes) return "—";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

const POLL_INTERVAL_MS = 2500;
const MAX_POLLS = 48; // 約 2 分

function uploadTypeFor(mime: string): "audio" | "video" | "document" {
  if (mime.startsWith("audio/")) return "audio";
  if (mime.startsWith("video/")) return "video";
  return "document";
}

async function defaultUploadFile(url: string, file: File): Promise<void> {
  const res = await fetch(url, {
    method: "PUT",
    headers: { "Content-Type": file.type || "application/octet-stream" },
    body: file,
  });
  if (!res.ok)
    throw new Error(
      `ファイルのアップロードに失敗しました (HTTP ${res.status})`,
    );
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 署名付き URL から文字起こし本文を取得。JSON なら text/transcript フィールドを優先。 */
async function defaultFetchText(url: string): Promise<string> {
  const res = await fetch(url);
  if (!res.ok)
    throw new Error(`文字起こし結果の取得に失敗しました (HTTP ${res.status})`);
  const raw = await res.text();
  try {
    const parsed = JSON.parse(raw) as { text?: string; transcript?: string };
    return parsed.text ?? parsed.transcript ?? raw;
  } catch {
    return raw;
  }
}

export interface MeetingUploadContainerProps {
  readonly projectId: string;
  readonly client?: ApiClient;
  readonly uploadFile?: (url: string, file: File) => Promise<void>;
  /** 署名付き URL から本文を取得。テスト用に注入可能。 */
  readonly fetchText?: (url: string) => Promise<string>;
  readonly pollIntervalMs?: number;
  readonly maxPolls?: number;
}

export function MeetingUploadContainer({
  projectId,
  client: injected,
  uploadFile = defaultUploadFile,
  fetchText = defaultFetchText,
  pollIntervalMs = POLL_INTERVAL_MS,
  maxPolls = MAX_POLLS,
}: MeetingUploadContainerProps) {
  const client = useMemo(() => injected ?? createAuthedApiClient(), [injected]);
  const queryClient = useQueryClient();
  const listKey = ["meetings", projectId] as const;

  // アップロード履歴 (実 GET /meetings)
  const listQuery = useQuery({
    queryKey: listKey,
    queryFn: async () => {
      const res = await client.get("/meetings", {
        params: { query: { project_id: projectId } },
      });
      const rows = (res as { data?: ApiMeeting[] }).data;
      return Array.isArray(rows) ? rows : [];
    },
    retry: false,
  });

  const deleteMut = useMutation({
    mutationFn: (id: string) =>
      client.delete("/meetings/{meeting_id}", {
        params: { path: { meeting_id: id } },
      }),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: listKey }),
  });

  // 完了済み議事録の文字起こしを開く (署名付き URL → 本文)
  const openMeeting = async (id: string): Promise<string> => {
    let urlRes: unknown;
    try {
      urlRes = await client.get("/meetings/{meeting_id}/transcript-url", {
        params: { path: { meeting_id: id } },
      });
    } catch {
      // storage backend 未設定 (503) 等。原因を握り潰さず明示する。
      throw new Error(
        "文字起こし結果の取得に失敗しました（storage が未設定か、権限がありません）。",
      );
    }
    const signed = (urlRes as { data?: { url: string } }).data;
    if (!signed) throw new Error("文字起こし結果の取得に失敗しました。");
    return fetchText(signed.url);
  };

  const runFlow = async (file: File): Promise<string> => {
    // 1. 署名付きアップロード URL
    const signRes = await client.post("/meetings/upload-url", {
      body: {
        project_id: projectId,
        file_name: file.name,
        mime_type: file.type || "application/octet-stream",
      },
    });
    const sign = (signRes as { data?: UploadUrlData }).data;
    if (!sign) throw new Error("アップロード URL の発行に失敗しました。");

    // 2. 実ファイルを storage へ直接 PUT
    await uploadFile(sign.upload_url, file);

    // 3. メタデータ登録
    const createRes = await client.post("/meetings", {
      body: {
        project_id: projectId,
        type: uploadTypeFor(file.type),
        storage_path: sign.storage_path,
        file_name: file.name,
        file_size_bytes: file.size,
        mime_type: file.type || "application/octet-stream",
      },
    });
    const meeting = (createRes as { data?: MeetingData }).data;
    if (!meeting) throw new Error("議事録の登録に失敗しました。");

    // 4. transcription キュー登録
    await client.post("/meetings/{meeting_id}/transcribe", {
      params: { path: { meeting_id: meeting.id } },
      body: { force: false },
    });

    // 5. 完了までポーリング
    for (let i = 0; i < maxPolls; i += 1) {
      const statusRes = await client.get("/meetings/{meeting_id}", {
        params: { path: { meeting_id: meeting.id } },
      });
      const st = (statusRes as { data?: MeetingStatus }).data ?? {};
      if (st.parse_error)
        throw new Error(`文字起こしに失敗しました: ${st.parse_error}`);
      if (st.parsed_at) {
        // 完了: 署名付き URL を取得して本文を表示する。
        const urlRes = await client.get(
          "/meetings/{meeting_id}/transcript-url",
          {
            params: { path: { meeting_id: meeting.id } },
          },
        );
        const signed = (urlRes as { data?: { url: string } }).data;
        if (!signed)
          return "文字起こしは完了しましたが、結果の取得に失敗しました。";
        return await fetchText(signed.url);
      }
      await sleep(pollIntervalMs);
    }
    throw new Error(
      "文字起こしがタイムアウトしました。時間をおいて再度お試しください。",
    );
  };

  const history: MeetingRow[] = (listQuery.data ?? []).map((m) => ({
    id: m.id,
    fileName: m.file_name,
    sizeLabel: sizeLabel(m.file_size_bytes),
    typeIcon:
      m.type === "audio" ? "audio" : m.type === "video" ? "video" : "document",
    status: m.parse_error ? "error" : m.parsed_at ? "done" : "processing",
    errorText: m.parse_error ?? null,
  }));

  return (
    <TranscriptUpload
      onUpload={async (file) => {
        const text = await runFlow(file);
        void queryClient.invalidateQueries({ queryKey: listKey });
        return text;
      }}
      history={history}
      onOpen={openMeeting}
      onDelete={(id) => deleteMut.mutate(id)}
      chatHref={`/chat?project=${projectId}`}
    />
  );
}
