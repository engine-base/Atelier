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

export interface MeetingRow {
  readonly id: string;
  readonly fileName: string;
  readonly sizeLabel: string;
  readonly typeIcon: "audio" | "video" | "document";
  readonly status: "processing" | "done" | "error";
  readonly errorText?: string | null;
}

export interface TranscriptUploadProps {
  readonly onUpload: (file: File) => Promise<string>;
  /** アップロード履歴 (実 GET /meetings)。未指定なら履歴セクションは空状態のまま。 */
  readonly history?: readonly MeetingRow[];
  /** 完了済み議事録の文字起こしを開く (署名付き URL → 本文)。 */
  readonly onOpen?: (id: string) => Promise<string>;
  /** 議事録の論理削除。 */
  readonly onDelete?: (id: string) => void;
  /** 「スティーブで深掘り」の遷移先 (チャット)。 */
  readonly chatHref?: string;
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

export function TranscriptUpload({
  onUpload,
  history = [],
  onOpen,
  onDelete,
  chatHref,
}: TranscriptUploadProps) {
  const [status, setStatus] = useState<"idle" | "uploading" | "done" | "error">(
    "idle",
  );
  const [transcript, setTranscript] = useState<string>("");
  const [previewName, setPreviewName] = useState<string>("");
  const [error, setError] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);

  const runUpload = async (f: File) => {
    setStatus("uploading");
    setError(null);
    setPreviewName(f.name);
    try {
      const text = await onUpload(f);
      setTranscript(text);
      setStatus("done");
    } catch (err) {
      setError((err as Error).message);
      setStatus("error");
    }
  };

