/**
 * S-T04 ユーザー管理 コンテナ — T-UC-33 (実 admin API 配線)
 *
 * GET /admin/users（運営 admin: 所属 workspace 横断メンバー・read-only）を取得し
 * UserAdminList に渡す。停止/復元 API は未提供のため read-only 表示（アクション列なし）。
 * API は state/last_login を持たないため state='active'（停止機能なし）・last_login=null とする。
 *
 * サポート連絡 (GAP-031⑥): 行の「サポート連絡」→ 件名/本文ダイアログ →
 * POST /admin/support-contact (実メール送信 — 未設定環境は dry_run を応答で明示) →
 * audit support.contact に記録。「最近のサポート対応」カードは
 * GET /admin/support-contacts (audit 逆引き) の実データ。
 * api client は prop 注入可能 (テスト時に fake を渡す)。
 */

"use client";

import * as React from "react";
import { Loading } from "../../../../components/Loading";
import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { ApiError, type ApiClient } from "@atelier/api-client";

import { createAuthedApiClient } from "../../../../lib/auth/connector";
import { AdminButton } from "../../_components/AdminButton";
import { Dialog } from "../../../../components/ui/dialog";
import { Field } from "../../../../components/forms/Field";
import { UserAdminList, type AdminUser } from "./UserAdminList";

interface ApiUser {
  user_id: string;
  email: string;
  display_name?: string | null;
}

interface SupportContactItem {
  to_email: string;
  display_name?: string | null;
  subject: string;
  created_at: string;
}

export interface UserAdminContainerProps {
  readonly client?: ApiClient;
}

function isForbidden(error: unknown): boolean {
  return error instanceof ApiError && error.status === 403;
}

/** 相対時刻 (モック「2h」「昨日」表記の実算出)。 */
function relTime(iso: string): string {
  const diffMs = Date.now() - new Date(iso).getTime();
  const h = Math.floor(diffMs / 3_600_000);
  if (h < 1) return "1h 以内";
  if (h < 24) return `${h}h`;
  const d = Math.floor(h / 24);
  return d === 1 ? "昨日" : `${d} 日前`;
}

