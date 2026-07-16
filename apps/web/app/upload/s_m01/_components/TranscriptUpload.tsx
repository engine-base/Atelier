/**
 * S-M01 議事録アップロード + transcript — T-UC-23 / F-VIS モック忠実再構築
 *
 * ファイル選択 → アップロード進捗表示 → transcript 表示。
 * presentational（onUpload を受ける）。実 API 配線（2段階アップロード + 非同期
 * transcription polling）は MeetingUploadContainer が担う。
 *
 * 見た目は 06_mockups/upload/S-M01-meeting.html に忠実:
 *   page-header → dropzone(+formats+notice) → 2 カラム(アップロード状況 / 解析結果プレビュー)。
 * モックのダミー履歴・話者・抽出要件は使わず、実 state(status/transcript/error) に束ねる。
 */

"use client";

import * as React from "react";
import { useState } from "react";

export interface TranscriptUploadProps {
  readonly onUpload: (file: File) => Promise<string>;
}

const ACCEPTED_FORMATS = [
  ".mp3",
  ".m4a",
  ".wav",
  ".mp4",
  ".txt",
  ".docx",
  "Zoom / Meet 議事録",
] as const;

function UploadIcon({ className }: { readonly className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
      <polyline points="17 8 12 3 7 8" />
      <line x1="12" y1="3" x2="12" y2="15" />
    </svg>
  );
}

function FileTextIcon({ className }: { readonly className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
      <polyline points="14 2 14 8 20 8" />
      <line x1="16" y1="13" x2="8" y2="13" />
      <line x1="16" y1="17" x2="8" y2="17" />
      <line x1="10" y1="9" x2="8" y2="9" />
    </svg>
  );
}

