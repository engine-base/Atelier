/**
 * GAP-163 — Excel / CSV 成果物をツール内で表として見て、直して、新版で保存する。
 *
 * 経営者質問:
 *   「エクセルとかだとここの表示はどうなるの？？
 *    エクセルとかスプレッドシートをここで修正とかできるの？PDF もだけど」
 *
 * - Excel / CSV: シート切替つきの表で表示し、セルを直接編集 → 「新しい版として保存」
 * - 保持しないもの (数式・書式・グラフ) は画面に明示する (黙って落とさない)
 * - PDF: この画面では表示のみ (編集不可) — API が 409 で理由を返すのでそのまま出す
 */

"use client";

import * as React from "react";
import { useEffect, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";

import { ApiError, type ApiClient } from "@atelier/api-client";

import { Loading } from "../../../../components/Loading";
import { cn } from "../../../../lib/cn";

export interface SheetPayload {
  readonly file_name: string;
  readonly mime: string;
  readonly editable: boolean;
  readonly sheets: readonly { readonly name: string; readonly rows: readonly string[][] }[];
  readonly note: string;
}

export interface SheetEditorProps {
  readonly outputId: string;
  readonly client: ApiClient;
  /** 保存成功時 (新バージョンの output id)。 */
  readonly onSaved?: (newOutputId: string) => void;
}

/**
 * GAP-166: サーバーが表に落とせない形式 (PDF・書式つき Excel 等) も、
 * 本人の PC で走る Claude Code なら直せる。ジョブを積んで実行してもらう。
 */
function AiFileEdit({
  outputId,
  client,
}: {
  readonly outputId: string;
  readonly client: ApiClient;
}) {
  const [instruction, setInstruction] = useState("");
  const [notice, setNotice] = useState<{ kind: "ok" | "error"; text: string } | null>(
    null,
  );
  const ask = useMutation({
    retry: false,
    mutationFn: async () => {
      const res = await client.post("/outputs/{output_id}/ai-file-edit", {
        params: { path: { output_id: outputId } },
        body: { instruction: instruction.trim() },
      });
      return (res as { data?: { job_id: string } }).data ?? null;
    },
    onSuccess: () => {
      setInstruction("");
      setNotice({
        kind: "ok",
        text:
          "あなたの PC の Claude Code に依頼しました。実行が終わると新しい版として" +
          "この成果物に追加されます (進行タブで実行状況を確認できます)。",
      });
    },
    onError: (e) =>
      setNotice({
        kind: "error",
        text:
          e instanceof ApiError && e.status === 503
            ? "Bridge がオフラインのため実行できません。Bridge アプリを起動してから再実行してください。"
            : e instanceof ApiError && e.status === 409
              ? ((e.payload as { detail?: string } | undefined)?.detail ??
                "この形式はファイル編集に対応していません。")
              : "依頼に失敗しました。時間をおいて再度お試しください。",
      }),
  });

  return (
    <div className="mt-2 rounded-md border border-border p-2.5">
      <h4 className="text-[11.5px] font-bold text-on-surface">
        AI にファイルごと直してもらう（あなたの PC の Claude Code で実行）
      </h4>
      <p className="mt-0.5 text-[11px] text-on-surface-variant">
        書式つきの Excel や PDF など、この画面の表では直せないものはこちら。
        あなたの Claude サブスクで実行され、結果は新しい版として追加されます。
      </p>
      <textarea
        value={instruction}
        onChange={(e) => setInstruction(e.target.value)}
        rows={2}
        maxLength={4000}
        disabled={ask.isPending}
        placeholder="例: 第 3 条の支払期日を月末締め翌月末に直して / 明細に保守費の行を追加して"
        className="mt-1.5 w-full resize-y rounded-md border border-border bg-surface px-sm py-1.5 text-[12px] text-on-surface outline-none placeholder:text-on-surface-variant focus-visible:border-primary disabled:opacity-60"
      />
      {notice ? (
        <p
          role={notice.kind === "error" ? "alert" : "status"}
          className={cn(
            "mt-1.5 rounded-md px-2 py-1 text-[11px]",
            notice.kind === "error"
              ? "bg-error/10 text-error"
              : "bg-tertiary-container text-tertiary-container-fg",
          )}
        >
          {notice.text}
        </p>
      ) : null}
      <div className="mt-1.5 flex justify-end">
        <button
          type="button"
          disabled={instruction.trim() === "" || ask.isPending}
          onClick={() => {
            setNotice(null);
            ask.mutate();
          }}
          className="rounded-md border border-border px-3 py-1 text-[11.5px] font-semibold text-on-surface-variant hover:bg-surface-variant hover:text-on-surface disabled:opacity-50"
        >
          {ask.isPending ? "依頼中…" : "AI に修正を依頼"}
        </button>
      </div>
    </div>
  );
}

export function SheetEditor({ outputId, client, onSaved }: SheetEditorProps) {
  const [sheets, setSheets] = useState<{ name: string; rows: string[][] }[] | null>(null);
  const [active, setActive] = useState(0);
  const [notice, setNotice] = useState<{ kind: "ok" | "error"; text: string } | null>(null);

  const sheet = useQuery({
    queryKey: ["output-sheet", outputId],
    retry: false,
    queryFn: async () => {
      const res = await client.get("/outputs/{output_id}/sheet", {
        params: { path: { output_id: outputId } },
      });
      return (res as { data?: SheetPayload }).data ?? null;
    },
  });

  useEffect(() => {
    // 想定外の応答 (sheets 欠落) でビューア全体を巻き込まない
    const incoming = sheet.data?.sheets;
    if (Array.isArray(incoming)) {
      setSheets(
        incoming.map((s) => ({
          name: s?.name ?? "",
          rows: Array.isArray(s?.rows) ? s.rows.map((r: readonly string[]) => [...r]) : [],
        })),
      );
      setActive(0);
    }
  }, [sheet.data]);

  const save = useMutation({
    retry: false,
    mutationFn: async () => {
      const res = await client.post("/outputs/{output_id}/sheet", {
        params: { path: { output_id: outputId } },
        body: { sheets: sheets ?? [] },
      });
      return (res as { data?: { id: string; version: number } }).data ?? null;
    },
    onSuccess: (created) => {
      setNotice({
        kind: "ok",
        text: created
          ? `v${created.version} として保存しました (元の版は残っています)`
          : "保存しました。",
      });
      if (created) onSaved?.(created.id);
    },
    onError: () => setNotice({ kind: "error", text: "保存に失敗しました。" }),
  });

  if (sheet.isLoading) return <Loading className="py-md" />;
  if (sheet.error) {
    const msg =
      sheet.error instanceof ApiError && sheet.error.status === 409
        ? ((sheet.error.payload as { detail?: string } | undefined)?.detail ??
          "この形式は表として扱えません。")
        : "表を読み込めませんでした。";
    return (
      <section aria-label="ファイルの表示と編集" className="border-t border-border px-lg py-3">
        <p role="status" className="text-[12px] text-on-surface-variant">
          {msg}
        </p>
        {/* GAP-166: 表にできない形式でも、本人の Claude Code なら直せる */}
        {sheet.error instanceof ApiError && sheet.error.status === 409 ? (
          <AiFileEdit outputId={outputId} client={client} />
        ) : null}
      </section>
    );
  }
  if (!sheet.data || !Array.isArray(sheet.data.sheets) || !sheets) return null;

  const current = sheets[active];
  if (!current) return null;

  return (
    <section aria-label="表の表示と編集" className="border-t border-border px-lg py-3">
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="text-[12px] font-bold text-on-surface">{sheet.data.file_name}</h3>
        {sheets.length > 1 ? (
          <div role="tablist" aria-label="シート" className="flex gap-1">
            {sheets.map((s, i) => (
              <button
                key={s.name}
                type="button"
                role="tab"
                aria-selected={i === active}
                onClick={() => setActive(i)}
                className={cn(
                  "rounded-md px-2 py-0.5 text-[11.5px]",
                  i === active
                    ? "bg-primary-container font-semibold text-on-primary-container"
                    : "text-on-surface-variant hover:bg-surface-variant",
                )}
              >
                {s.name}
              </button>
            ))}
          </div>
        ) : null}
        <button
          type="button"
          disabled={save.isPending}
          onClick={() => {
            setNotice(null);
            save.mutate();
          }}
          className="ml-auto rounded-md bg-primary px-3 py-1.5 text-[12px] font-semibold text-on-primary hover:bg-primary-hover disabled:opacity-50"
        >
          {save.isPending ? "保存中…" : "新しい版として保存"}
        </button>
      </div>
      {sheet.data.note ? (
        <p className="mt-1 text-[11px] text-on-surface-variant">{sheet.data.note}</p>
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

      <AiFileEdit outputId={outputId} client={client} />

      <div className="mt-2 max-h-[420px] overflow-auto rounded-md border border-border">
        <table className="w-full border-collapse text-[12px]">
          <tbody>
            {current.rows.map((row, ri) => (
              // 行の並びが同一値でも入れ替わらないよう index キーで固定する
              // eslint-disable-next-line react/no-array-index-key
              <tr key={ri}>
                {row.map((cell, ci) => (
                  // eslint-disable-next-line react/no-array-index-key
                  <td key={ci} className="border border-border p-0">
                    <input
                      aria-label={`${current.name} ${ri + 1}行 ${ci + 1}列`}
                      value={cell}
                      onChange={(e) => {
                        const next = sheets.map((s, si) =>
                          si !== active
                            ? s
                            : {
                                ...s,
                                rows: s.rows.map((r, rj) =>
                                  rj !== ri
                                    ? r
                                    : r.map((c, cj) => (cj === ci ? e.target.value : c)),
                                ),
                              },
                        );
                        setSheets(next);
                      }}
                      className="w-full min-w-[90px] bg-transparent px-2 py-1 text-on-surface outline-none focus:bg-primary-container/30"
                    />
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