export function UserAdminContainer({
  client: injected,
}: UserAdminContainerProps) {
  const client = useMemo(() => injected ?? createAuthedApiClient(), [injected]);
  const queryClient = useQueryClient();

  const list = useQuery({
    queryKey: ["admin", "users"],
    queryFn: async () => {
      const res = await client.get("/admin/users");
      return (res as { data?: ApiUser[] }).data ?? [];
    },
    retry: false,
  });

  // GAP-031⑥: 最近のサポート対応 (audit support.contact 逆引きの実データ)
  const recentQuery = useQuery({
    queryKey: ["admin", "support-contacts"],
    queryFn: async () => {
      const res = await client.get("/admin/support-contacts", {
        params: { query: { limit: 10 } },
      });
      return (res as { data?: SupportContactItem[] }).data ?? [];
    },
    retry: false,
  });

  const [contactTarget, setContactTarget] = useState<AdminUser | null>(null);
  const [subject, setSubject] = useState("");
  const [message, setMessage] = useState("");
  const [sentNote, setSentNote] = useState<string | null>(null);

  const sendMut = useMutation({
    mutationFn: async (v: { userId: string; subject: string; message: string }) => {
      const res = await client.post("/admin/support-contact", {
        body: { user_id: v.userId, subject: v.subject, message: v.message },
      });
      return (res as { data?: { to_email: string; dry_run: boolean } }).data;
    },
    onSuccess: (data) => {
      setContactTarget(null);
      setSubject("");
      setMessage("");
      setSentNote(
        data?.dry_run
          ? `${data.to_email} 宛に記録しました（この環境はメール未設定のためドライラン — 実送信は ATELIER_EMAIL_* 設定で有効化）`
          : `${data?.to_email ?? ""} 宛に送信しました`,
      );
      void queryClient.invalidateQueries({ queryKey: ["admin", "support-contacts"] });
    },
  });

  if (isForbidden(list.error)) {
    return (
      <p role="alert" className="text-body-md text-error">
        ユーザー管理にアクセスする権限がありません（運営 admin 専用）。
      </p>
    );
  }
  if (list.error) {
    return (
      <p role="alert" className="text-body-md text-error">
        ユーザーの取得に失敗しました。
      </p>
    );
  }
  if (list.isLoading) {
    return <Loading className="py-md" />;
  }

  const users: AdminUser[] = (list.data ?? []).map((u) => ({
    id: u.user_id,
    email: u.email,
    state: "active",
    last_login: null,
  }));
  const recent = recentQuery.data ?? [];

  return (
    <div className="flex flex-col gap-6">
      {sentNote ? (
        <div
          role="status"
          className="rounded-md border-l-[3px] border-tertiary bg-tertiary-container/40 px-4 py-3 text-body-sm text-on-surface"
        >
          {sentNote}
          <button
            type="button"
            onClick={() => setSentNote(null)}
            className="ml-3 text-[12px] font-semibold underline"
          >
            閉じる
          </button>
        </div>
      ) : null}
      {sendMut.isError ? (
        <p role="alert" className="rounded-md bg-error/10 px-4 py-3 text-body-sm text-error">
          サポート連絡の送信に失敗しました。時間をおいて再試行してください。
        </p>
      ) : null}

      <UserAdminList
        users={users}
        onSupportContact={(u) => {
          setContactTarget(u);
          setSubject("");
          setMessage("");
        }}
      />

      {/* 最近のサポート対応 (モック card 準拠 — audit 逆引きの実データ) */}
      <section
        aria-label="最近のサポート対応"
        className="rounded-lg border border-border bg-white p-5"
      >
        <h3 className="mb-3 text-sm font-bold text-on-surface">
          最近のサポート対応
        </h3>
        {recent.length === 0 ? (
          <p className="py-4 text-center text-body-sm text-on-surface-variant">
            サポート対応の記録はまだありません
          </p>
        ) : (
          <ul className="flex flex-col">
            {recent.map((r, i) => (
              <li
                key={`${r.to_email}-${r.created_at}-${i}`}
                className="flex items-center gap-3 border-b border-border py-2 last:border-b-0"
              >
                <span
                  aria-hidden="true"
                  className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-primary text-[12px] font-bold text-on-primary"
                >
                  {(r.display_name ?? r.to_email).charAt(0).toUpperCase()}
                </span>
                <div className="min-w-0 flex-1">
                  <div className="truncate text-[13px] font-semibold text-on-surface">
                    {r.display_name ?? r.to_email}
                  </div>
                  <div className="truncate text-[12px] text-on-surface-variant">
                    {r.subject}
                  </div>
                </div>
                <span className="shrink-0 text-[12px] tabular-nums text-on-surface-variant">
                  {relTime(r.created_at)}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <Dialog
        open={contactTarget !== null}
        onClose={() => setContactTarget(null)}
        title={`サポート連絡 — ${contactTarget?.email ?? ""}`}
        className="max-w-xl"
        footer={
          <>
            <AdminButton variant="ghost" onClick={() => setContactTarget(null)}>
              キャンセル
            </AdminButton>
            <AdminButton
              variant="primary"
              disabled={!subject.trim() || !message.trim() || sendMut.isPending}
              onClick={() =>
                contactTarget &&
                sendMut.mutate({
                  userId: contactTarget.id,
                  subject: subject.trim(),
                  message,
                })
              }
            >
              {sendMut.isPending ? "送信中…" : "送信する"}
            </AdminButton>
          </>
        }
      >
        <div className="flex flex-col gap-md">
          <Field label="件名" required>
            <input
              type="text"
              value={subject}
              onChange={(e) => setSubject(e.target.value)}
              className="h-10 rounded-md border border-surface-variant bg-surface px-sm text-body-md text-on-surface"
            />
          </Field>
          <Field label="本文" required>
            <textarea
              rows={6}
              value={message}
              onChange={(e) => setMessage(e.target.value)}
              className="rounded-md border border-surface-variant bg-surface px-sm py-sm text-body-md text-on-surface"
            />
          </Field>
        </div>
      </Dialog>
    </div>
  );
}
