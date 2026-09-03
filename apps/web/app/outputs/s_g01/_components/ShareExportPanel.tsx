/**
 * GAP-162 — 成果物をクライアントに渡す (共有リンク + 書き出し)。
 *
 * 経営者質問:
 *   「PDF や資料、エクセル、html など様々で出せる感じだよね？？」
 *   「これをこのままリンクとして資料を渡せる状態にもなっている？？」
 *
 * - 共有リンク: 期限つきで発行 → URL は**発行直後だけ**表示 (サーバーはハッシュしか
 *   持たないため後から再表示できない) → いつでも失効。
 * - 書き出し: HTML / Excel はサーバーが生成。PDF は共有ページを開いて印刷
 *   (A4 前提のデザインテンプレをそのまま PDF にできる)。
 */

"use client";

import * as React from "react";
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Copy, Link2, Trash2 } from "lucide-react";

import { ApiError, type ApiClient } from "@atelier/api-client";

import { readAccessToken } from "../../../../lib/auth/connector";
import { cn } from "../../../../lib/cn";

export interface ShareLinkItem {
  readonly id: string;
  readonly label: string;
  readonly expires_at: string;
  readonly revoked_at?: string | null;
  readonly view_count: number;
  readonly last_viewed_at?: string | null;
  readonly share_url?: string | null;
}

export interface ShareExportPanelProps {
  readonly outputId: string;
  readonly client: ApiClient;
  /** 書き出しの実 URL 組み立て (テストで差し替え可能)。 */
  readonly exportUrlOf?: (outputId: string, format: "html" | "xlsx") => string;
  /** GAP-300: 認証付き取得 (テスト注入用。既定は cookie の JWT を Authorization に付けて fetch)。 */
  readonly fetchExport?: (url: string) => Promise<Blob>;
  readonly apiBase?: string;
}

function dateLabel(iso: string | null | undefined): string {
  return iso ? iso.slice(0, 16).replace("T", " ") : "";
}

async function defaultFetchExport(url: string): Promise<Blob> {
  const token = readAccessToken();
  const res = await fetch(url, {
    method: "GET",
    credentials: "include",
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });
  if (!res.ok) {
    throw new ApiError({
      status: res.status,
      statusText: res.statusText,
      payload: undefined,
      path: url,
      method: "get",
    });
  }
  return await res.blob();
}

