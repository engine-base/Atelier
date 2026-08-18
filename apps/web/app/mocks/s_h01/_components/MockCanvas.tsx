/**
 * S-H01 モックキャンバス (GAP-138)
 *
 * プロジェクトの全画面 (画面名ごとの最新バージョン) を 1 つのキャンバスに
 * 並べて俯瞰する。各カードは実 HTML (署名付き content-url) を縮小 iframe で
 * 実描画し、ズームスライダで倍率を変えられる (パンはスクロール)。
 * カードから「開く」(ビューア) と「編集」(ワンダへの修正依頼 = Open Design
 * パターン、POST /mocks/{id}/revise) に直接進める。
 */

"use client";

import * as React from "react";
import { useState } from "react";
import Link from "next/link";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { ApiError, type ApiClient } from "@atelier/api-client";

const PAGE_W = 1280;
const PAGE_H = 800;

export interface CanvasMock {
  readonly id: string;
  readonly screen_name: string;
  readonly version: number;
}

function contentUrlQueryKey(mockId: string): readonly unknown[] {
  return ["mock-content-url", mockId];
}

function reviseErrorMessage(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.status === 503) {
      return "AI 実行経路が使えません (Bridge がオフラインの可能性)。Bridge を起動して再試行してください。";
    }
    return "修正依頼に失敗しました。時間をおいて再試行してください。";
  }
  return "修正依頼に失敗しました。";
}

function CanvasCard({
  mock,
  zoom,
  client,
}: {
  readonly mock: CanvasMock;
  readonly zoom: number;
  readonly client: ApiClient;
}) {
  const queryClient = useQueryClient();
  const [editOpen, setEditOpen] = useState(false);
  const [instruction, setInstruction] = useState("");

  const contentUrl = useQuery({
    queryKey: contentUrlQueryKey(mock.id),
    queryFn: async () => {
      const res = await client.get("/mocks/{mock_id}/content-url", {
        params: { path: { mock_id: mock.id } },
      });
      const d = (res as { data?: { url?: string } }).data;
      return d?.url ?? null;
    },
    retry: false,
    staleTime: 5 * 60 * 1000,
  });

  const revise = useMutation({
    retry: false,
    mutationFn: async (text: string) => {
      const res = await client.post("/mocks/{mock_id}/revise", {
        params: { path: { mock_id: mock.id } },
        body: { instruction: text },
      });
      return (res as { data?: { id?: string } }).data ?? null;
    },
    onSuccess: () => {
      setEditOpen(false);
      setInstruction("");
      // 一覧 (最新バージョン) と content-url を取り直す
      void queryClient.invalidateQueries({ queryKey: ["mocks"] });
    },
  });

  const w = Math.round(PAGE_W * zoom);
  const h = Math.round(PAGE_H * zoom);

  return (
    <li className="shrink-0">
      <figure className="m-0">
        <figcaption className="mb-1 flex items-center gap-2 text-body-sm">
          <span className="font-semibold text-on-surface">{mock.screen_name}</span>
          <span className="tabular-nums text-on-surface-variant">v{mock.version}</span>
          <Link
            href={`/mocks?mock=${mock.id}`}
            className="ml-auto font-semibold text-primary hover:underline"
          >
            開く
          </Link>
          <button
            type="button"
            onClick={() => setEditOpen((v) => !v)}
            aria-expanded={editOpen}
            className="rounded-sm border border-border px-2 py-0.5 text-[11.5px] text-on-surface hover:bg-surface-variant"
          >
            編集
          </button>
        </figcaption>
        <div
          className="overflow-hidden rounded-md border border-border bg-white shadow-sm"
          style={{ width: w, height: h }}
        >
          {contentUrl.data ? (
            <iframe
              title={`${mock.screen_name} v${mock.version}`}
              src={contentUrl.data}
              sandbox="allow-same-origin"
              className="pointer-events-none origin-top-left border-0"
              style={{ width: PAGE_W, height: PAGE_H, transform: `scale(${zoom})` }}
            />
          ) : (
            <div className="grid h-full place-items-center px-sm text-center text-body-sm text-on-surface-variant">
              {contentUrl.isLoading
                ? "読み込み中…"
                : "プレビューを取得できません (storage 未設定の可能性)"}
            </div>
          )}
        </div>
        {editOpen ? (
          <div className="mt-1" style={{ width: w }}>
            <textarea
              value={instruction}
              onChange={(e) => setInstruction(e.target.value)}
              rows={2}
              placeholder="ワンダへの修正指示 (例: ヒーローの見出しを大きく)"
              aria-label={`${mock.screen_name} への修正指示`}
              className="w-full rounded-md border border-border bg-surface px-2 py-1 text-body-sm text-on-surface"
            />
            <div className="mt-1 flex items-center gap-2">
              <button
                type="button"
                disabled={revise.isPending || instruction.trim() === ""}
                onClick={() => revise.mutate(instruction.trim())}
                className="rounded-sm bg-primary px-3 py-1 text-[11.5px] font-semibold text-on-primary hover:opacity-90 disabled:opacity-50"
              >
                {revise.isPending ? "ワンダが改訂中…" : "修正を依頼"}
              </button>
              {revise.error ? (
                <span role="alert" className="text-[11.5px] text-error">
                  {reviseErrorMessage(revise.error)}
                </span>
              ) : null}
            </div>
          </div>
        ) : null}
      </figure>
    </li>
  );
}

export interface MockCanvasProps {
  readonly mocks: readonly CanvasMock[];
  readonly client: ApiClient;
}

export function MockCanvas({ mocks, client }: MockCanvasProps) {
  const [zoom, setZoom] = useState(0.3);
  return (
    <section aria-label="モックキャンバス">
      <div className="mb-sm flex items-center gap-2 text-body-sm text-on-surface-variant">
        <label htmlFor="canvas-zoom" className="font-semibold">
          ズーム
        </label>
        <input
          id="canvas-zoom"
          type="range"
          min={15}
          max={70}
          value={Math.round(zoom * 100)}
          onChange={(e) => setZoom(Number(e.target.value) / 100)}
          className="w-40"
        />
        <span className="tabular-nums">{Math.round(zoom * 100)}%</span>
        <span className="ml-2">スクロールで移動 / 各カードの「編集」からワンダに修正依頼</span>
      </div>
      <div className="overflow-auto rounded-lg border border-border bg-surface-variant/40 p-md">
        <ul role="list" className="flex flex-wrap items-start gap-md">
          {mocks.map((m) => (
            <CanvasCard key={m.id} mock={m} zoom={zoom} client={client} />
          ))}
        </ul>
      </div>
    </section>
  );
}
