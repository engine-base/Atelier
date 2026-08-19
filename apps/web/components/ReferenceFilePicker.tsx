/**
 * GAP-161 — スタジオに「参考資料」を渡すためのファイルピッカー。
 *
 * 経営者指摘「デザインモックも、このテンプレもだけど画像や PDF やファイルや
 * エクセルをアップロードしてそれを参考にすることができていない」。
 *
 * 署名付き URL へ実 PUT してから storage_path を親へ渡す (チャット添付と同方式)。
 * アップロード失敗時は「参考資料つきのつもりで送る」ことをさせない。
 */

"use client";

import * as React from "react";
import { useRef, useState } from "react";
import { Paperclip, X } from "lucide-react";

import type { ApiClient } from "@atelier/api-client";

import { cn } from "../lib/cn";

export interface ReferenceFileRef {
  readonly storage_path: string;
  readonly file_name: string;
  readonly mime_type: string;
}

const ALLOWED = new Set([
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif",
  "application/pdf",
  "text/plain",
  "text/markdown",
  "text/csv",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.ms-excel",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation",
]);
const MAX_BYTES = 10 * 1024 * 1024;
const MAX_FILES = 5;

export interface ReferenceFilePickerProps {
  readonly client: ApiClient;
  readonly files: readonly ReferenceFileRef[];
  readonly onChange: (files: readonly ReferenceFileRef[]) => void;
  readonly disabled?: boolean;
  readonly className?: string;
}

export function ReferenceFilePicker({
  client,
  files,
  onChange,
  disabled = false,
  className,
}: ReferenceFilePickerProps) {
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const upload = async (picked: File[]): Promise<void> => {
    setError(null);
    if (files.length + picked.length > MAX_FILES) {
      setError(`参考資料は ${MAX_FILES} 件までです。`);
      return;
    }
    const added: ReferenceFileRef[] = [];
    setBusy(true);
    try {
      for (const f of picked) {
        if (!ALLOWED.has(f.type)) {
          setError(`この形式は参考資料に使えません: ${f.name}`);
          return;
        }
        if (f.size > MAX_BYTES) {
          setError(`1 ファイル 10MB 以下にしてください: ${f.name}`);
          return;
        }
        const res = await client.post("/reference-uploads", {
          body: { file_name: f.name, mime_type: f.type, file_size_bytes: f.size },
        });
        const data = (res as { data?: { upload_url: string; storage_path: string } }).data;
        if (!data) {
          setError("アップロード URL を取得できませんでした。");
          return;
        }
        const put = await fetch(data.upload_url, {
          method: "PUT",
          body: f,
          headers: { "Content-Type": f.type },
        });
        if (!put.ok) {
          setError("アップロードに失敗しました。時間をおいて再度お試しください。");
          return;
        }
        added.push({
          storage_path: data.storage_path,
          file_name: f.name,
          mime_type: f.type,
        });
      }
      onChange([...files, ...added]);
    } catch {
      setError("アップロードに失敗しました。時間をおいて再度お試しください。");
    } finally {
      setBusy(false);
      if (inputRef.current) inputRef.current.value = "";
    }
  };

  return (
    <div className={cn("flex flex-col gap-1", className)}>
      <div className="flex flex-wrap items-center gap-1.5">
        <button
          type="button"
          disabled={disabled || busy}
          onClick={() => inputRef.current?.click()}
          className="inline-flex items-center gap-1 rounded-md border border-border px-2 py-1 text-[11.5px] font-semibold text-on-surface-variant hover:bg-surface-variant hover:text-on-surface disabled:opacity-50"
        >
          <Paperclip className="h-3 w-3" aria-hidden="true" />
          {busy ? "アップロード中…" : "参考資料を追加"}
        </button>
        {files.map((f) => (
          <span
            key={f.storage_path}
            className="inline-flex max-w-[180px] items-center gap-1 rounded-full bg-surface-variant px-2 py-0.5 text-[11px] text-on-surface"
          >
            <span className="truncate">{f.file_name}</span>
            <button
              type="button"
              aria-label={`${f.file_name} を外す`}
              disabled={disabled || busy}
              onClick={() => onChange(files.filter((x) => x.storage_path !== f.storage_path))}
              className="shrink-0 text-on-surface-variant hover:text-error"
            >
              <X className="h-3 w-3" aria-hidden="true" />
            </button>
          </span>
        ))}
      </div>
      <input
        ref={inputRef}
        type="file"
        multiple
        aria-label="参考資料ファイル"
        className="hidden"
        onChange={(e) => {
          const picked = Array.from(e.target.files ?? []);
          if (picked.length > 0) void upload(picked);
        }}
      />
      {error ? (
        <p role="alert" className="text-[11px] text-error">
          {error}
        </p>
      ) : null}
    </div>
  );
}
