/**
 * GAP-156 — 既存資料の一括取り込みコンテナ。
 *
 * 1. ファイル選択 (複数) → base64 で POST /projects/{id}/import
 * 2. per-file の取り込み結果 (モック/成果物/ファイル or honest エラー) を表示
 * 3. 取り込めた種類から「完了済みでは？」の工程を提案 — チェックして
 *    「フローに反映」でユーザー確定 (既存 flow complete API を工程ごとに叩く)
 */

"use client";

import * as React from "react";
import { useMemo, useState } from "react";
import Link from "next/link";
import { useMutation } from "@tanstack/react-query";

import { type ApiClient } from "@atelier/api-client";

import { createAuthedApiClient } from "../../../lib/auth/connector";
import { cn } from "../../../lib/cn";

interface ImportItemResult {
  file_name: string;
  type?: string | null;
  title?: string | null;
  stage?: string | null;
  version?: number | null;
  error?: string | null;
}

interface ImportResult {
  results: ImportItemResult[];
  imported: number;
  failed: number;
  suggested_stage_keys: string[];
}

const STAGE_LABELS: Record<string, string> = {
  hearing: "商談・ヒアリング",
  proposal: "提案",
  estimate: "見積",
  contract: "契約",
  requirements: "要件定義",
  architecture: "アーキ設計",
  design: "デザイン・モック",
  implementation: "タスク分解・実装",
  verification: "検証",
  delivery: "納品・請求",
};

const TYPE_LABELS: Record<string, string> = {
  mock: "画面モック",
  output: "成果物",
  file: "ファイル成果物",
};

async function fileToB64(file: File): Promise<string> {
  try {
    const buf = await file.arrayBuffer();
    const bytes = new Uint8Array(buf);
    let bin = "";
    const CHUNK = 0x8000;
    for (let i = 0; i < bytes.length; i += CHUNK) {
      bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
    }
    return btoa(bin);
  } catch {
    // 一部環境 (テスト jsdom 等) は Blob.arrayBuffer 未実装 — FileReader で代替
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result).split(",")[1] ?? "");
      reader.onerror = () => reject(reader.error);
      reader.readAsDataURL(file);
    });
  }
}

export interface ImportContainerProps {
  readonly projectId: string;
  readonly client?: ApiClient;
}

