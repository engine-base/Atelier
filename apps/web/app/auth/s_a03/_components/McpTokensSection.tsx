/**
 * S-A03 MCP トークンセクション — 実 MCP トークン API 配線 (T-A-08)
 *
 * 以前は「Claude Desktop (Mac) / CI/CD Pipeline」の静的モックを表示していたが、
 * 実データではなかった。ここで実 API に配線する:
 *   - GET    /mcp-tokens?workspace_id=  一覧 (RLS: member)
 *   - POST   /mcp-tokens {workspace_id,name,scopes}  発行 (plaintext を1度だけ返す)
 *   - DELETE /mcp-tokens/{id}           失効 (owner のみ)
 * 発行直後の plaintext は再表示不可のため、その場で1度だけ提示する。
 */

"use client";

import * as React from "react";
import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { ApiError, type ApiClient } from "@atelier/api-client";

import { cn } from "../../../../lib/cn";

interface Token {
  readonly id: string;
  readonly name: string;
  readonly scopes: readonly string[];
  readonly revoked_at: string | null;
  readonly last_used_at: string | null;
}

const CARD = "rounded-lg border border-border bg-white p-5";
const SECTION_TITLE = "text-base font-bold tracking-tight text-on-surface";
const BADGE = "inline-flex items-center rounded-sm px-2 py-0.5 text-[10.5px] font-semibold";
const BTN_PRIMARY_SM =
  "inline-flex items-center justify-center gap-1.5 rounded-md bg-primary px-3 py-1.5 text-label-md font-semibold text-on-primary transition-colors hover:bg-[#1E54D8] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary disabled:opacity-50";
const BTN_GHOST_SM =
  "inline-flex items-center justify-center rounded-md p-1.5 text-on-surface transition-colors hover:bg-surface-variant focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary disabled:opacity-40";

function relTime(iso: string | null): string {
  if (!iso) return "未使用";
  return `最終使用 ${new Date(iso).toLocaleDateString("ja-JP")}`;
}

function PlusIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
      <path d="M8 3v10M3 8h10" />
    </svg>
  );
}
function TrashIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 16 16" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M2.5 4h11M6 4V2.5h4V4M4 4l.6 9.5h6.8L12 4" />
    </svg>
  );
}

export interface McpTokensSectionProps {
  readonly workspaceId: string;
  readonly client: ApiClient;
}

