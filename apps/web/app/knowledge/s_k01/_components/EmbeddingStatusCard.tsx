/**
 * GAP-180 — 意味検索 (埋め込み) の状態・準備・再試行。
 *
 * これまでの実態: 意味検索が使えないとき、画面は検索したあとに小さく
 * 「意味検索は無効です」と出すだけで、**なぜ使えないのか・どうすれば直るのか**が
 * 分からなかった (しかも復旧手順として利用者に環境変数名を見せていた)。
 * ここでは GET /embedding-status の実データで
 *   - いま何で動いているか (ローカル / Voyage / 使えない)
 *   - 誰の費用か
 *   - 準備の進み具合 (埋め込み済み件数 / 全件)
 *   - 準備・復旧のためにやること + 「今すぐ準備する」ボタン
 * を出す。使えないことを隠さない。
 */

"use client";

import * as React from "react";
import { useMemo } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CheckCircle2, Loader2, RefreshCw, Search } from "lucide-react";

import type { ApiClient } from "@atelier/api-client";

import { createAuthedApiClient } from "../../../../lib/auth/connector";
import { cn } from "../../../../lib/cn";

export interface EmbeddingStatus {
  readonly provider: "local" | "voyage" | "none";
  readonly state: "ready" | "preparing" | "unavailable";
  readonly reason: string;
  readonly payer: string;
  readonly model_tag?: string | null;
  readonly next_steps: readonly string[];
  readonly warnings: readonly string[];
  readonly semantic_enabled: boolean;
  readonly indexed: number;
  readonly total: number;
}

const KEY = ["embedding-status"] as const;

function isStatus(value: unknown): value is EmbeddingStatus {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Partial<EmbeddingStatus>;
  return (
    typeof v.state === "string" &&
    typeof v.reason === "string" &&
    typeof v.payer === "string" &&
    Array.isArray(v.next_steps) &&
    Array.isArray(v.warnings)
  );
}

const STATE_LABEL: Record<EmbeddingStatus["state"], string> = {
  ready: "意味検索が使えます",
  preparing: "準備中（今はキーワード一致で検索します）",
  unavailable: "意味検索は使えません（キーワード一致のみ）",
};

export interface EmbeddingStatusCardProps {
  readonly client?: ApiClient;
}

export function EmbeddingStatusCard({
  client: injected,
}: EmbeddingStatusCardProps) {
  const client = useMemo(() => injected ?? createAuthedApiClient(), [injected]);
  const queryClient = useQueryClient();

  const status = useQuery({
    queryKey: KEY,
    queryFn: async () => {
      const res = await client.get("/embedding-status");
      const body = (res as { data?: unknown }).data;
      return isStatus(body) ? body : null;
    },
    retry: false,
    // 取得できない場合はカード自体を出さない (推測で状態を書かない)
    meta: { expectedErrors: true },
  });

  const prepare = useMutation({
    mutationFn: async () => {
      const res = await client.post("/embedding-status/prepare", {});
      const body = (res as { data?: unknown }).data;
      return isStatus(body) ? body : null;
    },
    onSuccess: (data) => {
      if (data) queryClient.setQueryData(KEY, data);
      void queryClient.invalidateQueries({ queryKey: KEY });
    },
  });

  // 形が想定と違う応答 (テスト用の空 fake / 旧デプロイ) では何も出さない。
  // 中途半端に描いて「使えている/使えていない」を誤って見せない。
  const data = isStatus(status.data) ? status.data : null;
  if (!data) return null;

  const tone =
    data.state === "ready"
      ? "border-tertiary bg-tertiary-container/40"
      : data.state === "preparing"
        ? "border-secondary bg-secondary-container/40"
        : "border-border bg-surface-variant";

  return (
    <section
      aria-label="意味検索の状態"
      className={cn("rounded-lg border px-3 py-2.5", tone)}
    >
      <div className="flex items-center gap-2">
        {data.state === "ready" ? (
          <CheckCircle2 size={15} aria-hidden className="text-tertiary" />
        ) : data.state === "preparing" ? (
          <Loader2 size={15} aria-hidden className="animate-spin text-secondary" />
        ) : (
          <Search size={15} aria-hidden className="text-on-surface-variant" />
        )}
        <span className="text-[12.5px] font-bold text-on-surface">
          {STATE_LABEL[data.state]}
        </span>
        <span className="ml-auto rounded-full bg-white/70 px-2 py-0.5 text-[10.5px] font-semibold text-on-surface-variant">
          {data.payer}
        </span>
      </div>

      <p className="mt-1 text-[11.5px] leading-[1.6] text-on-surface-variant">
        {data.reason}
      </p>

      {data.total > 0 ? (
        <p className="mt-1 text-[11px] tabular-nums text-on-surface-variant">
          埋め込み済み {data.indexed} / {data.total} 件
          {data.indexed < data.total ? "（残りは準備すると埋まります）" : ""}
        </p>
      ) : null}

      {data.warnings.length > 0 ? (
        <ul className="mt-1.5 flex flex-col gap-0.5">
          {data.warnings.map((w) => (
            <li key={w} className="text-[11px] text-on-surface-variant">
              ⚠ {w}
            </li>
          ))}
        </ul>
      ) : null}

      {data.next_steps.length > 0 ? (
        <ol className="mt-1.5 flex list-inside list-decimal flex-col gap-0.5">
          {data.next_steps.map((step) => (
            <li key={step} className="text-[11px] text-on-surface-variant">
              {step}
            </li>
          ))}
        </ol>
      ) : null}

      {data.state !== "ready" || data.indexed < data.total ? (
        <div className="mt-2 flex items-center gap-2">
          <button
            type="button"
            onClick={() => prepare.mutate()}
            disabled={prepare.isPending}
            className="inline-flex items-center gap-1.5 rounded-md bg-primary px-2.5 py-1 text-[11.5px] font-semibold text-on-primary transition-opacity hover:opacity-90 disabled:opacity-60"
          >
            <RefreshCw
              size={12}
              aria-hidden
              className={prepare.isPending ? "animate-spin" : undefined}
            />
            {data.state === "unavailable" ? "再試行する" : "今すぐ準備する"}
          </button>
          {prepare.isSuccess ? (
            <span className="text-[11px] text-on-surface-variant">
              準備を開始しました（完了までしばらくかかります）
            </span>
          ) : null}
          {prepare.isError ? (
            <span role="alert" className="text-[11px] text-error">
              準備を開始できませんでした
            </span>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
