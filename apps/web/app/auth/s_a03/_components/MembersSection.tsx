/**
 * S-A03 メンバーセクション — 実 WS メンバー API 配線 (T-A-07)
 *
 * 以前はモック忠実の静的3名 (高本まさと 等) を表示していたが、実データではなく、
 * 新規 WS でも他人が出る虚偽表示だった。ここで実 API に配線する:
 *   - GET    /workspaces/{id}/members            一覧 (membership-gated definer)
 *   - POST   /workspaces/{id}/members {email,role} 招待 (未登録422 / 非owner403 / 既員409)
 *   - PATCH  /workspaces/{id}/members/{uid} {role} ロール変更 (owner のみ)
 *   - DELETE /workspaces/{id}/members/{uid}        削除 (owner のみ)
 * 招待は「登録済ユーザーの email」を owner が追加する方式 (バックエンド仕様)。
 */

"use client";

import * as React from "react";
import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { ApiError, type ApiClient } from "@atelier/api-client";

import { cn } from "../../../../lib/cn";

type MemberRole = "owner" | "member" | "viewer";

interface Member {
  readonly user_id: string;
  readonly email: string;
  readonly display_name: string | null;
  readonly role: MemberRole;
}

const ROLE_LABEL: Record<MemberRole, string> = {
  owner: "オーナー",
  member: "メンバー",
  viewer: "閲覧者",
};
const ROLE_TONE: Record<MemberRole, string> = {
  owner: "bg-primary-container text-on-primary-container",
  member: "bg-surface-variant text-on-surface-variant",
  viewer: "bg-surface-variant text-on-surface-variant",
};
const AVATAR_TONES = [
  "bg-primary text-on-primary",
  "bg-[#7C3AED] text-white",
  "bg-[#0891B2] text-white",
  "bg-[#D97706] text-white",
];

const CARD = "rounded-lg border border-border bg-white p-5";
const SECTION_TITLE = "text-base font-bold tracking-tight text-on-surface";
const BADGE = "inline-flex items-center rounded-sm px-2 py-0.5 text-[10.5px] font-semibold";
const BTN_OUTLINED_SM =
  "inline-flex w-fit items-center justify-center gap-1.5 rounded-md border border-primary px-3 py-1.5 text-label-md font-semibold text-primary transition-colors hover:bg-primary-container focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary disabled:opacity-50";
const BTN_GHOST_SM =
  "inline-flex items-center justify-center rounded-md p-1.5 text-on-surface transition-colors hover:bg-surface-variant focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary disabled:opacity-40";