export function ShareExportPanel({
  outputId,
  client,
  exportUrlOf,
  fetchExport,
  apiBase = process.env.NEXT_PUBLIC_API_URL ?? "",
}: ShareExportPanelProps) {
  const queryClient = useQueryClient();
  const KEY = ["share-links", outputId] as const;
  const [issued, setIssued] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ kind: "ok" | "error"; text: string } | null>(null);
  const [days, setDays] = useState(14);

  const links = useQuery({
    queryKey: KEY,
    queryFn: async () => {
      const res = await client.get("/outputs/{output_id}/share-links", {
        params: { path: { output_id: outputId } },
      });
      const d = (res as { data?: unknown }).data;
      return Array.isArray(d) ? (d as ShareLinkItem[]) : [];
    },
    retry: false,
  });

  const create = useMutation({
    retry: false,
    mutationFn: async () => {
      const res = await client.post("/outputs/{output_id}/share-links", {
        params: { path: { output_id: outputId } },
        body: { label: "", expires_days: days },
      });
      return (res as { data?: ShareLinkItem }).data ?? null;
    },
    onSuccess: (created) => {
      void queryClient.invalidateQueries({ queryKey: KEY });
      setIssued(created?.share_url ?? null);
      setNotice({
        kind: "ok",
        text: "共有リンクを発行しました。この URL はこの場でしか表示されません。",
      });
    },
    onError: () =>
      setNotice({ kind: "error", text: "共有リンクを発行できませんでした。" }),
  });

  const revoke = useMutation({
    retry: false,
    mutationFn: (linkId: string) =>
      client.post("/share-links/{link_id}/revoke", {
        params: { path: { link_id: linkId } },
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: KEY });
      setNotice({ kind: "ok", text: "共有リンクを無効化しました。" });
    },
    onError: (e) =>
      setNotice({
        kind: "error",
        text:
          e instanceof ApiError && e.status === 404
            ? "このリンクはすでに無効です。"
            : "無効化に失敗しました。",
      }),
  });

  const exportUrl = (format: "html" | "xlsx"): string =>
    exportUrlOf?.(outputId, format) ??
    `${apiBase}/outputs/${outputId}/export?format=${format}`;
  const [exporting, setExporting] = useState<"html" | "xlsx" | null>(null);
  // GAP-300 (通し J46-16): 素の <a href> は Authorization が付かず API が 404 を返していた。
  // 認証付きで取得してファイルとして保存する (通し J46-16 の期待 = 押すと保存される)。
  const downloadExport = async (format: "html" | "xlsx"): Promise<void> => {
    setExporting(format);
    setNotice(null);
    try {
      const blob = await (fetchExport ?? defaultFetchExport)(exportUrl(format));
      const objectUrl = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = objectUrl;
      a.download = `output-${outputId}.${format}`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(objectUrl);
    } catch (e) {
      setNotice({
        kind: "error",
        text:
          e instanceof ApiError && e.status === 409
            ? "この形式はまだ作成されていません。"
            : "書き出しに失敗しました。時間をおいてもう一度お試しください。",
      });
    } finally {
      setExporting(null);
    }
  };

  const active = (links.data ?? []).filter((l) => !l.revoked_at);

  return (
    <section aria-label="共有と書き出し" className="border-t border-border px-lg py-3">
      <h3 className="text-[12px] font-bold text-on-surface">クライアントに渡す</h3>

      <div className="mt-2 flex flex-wrap items-center gap-2">
        <label className="flex items-center gap-1 text-[11.5px] text-on-surface-variant">
          期限
          <select
            value={days}
            onChange={(e) => setDays(Number(e.target.value))}
            className="rounded-md border border-border bg-surface px-1.5 py-0.5 text-[11.5px]"
          >
            <option value={7}>7 日</option>
            <option value={14}>14 日</option>
            <option value={30}>30 日</option>
            <option value={90}>90 日</option>
          </select>
        </label>
        <button
          type="button"
          disabled={create.isPending}
          onClick={() => {
            setNotice(null);
            setIssued(null);
            create.mutate();
          }}
          className="inline-flex items-center gap-1 rounded-md bg-primary px-3 py-1.5 text-[12px] font-semibold text-on-primary hover:bg-primary-hover disabled:opacity-50"
        >
          <Link2 className="h-3.5 w-3.5" aria-hidden="true" />
          {create.isPending ? "発行中…" : "共有リンクを発行"}
        </button>
        <button
          type="button"
          disabled={exporting !== null}
          onClick={() => void downloadExport("html")}
          className="rounded-md border border-border px-3 py-1.5 text-[12px] font-semibold text-on-surface-variant hover:bg-surface-variant hover:text-on-surface disabled:opacity-50"
        >
          {exporting === "html" ? "HTML を作成中…" : "HTML で保存"}
        </button>
        <button
          type="button"
          disabled={exporting !== null}
          onClick={() => void downloadExport("xlsx")}
          className="rounded-md border border-border px-3 py-1.5 text-[12px] font-semibold text-on-surface-variant hover:bg-surface-variant hover:text-on-surface disabled:opacity-50"
        >
          {exporting === "xlsx" ? "Excel を作成中…" : "Excel で保存"}
        </button>
        <span className="text-[11px] text-on-surface-variant">
          PDF は共有リンクを開いて「PDF で保存 / 印刷」から
        </span>
      </div>

      {issued ? (
        <div className="mt-2 flex items-center gap-2 rounded-md border border-tertiary bg-tertiary-container/40 px-2.5 py-2">
          <code className="min-w-0 flex-1 truncate text-[11.5px]">{issued}</code>
          <button
            type="button"
            onClick={() => {
              void navigator.clipboard?.writeText(issued);
              setNotice({ kind: "ok", text: "URL をコピーしました。" });
            }}
            className="inline-flex shrink-0 items-center gap-1 rounded-md bg-white px-2 py-1 text-[11px] font-semibold text-on-surface"
          >
            <Copy className="h-3 w-3" aria-hidden="true" />
            コピー
          </button>
        </div>
      ) : null}

      {notice ? (
        <p
          role={notice.kind === "error" ? "alert" : "status"}
          className={cn(
            "mt-2 rounded-md px-2.5 py-1.5 text-[11.5px]",
            notice.kind === "error"
              ? "bg-error/10 text-error"
              : "bg-tertiary-container text-tertiary-container-fg",
          )}
        >
          {notice.text}
        </p>
      ) : null}

      {active.length > 0 ? (
        <ul role="list" aria-label="有効な共有リンク" className="mt-2 flex flex-col gap-1">
          {active.map((l) => (
            <li
              key={l.id}
              className="flex items-center gap-2 rounded-md bg-surface-variant/50 px-2.5 py-1.5 text-[11.5px]"
            >
              <span className="text-on-surface">
                {dateLabel(l.expires_at)} まで有効
              </span>
              <span className="text-on-surface-variant">閲覧 {l.view_count} 回</span>
              <button
                type="button"
                aria-label="この共有リンクを無効化"
                disabled={revoke.isPending}
                onClick={() => revoke.mutate(l.id)}
                className="ml-auto inline-flex items-center gap-1 text-on-surface-variant hover:text-error disabled:opacity-50"
              >
                <Trash2 className="h-3 w-3" aria-hidden="true" />
                無効化
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="mt-2 text-[11.5px] text-on-surface-variant">
          有効な共有リンクはありません。
        </p>
      )}
    </section>
  );
}