  const onChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    if (!f) return;
    await runUpload(f);
  };

  // 完了済み履歴の文字起こしを開く
  const openMeeting = async (row: MeetingRow) => {
    if (!onOpen) return;
    setStatus("uploading");
    setError(null);
    setPreviewName(row.fileName);
    try {
      const text = await onOpen(row.id);
      setTranscript(text);
      setStatus("done");
    } catch (err) {
      setError((err as Error).message);
      setStatus("error");
    }
  };

  // MD 保存 (クライアント側で transcript を .md ダウンロード)
  const saveMd = () => {
    const blob = new Blob([`# ${previewName || "transcript"}\n\n${transcript}`], {
      type: "text/markdown;charset=utf-8",
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${(previewName || "transcript").replace(/\.[^.]+$/, "")}.md`;
    a.click();
    URL.revokeObjectURL(url);
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
        onDragOver={(e) => {
          e.preventDefault();
          if (status !== "uploading") setDragOver(true);
        }}
        onDragLeave={() => setDragOver(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragOver(false);
          const f = e.dataTransfer.files?.[0];
          if (f && status !== "uploading") void runUpload(f);
        }}
        className={`group block cursor-pointer rounded-lg border-2 border-dashed bg-white px-8 py-12 text-center transition-colors hover:border-primary hover:bg-primary-container aria-disabled:cursor-not-allowed ${
          dragOver ? "border-primary bg-primary-container" : "border-border"
        }`}
        aria-disabled={status === "uploading"}
      >
        <input
          type="file"
          accept="audio/*,video/*,.txt,.md,.docx,text/plain"
          aria-label="音声・動画・テキストファイルを選択"
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

          {status === "idle" && history.length === 0 ? (
            <p className="rounded-lg border border-dashed border-border bg-white px-5 py-12 text-center text-body-sm text-on-surface-variant">
              ファイルをアップロードすると、ここに解析状況が表示されます。
            </p>
          ) : status === "idle" ? null : (
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

          {/* アップロード履歴 (実 GET /meetings) */}
          {history.length > 0 ? (
            <ul aria-label="アップロード履歴" className="flex flex-col gap-2.5">
              {history.map((row) => (
                <li
                  key={row.id}
                  className="grid grid-cols-[36px_1fr_auto] items-center gap-3 rounded-lg border border-border bg-white px-5 py-4"
                >
                  <span
                    className={`flex h-9 w-9 items-center justify-center rounded-md ${
                      row.typeIcon === "audio"
                        ? "bg-primary-container text-primary-container-fg"
                        : row.typeIcon === "video"
                          ? "bg-secondary-container text-secondary-container-fg"
                          : "bg-tertiary-container text-tertiary-container-fg"
                    }`}
                  >
                    {row.typeIcon === "document" ? (
                      <FileTextIcon className="h-4 w-4" />
                    ) : (
                      <UploadIcon className="h-4 w-4" />
                    )}
                  </span>
                  <div className="min-w-0">
                    {row.status === "done" && onOpen ? (
                      <button
                        type="button"
                        onClick={() => void openMeeting(row)}
                        className="block max-w-full truncate text-left text-[13px] font-bold text-on-surface hover:text-primary"
                      >
                        {row.fileName}
                      </button>
                    ) : (
                      <div className="truncate text-[13px] font-bold text-on-surface">
                        {row.fileName}
                      </div>
                    )}
                    <div className="text-[11.5px] tabular-nums text-on-surface-variant">
                      {row.sizeLabel}
                      {row.status === "error" && row.errorText
                        ? ` · ${row.errorText}`
                        : ""}
                    </div>
                  </div>
                  <div className="flex items-center gap-1.5">
                    {row.status === "processing" ? (
                      <StatusPill tone="bg-primary-container text-primary-container-fg">
                        解析中
                      </StatusPill>
                    ) : row.status === "done" ? (
                      <StatusPill tone="bg-tertiary-container text-tertiary-container-fg">
                        完了
                      </StatusPill>
                    ) : (
                      <StatusPill tone="bg-error/10 text-error">エラー</StatusPill>
                    )}
                    {onDelete ? (
                      confirmDeleteId === row.id ? (
                        <span className="inline-flex items-center gap-1">
                          <button
                            type="button"
                            onClick={() => {
                              onDelete(row.id);
                              setConfirmDeleteId(null);
                            }}
                            aria-label={`${row.fileName} を削除`}
                            className="inline-flex h-7 items-center rounded-md bg-error px-2 text-[11px] font-semibold text-on-error hover:opacity-90"
                          >
                            削除
                          </button>
                          <button
                            type="button"
                            onClick={() => setConfirmDeleteId(null)}
                            className="inline-flex h-7 items-center rounded-md px-1.5 text-[11px] font-semibold text-on-surface hover:bg-surface-variant"
                          >
                            取消
                          </button>
                        </span>
                      ) : (
                        <button
                          type="button"
                          onClick={() => setConfirmDeleteId(row.id)}
                          aria-label={`${row.fileName} を削除`}
                          className="inline-flex h-7 w-7 items-center justify-center rounded-md text-on-surface-variant hover:bg-surface-variant hover:text-error"
                        >
                          ×
                        </button>
                      )
                    ) : null}
                  </div>
                </li>
              ))}
            </ul>
          ) : null}
        </section>

        {/* 右: 解析結果プレビュー */}
        <section className="flex flex-col gap-3">
          <div className="flex items-center justify-between">
            <h2 className="text-base font-bold text-on-surface">
              解析結果プレビュー
            </h2>
            {status === "done" ? (
              <span className="inline-flex max-w-[220px] items-center truncate rounded-sm bg-tertiary-container px-2 py-0.5 text-[10.5px] font-semibold text-tertiary-container-fg">
                {previewName || "Whisper 生成"}
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
                {/* アクション: 深掘り (チャット遷移) / MD 保存 (client 側 DL)。
                    サマリー/話者分離/要件抽出はモックにあるが解析 API 不在 (GAP-015)。 */}
                <div className="flex flex-wrap gap-2 border-t border-border pt-4">
                  {chatHref ? (
                    <a
                      href={chatHref}
                      className="inline-flex items-center gap-1.5 rounded-md bg-primary px-4 py-2 text-sm font-semibold text-on-primary hover:bg-[#1E54D8]"
                    >
                      スティーブで深掘り
                    </a>
                  ) : null}
                  <button
                    type="button"
                    onClick={saveMd}
                    className="inline-flex items-center gap-1.5 rounded-md border border-border px-4 py-2 text-sm font-semibold text-on-surface hover:border-primary"
                  >
                    MD 保存
                  </button>
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