function initialOf(m: Member): string {
  const src = (m.display_name?.trim() || m.email).charAt(0);
  return src ? src.toUpperCase() : "?";
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

export interface MembersSectionProps {
  readonly workspaceId: string;
  readonly client: ApiClient;
}

export function MembersSection({ workspaceId, client }: MembersSectionProps) {
  const queryClient = useQueryClient();
  const KEY = useMemo(() => ["ws-members", workspaceId] as const, [workspaceId]);

  const [inviteOpen, setInviteOpen] = useState(false);
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<MemberRole>("member");
  const [formError, setFormError] = useState<string | null>(null);

  const membersQuery = useQuery({
    queryKey: KEY,
    queryFn: async () => {
      const res = await client.get("/workspaces/{workspace_id}/members", {
        params: { path: { workspace_id: workspaceId } },
      });
      const data = (res as { data?: unknown }).data;
      return (Array.isArray(data) ? data : []) as Member[];
    },
    retry: false,
  });

  const inviteMut = useMutation({
    mutationFn: async () => {
      await client.post("/workspaces/{workspace_id}/members", {
        params: { path: { workspace_id: workspaceId } },
        body: { email: email.trim(), role },
      });
    },
    onSuccess: () => {
      setInviteOpen(false);
      setEmail("");
      setRole("member");
      setFormError(null);
      void queryClient.invalidateQueries({ queryKey: KEY });
    },
    onError: (err) => {
      if (err instanceof ApiError) {
        if (err.status === 422) return setFormError("このメールのユーザーは未登録です。先に登録が必要です。");
        if (err.status === 409) return setFormError("すでにメンバーです。");
        if (err.status === 403) return setFormError("メンバーを招待できるのはオーナーのみです。");
      }
      setFormError("招待に失敗しました。時間をおいて再度お試しください。");
    },
  });

  const roleMut = useMutation({
    mutationFn: async (v: { userId: string; role: MemberRole }) => {
      await client.patch("/workspaces/{workspace_id}/members/{user_id}", {
        params: { path: { workspace_id: workspaceId, user_id: v.userId } },
        body: { role: v.role },
      });
    },
    onSettled: () => void queryClient.invalidateQueries({ queryKey: KEY }),
  });

  const removeMut = useMutation({
    mutationFn: async (userId: string) => {
      await client.delete("/workspaces/{workspace_id}/members/{user_id}", {
        params: { path: { workspace_id: workspaceId, user_id: userId } },
      });
    },
    onSettled: () => void queryClient.invalidateQueries({ queryKey: KEY }),
  });

  const members = membersQuery.data ?? [];

  return (
    <section className={CARD} aria-label="メンバー">
      <h2 className={cn(SECTION_TITLE, "mb-4")}>
        メンバー（{membersQuery.isLoading ? "…" : members.length}）
      </h2>

      {membersQuery.isError ? (
        <p role="alert" className="text-body-sm text-error">
          メンバーの取得に失敗しました。
        </p>
      ) : membersQuery.isLoading ? (
        <p className="text-body-sm text-on-surface-variant">読み込み中…</p>
      ) : members.length === 0 ? (
        <p className="text-body-sm text-on-surface-variant">メンバーがいません。</p>
      ) : (
        <ul>
          {members.map((m, i) => (
            <li
              key={m.user_id}
              className="flex items-center gap-3 border-b border-border py-3 last:border-b-0"
            >
              <span
                aria-hidden="true"
                className={cn(
                  "flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-label-md font-bold",
                  AVATAR_TONES[i % AVATAR_TONES.length],
                )}
              >
                {initialOf(m)}
              </span>
              <div className="min-w-0 flex-1">
                <div className="truncate font-semibold text-on-surface">
                  {m.display_name?.trim() || m.email}
                </div>
                <div className="truncate text-body-sm text-on-surface-variant">
                  {m.email}
                </div>
              </div>
              {m.role === "owner" ? (
                <span className={cn(BADGE, ROLE_TONE.owner)}>{ROLE_LABEL.owner}</span>
              ) : (
                <>
                  <label className="sr-only" htmlFor={`role-${m.user_id}`}>
                    {m.email} のロール
                  </label>
                  <select
                    id={`role-${m.user_id}`}
                    value={m.role}
                    disabled={roleMut.isPending}
                    onChange={(e) =>
                      roleMut.mutate({ userId: m.user_id, role: e.target.value as MemberRole })
                    }
                    className="h-8 rounded-md border border-border bg-surface px-2 text-label-md text-on-surface focus:border-primary focus:outline-none"
                  >
                    <option value="member">メンバー</option>
                    <option value="viewer">閲覧者</option>
                  </select>
                  <button
                    type="button"
                    onClick={() => removeMut.mutate(m.user_id)}
                    disabled={removeMut.isPending}
                    className={BTN_GHOST_SM}
                    aria-label={`${m.email} を削除`}
                  >
                    <TrashIcon />
                  </button>
                </>
              )}
            </li>
          ))}
        </ul>
      )}

      {inviteOpen ? (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (email.trim()) inviteMut.mutate();
          }}
          className="mt-4 flex flex-col gap-3 rounded-md border border-border bg-surface p-3"
        >
          <div className="flex flex-col gap-1.5">
            <label htmlFor="invite-email" className="text-label-md font-medium text-on-surface-variant">
              招待するユーザーのメール（登録済み）
            </label>
            <input
              id="invite-email"
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="member@example.com"
              autoFocus
              className="h-10 rounded-md border border-border bg-white px-3 text-body-md text-on-surface placeholder:text-on-surface-variant focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary-container"
            />
          </div>
          <div className="flex items-center gap-2">
            <label htmlFor="invite-role" className="text-label-md font-medium text-on-surface-variant">
              ロール
            </label>
            <select
              id="invite-role"
              value={role}
              onChange={(e) => setRole(e.target.value as MemberRole)}
              className="h-10 rounded-md border border-border bg-white px-2 text-body-md text-on-surface focus:border-primary focus:outline-none"
            >
              <option value="member">メンバー</option>
              <option value="viewer">閲覧者</option>
            </select>
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
                setInviteOpen(false);
                setFormError(null);
              }}
              className="inline-flex h-9 items-center rounded-md px-3 text-label-md font-semibold text-on-surface hover:bg-surface-variant"
            >
              キャンセル
            </button>
            <button
              type="submit"
              disabled={!email.trim() || inviteMut.isPending}
              className="inline-flex h-9 items-center rounded-md bg-primary px-4 text-label-md font-semibold text-on-primary transition-colors hover:bg-[#1E54D8] disabled:opacity-50"
            >
              {inviteMut.isPending ? "招待中…" : "招待する"}
            </button>
          </div>
        </form>
      ) : (
        <button
          type="button"
          onClick={() => setInviteOpen(true)}
          className={cn(BTN_OUTLINED_SM, "mt-4")}
        >
          <PlusIcon />
          メンバー招待
        </button>
      )}
    </section>
  );
}