export function McpTokensSection({ workspaceId, client }: McpTokensSectionProps) {
  const queryClient = useQueryClient();
  const KEY = useMemo(() => ["mcp-tokens", workspaceId] as const, [workspaceId]);

  const [newOpen, setNewOpen] = useState(false);
  const [name, setName] = useState("");
  const [issued, setIssued] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);

  const tokensQuery = useQuery({
    queryKey: KEY,
    queryFn: async () => {
      const res = await client.get("/mcp-tokens", {
        params: { query: { workspace_id: workspaceId } },
      });
      const data = (res as { data?: unknown }).data;
      return (Array.isArray(data) ? data : []) as Token[];
    },
    retry: false,
  });

  const createMut = useMutation({
    mutationFn: async () => {
      const res = await client.post("/mcp-tokens", {
        body: { workspace_id: workspaceId, name: name.trim(), scopes: ["read", "write"] },
      });
      return (res as { data?: { token?: string } }).data?.token ?? null;
    },
    onSuccess: (token) => {
      setIssued(token);
      setNewOpen(false);
      setName("");
      setFormError(null);
      void queryClient.invalidateQueries({ queryKey: KEY });
    },
    onError: (err) => {
      setFormError(
        err instanceof ApiError && err.status === 403
          ? "トークンを発行できるのはオーナーのみです。"
          : "トークンの発行に失敗しました。",
      );
    },
  });

  const revokeMut = useMutation({
    mutationFn: async (id: string) => {
      await client.delete("/mcp-tokens/{token_id}", {
        params: { path: { token_id: id } },
      });
    },
    onSettled: () => void queryClient.invalidateQueries({ queryKey: KEY }),
  });

  const tokens = (tokensQuery.data ?? []).filter((t) => t.revoked_at === null);

  return (
    <section className={cn(CARD, "md:col-span-2")} aria-label="MCPトークン">
      <div className="mb-4 flex items-center justify-between">
        <h2 className={SECTION_TITLE}>MCPトークン</h2>
        <button
          type="button"
          onClick={() => {
            setNewOpen((v) => !v);
            setIssued(null);
          }}
          className={BTN_PRIMARY_SM}
        >
          <PlusIcon />
          発行
        </button>
      </div>
      <p className="mb-4 text-body-sm text-on-surface-variant">
        Claude デスクトップ等の MCP クライアントからこのワークスペースの AI 社員を呼び出すためのトークン。
      </p>

      {issued ? (
        <div className="mb-4 rounded-md border-l-[3px] border-primary bg-primary-container p-3 text-on-primary-container">
          <p className="text-body-sm font-semibold">
            発行しました。この画面を離れると再表示できません。今すぐコピーしてください。
          </p>
          <code className="mt-2 block break-all rounded bg-white/70 px-2 py-1 font-mono text-body-sm text-on-surface">
            {issued}
          </code>
        </div>
      ) : null}

      {newOpen ? (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (name.trim()) createMut.mutate();
          }}
          className="mb-4 flex flex-col gap-3 rounded-md border border-border bg-surface p-3"
        >
          <div className="flex flex-col gap-1.5">
            <label htmlFor="token-name" className="text-label-md font-medium text-on-surface-variant">
              トークン名
            </label>
            <input
              id="token-name"
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="例：Claude Desktop (Mac)"
              autoFocus
              className="h-10 rounded-md border border-border bg-white px-3 text-body-md text-on-surface placeholder:text-on-surface-variant focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary-container"
            />
          </div>
          {formError ? (
            <p role="alert" className="text-body-sm text-error">
              {formError}
            </p>
          ) : null}
          <div className="flex justify-end gap-2">
            <button
              type="button"
              onClick={() => {
                setNewOpen(false);
                setFormError(null);
              }}
              className="inline-flex h-9 items-center rounded-md px-3 text-label-md font-semibold text-on-surface hover:bg-surface-variant"
            >
              キャンセル
            </button>
            <button
              type="submit"
              disabled={!name.trim() || createMut.isPending}
              className="inline-flex h-9 items-center rounded-md bg-primary px-4 text-label-md font-semibold text-on-primary transition-colors hover:bg-[#1E54D8] disabled:opacity-50"
            >
              {createMut.isPending ? "発行中…" : "発行する"}
            </button>
          </div>
        </form>
      ) : null}

      {tokensQuery.isError ? (
        <p role="alert" className="text-body-sm text-error">
          トークンの取得に失敗しました。
        </p>
      ) : tokensQuery.isLoading ? (
        <p className="text-body-sm text-on-surface-variant">読み込み中…</p>
      ) : tokens.length === 0 ? (
        <p className="text-body-sm text-on-surface-variant">
          有効なトークンはありません。「発行」で作成できます。
        </p>
      ) : (
        <ul>
          {tokens.map((tk) => (
            <li
              key={tk.id}
              className="grid grid-cols-[1fr_auto_auto_auto] items-center gap-3 border-b border-border py-3 last:border-b-0"
            >
              <div className="min-w-0">
                <div className="truncate font-semibold text-on-surface">{tk.name}</div>
                <div className="truncate font-mono text-body-sm text-on-surface-variant">
                  {relTime(tk.last_used_at)}
                </div>
              </div>
              <span className={cn(BADGE, "bg-tertiary-container text-on-tertiary-container")}>active</span>
              <span className="text-body-sm text-on-surface-variant">
                {tk.scopes.join(", ") || "—"}
              </span>
              <button
                type="button"
                onClick={() => revokeMut.mutate(tk.id)}
                disabled={revokeMut.isPending}
                className={BTN_GHOST_SM}
                aria-label={`${tk.name} のトークンを取り消す`}
              >
                <TrashIcon />
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
