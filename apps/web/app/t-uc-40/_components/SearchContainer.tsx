/**
 * T-UC-40 グローバル検索 コンテナ — 実 /search API 配線
 *
 * キーワード入力（debounce）+ 種別フィルタで GET /search?q=&kind= を叩き、
 * ヒットを種別ラベル付きで一覧表示する。可視性は RLS が担保。
 * client / debounce はテスト用に注入可能。
 */

"use client";

import * as React from "react";
import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";

import { type ApiClient } from "@atelier/api-client";

import { createAuthedApiClient } from "../../../lib/auth/connector";
import { cn } from "../../../lib/cn";

type Scope = "all" | "project" | "task" | "knowledge" | "employee";
type Kind = "project" | "task" | "knowledge" | "employee";

interface ApiHit {
  id: string;
  kind: Kind;
  title: string;
  snippet: string;
}

const KIND_LABEL: Record<Kind, string> = {
  project: "プロジェクト",
  task: "タスク",
  knowledge: "ナレッジ",
  employee: "AI 社員",
};

const SCOPES: readonly Scope[] = [
  "all",
  "project",
  "task",
  "knowledge",
  "employee",
];

export interface SearchContainerProps {
  readonly client?: ApiClient;
  readonly debounceMs?: number;
}

export function SearchContainer({
  client: injected,
  debounceMs = 300,
}: SearchContainerProps) {
  const client = useMemo(() => injected ?? createAuthedApiClient(), [injected]);
  const [query, setQuery] = useState("");
  const [debounced, setDebounced] = useState("");
  const [scope, setScope] = useState<Scope>("all");

  useEffect(() => {
    const id = setTimeout(() => setDebounced(query.trim()), debounceMs);
    return () => clearTimeout(id);
  }, [query, debounceMs]);

  const results = useQuery({
    queryKey: ["search", debounced, scope],
    queryFn: async () => {
      const res = await client.get("/search", {
        params: { query: { q: debounced, kind: scope } },
      });
      return (res as { data?: ApiHit[] }).data ?? [];
    },
    enabled: debounced.length > 0,
    retry: false,
  });

  const hits = results.data ?? [];

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-md px-md py-lg">
      <h1 className="text-headline-md font-bold text-on-surface">検索</h1>
      <label className="flex flex-col gap-xs">
        <span className="sr-only">キーワード</span>
        <input
          type="search"
          placeholder="キーワード"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          className="h-12 rounded-md border border-surface-variant bg-surface px-sm text-body-lg text-on-surface"
        />
      </label>
      <div role="group" aria-label="種別" className="flex gap-xs">
        {SCOPES.map((s) => (
          <button
            key={s}
            type="button"
            onClick={() => setScope(s)}
            aria-pressed={scope === s}
            className={cn(
              "inline-flex h-8 items-center rounded-sm px-sm text-label-md",
              scope === s
                ? "bg-primary text-primary-fg"
                : "bg-surface-variant text-on-surface",
            )}
          >
            {s === "all" ? "すべて" : KIND_LABEL[s]}
          </button>
        ))}
      </div>

      {debounced.length === 0 ? (
        <p className="text-body-md text-on-surface-variant">
          キーワードを入力してください。
        </p>
      ) : results.isLoading ? (
        <p className="text-body-md text-on-surface-variant">検索中…</p>
      ) : results.error ? (
        <p role="alert" className="text-body-md text-error">
          検索に失敗しました。
        </p>
      ) : (
        <ul role="list" className="flex flex-col gap-sm">
          {hits.length === 0 ? (
            <li className="text-body-md text-on-surface-variant">ヒットなし</li>
          ) : (
            hits.map((h) => (
              <li
                key={`${h.kind}-${h.id}`}
                className="rounded-md border border-surface-variant bg-surface px-md py-sm"
              >
                <span className="text-label-sm text-on-surface-variant">
                  {KIND_LABEL[h.kind]}
                </span>
                <p className="text-label-lg font-semibold text-on-surface">
                  {h.title}
                </p>
                {h.snippet ? (
                  <p className="text-body-sm text-on-surface-variant">
                    {h.snippet}
                  </p>
                ) : null}
              </li>
            ))
          )}
        </ul>
      )}
    </div>
  );
}
