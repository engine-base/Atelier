/**
 * S-M01 議事録アップロード + transcript — T-UC-23
 *
 * ファイル選択 → アップロード進捗表示 → transcript 表示。
 * presentational（onUpload を受ける）。実 API 配線（2段階アップロード + 非同期
 * transcription polling）は MeetingUploadContainer が担う。
 */

"use client";

import * as React from "react";
import { useState } from "react";

export interface TranscriptUploadProps {
  readonly onUpload: (file: File) => Promise<string>;
}

export function TranscriptUpload({ onUpload }: TranscriptUploadProps) {
  const [status, setStatus] = useState<"idle" | "uploading" | "done" | "error">(
    "idle",
  );
  const [transcript, setTranscript] = useState<string>("");
  const [error, setError] = useState<string | null>(null);

  const onChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    if (!f) return;
    setStatus("uploading");
    setError(null);
    try {
      const text = await onUpload(f);
      setTranscript(text);
      setStatus("done");
    } catch (err) {
      setError((err as Error).message);
      setStatus("error");
    }
  };

  return (
    <section aria-label="議事録アップロード" className="flex flex-col gap-md">
      <h1 className="text-headline-md font-bold text-on-surface">
        議事録アップロード
      </h1>
      <label className="flex flex-col gap-sm">
        <span className="text-label-lg font-semibold text-on-surface">
          音声 / 動画ファイル
        </span>
        <input
          type="file"
          accept="audio/*,video/*"
          onChange={onChange}
          disabled={status === "uploading"}
          className="rounded-md border border-surface-variant bg-surface px-sm py-xs"
        />
      </label>
      {status === "uploading" ? (
        <p
          role="status"
          aria-live="polite"
          className="text-label-md text-on-surface-variant"
        >
          アップロード中…
        </p>
      ) : null}
      {status === "error" && error ? (
        <p role="alert" className="text-label-md text-error">
          {error}
        </p>
      ) : null}
      {status === "done" ? (
        <article aria-label="文字起こし結果">
          <h2 className="text-label-lg font-semibold text-on-surface">
            文字起こし
          </h2>
          <pre className="whitespace-pre-wrap rounded-md bg-surface-variant/30 p-md text-body-sm text-on-surface">
            {transcript}
          </pre>
        </article>
      ) : null}
    </section>
  );
}