export function ImportContainer({ projectId, client: injected }: ImportContainerProps) {
  const client = useMemo(() => injected ?? createAuthedApiClient(), [injected]);
  const [picked, setPicked] = useState<File[]>([]);
  const [result, setResult] = useState<ImportResult | null>(null);
  const [checked, setChecked] = useState<Set<string>>(new Set());
  const [applied, setApplied] = useState<string[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const run = useMutation({
    retry: false,
    mutationFn: async () => {
      const files = await Promise.all(
        picked.map(async (f) => ({
          file_name: f.name,
          content_b64: await fileToB64(f),
        })),
      );
      const res = await client.post("/projects/{project_id}/import", {
        params: { path: { project_id: projectId } },
        body: { files },
      });
      return (res as { data?: ImportResult }).data ?? null;
    },
    onSuccess: (d) => {
      if (!d) {
        setError("取り込みに失敗しました。");
        return;
      }
      setResult(d);
      setChecked(new Set(d.suggested_stage_keys));
      setApplied(null);
      setError(null);
    },
    onError: () => setError("取り込みに失敗しました。時間をおいて再度お試しください。"),
  });

  const apply = useMutation({
    retry: false,
    mutationFn: async () => {
      const keys = [...checked];
      for (const key of keys) {
        // ユーザーが明示チェックした確定操作 — hard gate (契約/納品) も confirm 扱い
        await client.post("/projects/{project_id}/flow/{stage_key}/complete", {
          params: { path: { project_id: projectId, stage_key: key } },
          body: { confirm: true },
        });
      }
      return keys;
    },
    onSuccess: (keys) => {
      setApplied(keys);
      setError(null);
    },
    onError: () => setError("フローへの反映に失敗しました。進行タブで個別に完了してください。"),
  });

  return (
    <section aria-label="既存資料の取り込み">
      <h1 className="text-headline-md font-bold tracking-tight text-on-surface">
        既存資料の取り込み
      </h1>
      <p className="mt-1 text-body-sm text-on-surface-variant">
        進行中の既存プロジェクトを<strong>途中から</strong>ツールに載せます。
        HTML はモック / 見積書・提案書等の成果物へ自動仕分け、Markdown・テキストは
        成果物として閲覧可能に、画像・PPTX・PDF・Excel 等はファイル成果物として
        取り込みます。取り込めた資料から「もう終わっている工程」を提案するので、
        確認してフローの現在地を合わせてください。
      </p>

      <div className="mt-md rounded-lg border border-dashed border-border bg-surface p-md">
        <input
          type="file"
          multiple
          aria-label="取り込むファイルを選択"
          onChange={(e) => setPicked([...(e.target.files ?? [])])}
          className="block w-full text-[13px] text-on-surface file:mr-3 file:rounded-md file:border-0 file:bg-primary file:px-4 file:py-1.5 file:text-[12.5px] file:font-semibold file:text-on-primary"
        />
        {picked.length > 0 ? (
          <p className="mt-2 text-[12px] text-on-surface-variant">
            {picked.length} 件選択中（最大 30 件・HTML/MD/TXT/画像/PPTX/PDF/Excel/動画）
          </p>
        ) : null}
        <div className="mt-2 flex justify-end">
          <button
            type="button"
            disabled={picked.length === 0 || run.isPending}
            onClick={() => run.mutate()}
            className="rounded-md bg-primary px-4 py-1.5 text-[12.5px] font-semibold text-on-primary hover:bg-primary-hover disabled:opacity-50"
          >
            {run.isPending ? "取り込み中…" : "取り込む"}
          </button>
        </div>
      </div>

      {error ? (
        <p role="alert" className="mt-2 rounded-md bg-error/10 px-sm py-1.5 text-[12.5px] text-error">
          {error}
        </p>
      ) : null}

      {result ? (
        <div className="mt-md">
          <h2 className="text-title-md font-bold text-on-surface">
            取り込み結果（成功 {result.imported} / 失敗 {result.failed}）
          </h2>
          <ul role="list" className="mt-2 flex flex-col gap-1">
            {result.results.map((r) => (
              <li
                key={r.file_name}
                className={cn(
                  "flex flex-wrap items-center gap-2 rounded-md px-3 py-2 text-[12.5px]",
                  r.error ? "bg-error/10 text-error" : "bg-surface-variant/40 text-on-surface",
                )}
              >
                <span className="font-semibold">{r.file_name}</span>
                {r.error ? (
                  <span>→ {r.error}</span>
                ) : (
                  <>
                    <span className="rounded-sm bg-secondary-container px-1.5 py-0.5 text-[10.5px] font-semibold text-secondary-container-fg">
                      {TYPE_LABELS[r.type ?? ""] ?? r.type}
                    </span>
                    <span>
                      → 「{r.title}」 v{r.version}
                      {r.stage && r.type !== "mock"
                        ? `（${STAGE_LABELS[r.stage] ?? r.stage}）`
                        : ""}
                    </span>
                  </>
                )}
              </li>
            ))}
          </ul>

          {result.suggested_stage_keys.length > 0 && applied === null ? (
            <div className="mt-md rounded-lg border border-border bg-surface p-md">
              <h3 className="text-[14px] font-bold text-on-surface">
                フローの現在地を合わせる
              </h3>
              <p className="mt-0.5 text-[12px] text-on-surface-variant">
                取り込めた資料から、次の工程はすでに完了済みと推定されます。
                チェックした工程を完了として反映します（あなたの確定操作 —
                自動では反映しません）。
              </p>
              <div className="mt-2 flex flex-wrap gap-2">
                {result.suggested_stage_keys.map((key) => (
                  <label
                    key={key}
                    className="flex items-center gap-1.5 rounded-md border border-border px-2.5 py-1 text-[12.5px] text-on-surface"
                  >
                    <input
                      type="checkbox"
                      checked={checked.has(key)}
                      onChange={(e) => {
                        const next = new Set(checked);
                        if (e.target.checked) next.add(key);
                        else next.delete(key);
                        setChecked(next);
                      }}
                    />
                    {STAGE_LABELS[key] ?? key}
                  </label>
                ))}
              </div>
              <div className="mt-2 flex justify-end">
                <button
                  type="button"
                  disabled={checked.size === 0 || apply.isPending}
                  onClick={() => apply.mutate()}
                  className="rounded-md bg-primary px-4 py-1.5 text-[12.5px] font-semibold text-on-primary hover:bg-primary-hover disabled:opacity-50"
                >
                  {apply.isPending
                    ? "反映中…"
                    : `${checked.size} 工程を完了として反映`}
                </button>
              </div>
            </div>
          ) : null}

          {applied !== null ? (
            <p
              role="status"
              className="mt-2 rounded-md bg-tertiary-container px-sm py-2 text-[12.5px] text-tertiary-container-fg"
            >
              {applied.length} 工程を完了として反映しました。{" "}
              <Link
                href={`/chat?project=${projectId}`}
                className="font-semibold underline"
              >
                進行タブで現在地を確認 →
              </Link>
            </p>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