/** 現在ジョブの状態ドット付き pill。 */
function StatusPill({
  tone,
  children,
}: {
  readonly tone: string;
  readonly children: React.ReactNode;
}) {
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[11px] font-semibold ${tone}`}
    >
      <span
        aria-hidden="true"
        className="h-1.5 w-1.5 rounded-full bg-current"
      />
      {children}
    </span>
  );
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
    <section aria-label="議事録アップロード" className="flex flex-col gap-6">
      {/* page-header */}
      <header className="flex flex-col gap-1.5">
        <p className="text-[11px] font-bold uppercase tracking-[0.14em] text-on-surface-variant">
          Meeting Ingestion
        </p>
        <h1 className="text-3xl font-bold tracking-tight text-on-surface">
          議事録 / 商談アップロード
        </h1>
        <p className="text-body-md text-on-surface-variant">
          音声・動画・テキストをアップロードすると Whisper +
          ナターシャが構造化し、要件抽出を提案します。
        </p>
      </header>

      {/* dropzone (ラベルがネイティブに file input を開く) */}
      <label
        className="group block cursor-pointer rounded-lg border-2 border-dashed border-border bg-white px-8 py-12 text-center transition-colors hover:border-primary hover:bg-primary-container aria-disabled:cursor-not-allowed"
        aria-disabled={status === "uploading"}
      >
        <input
          type="file"
          accept="audio/*,video/*"
          aria-label="音声・動画ファイルを選択"
          onChange={onChange}
          disabled={status === "uploading"}
          className="sr-only"
        />
        <span className="mx-auto mb-3 flex h-14 w-14 items-center justify-center rounded-full bg-primary-container text-on-primary-container">
          <UploadIcon className="h-6 w-6" />
        </span>
        <span className="mb-2 block text-xl font-bold text-on-surface">
          ここにファイルをドロップ
        </span>
        <span className="mb-3 block text-body-md text-on-surface-variant">
          または{" "}
          <span className="font-semibold text-primary group-hover:underline">
            クリックして選択
          </span>
        </span>
        <span className="flex flex-wrap justify-center gap-2">
          {ACCEPTED_FORMATS.map((f) => (
            <span
              key={f}
              className="rounded-sm bg-surface-variant px-2.5 py-1 text-[11px] font-semibold text-on-surface-variant"
            >
              {f}
            </span>
          ))}
        </span>
        <span className="mt-3 block text-body-sm text-on-surface-variant">
          最大 500MB · 解析は Whisper API（クラウド）経由
        </span>
      </label>

      {/* 2 カラム: アップロード状況 / 解析結果プレビュー */}
      <div className="grid gap-5 lg:grid-cols-[1fr_1.2fr]">
        {/* 左: アップロード状況 */}
        <section className="flex flex-col gap-2.5">
          <h2 className="mb-1 text-base font-bold text-on-surface">
            アップロード状況
          </h2>

          {status === "idle" ? (
            <p className="rounded-lg border border-dashed border-border bg-white px-5 py-12 text-center text-body-sm text-on-surface-variant">
              ファイルをアップロードすると、ここに解析状況が表示されます。
            </p>
          ) : (
            <div className="grid grid-cols-[36px_1fr_auto] items-center gap-3 rounded-lg border border-border bg-white px-5 py-4">
              <div
                className={`flex h-9 w-9 items-center justify-center rounded-md ${
                  status === "error"
                    ? "bg-error/10 text-error"
                    : "bg-primary-container text-on-primary-container"
                }`}
              >
                {status === "done" ? (
                  <FileTextIcon className="h-4 w-4" />
                ) : (
                  <UploadIcon className="h-4 w-4" />
                )}
              </div>

              <div className="min-w-0">
                <div className="truncate text-[13px] font-bold text-on-surface">
                  {status === "uploading"
                    ? "音声・動画を解析中"
                    : status === "done"
                      ? "解析が完了しました"
                      : "解析に失敗しました"}
                </div>
                {status === "uploading" ? (
                  <div
                    role="status"
                    aria-live="polite"
                    className="text-[11.5px] text-on-surface-variant"
                  >
                    Whisper で文字起こししています…
                  </div>
                ) : status === "done" ? (
                  <div className="text-[11.5px] text-on-surface-variant">
                    文字起こしを右側のプレビューに表示しました。
                  </div>
                ) : (
                  <div
                    role="alert"
                    className="text-[11.5px] text-error"
                  >
                    {error}
                  </div>
                )}
              </div>

              {status === "uploading" ? (
                <div
                  className="h-1 w-[120px] overflow-hidden rounded-full bg-surface-variant"
                  aria-hidden="true"
                >
                  <div className="h-full w-1/2 animate-pulse rounded-full bg-primary" />
                </div>
              ) : status === "done" ? (
                <StatusPill tone="bg-tertiary-container text-tertiary-container-fg">
                  完了
                </StatusPill>
              ) : (
                <StatusPill tone="bg-error/10 text-error">エラー</StatusPill>
              )}
            </div>
          )}
        </section>

        {/* 右: 解析結果プレビュー */}
        <section className="flex flex-col gap-3">
          <div className="flex items-center justify-between">
            <h2 className="text-base font-bold text-on-surface">
              解析結果プレビュー
            </h2>
            {status === "done" ? (
              <span className="inline-flex items-center rounded-sm bg-tertiary-container px-2 py-0.5 text-[10.5px] font-semibold text-tertiary-container-fg">
                Whisper 生成
              </span>
            ) : null}
          </div>

          <div className="rounded-lg border border-border bg-white p-6">
            {status === "done" ? (
              <article aria-label="文字起こし結果" className="flex flex-col">
                <div className="py-3.5">
                  <div className="mb-1.5 text-[11px] font-bold uppercase tracking-[0.1em] text-on-surface-variant">
                    文字起こし（Whisper 生成）
                  </div>
                  <h3 className="sr-only">文字起こし</h3>
                  <pre className="max-h-[420px] overflow-auto whitespace-pre-wrap rounded-md bg-surface-variant/40 p-4 text-body-sm leading-relaxed text-on-surface">
                    {transcript}
                  </pre>
                </div>
              </article>
            ) : status === "error" ? (
              <p className="py-8 text-center text-body-sm text-error">
                解析に失敗したため、結果を表示できません。
              </p>
            ) : (
              <p className="py-8 text-center text-body-sm text-on-surface-variant">
                {status === "uploading"
                  ? "解析中です。完了すると文字起こし結果がここに表示されます。"
                  : "解析が完了すると、文字起こし結果がここに表示されます。"}
              </p>
            )}
          </div>
        </section>
      </div>
    </section>
  );
}
