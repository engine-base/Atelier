/**
 * GAP-315 — 招待リンクの中身を見せて、参加させる。
 *
 * - 未サインインでも「どのワークスペースに・どの役割で・いつまで」は見える
 *   (見えないと、登録すべきかどうかを判断できない)
 * - 期限切れ / 取り消し / 使用済みは **理由つき**で表示 (410)
 * - 宛先と違うアカウントでサインインしている場合は 403 → その旨を出す
 *   (リンクを拾った別人が入れてしまうと、招待リンクが裏口になる)
 */

"use client";

import * as React from "react";
import { useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useRouter } from "next/navigation";

import { ApiError, type ApiClient } from "@atelier/api-client";

import { Loading } from "../../../../components/Loading";
import { createAuthedApiClient, readAccessToken } from "../../../../lib/auth/connector";

interface Preview {
  readonly workspace_name: string;
  readonly email: string;
  readonly role: string;
  readonly expires_at: string;
  readonly invited_by_name?: string | null;
}

const ROLE_LABEL: Record<string, string> = {
  owner: "オーナー",
  member: "メンバー",
  viewer: "閲覧者",
};

export interface InviteAcceptContainerProps {
  readonly token: string;
  readonly client?: ApiClient;
  /** テスト注入用。既定は cookie の JWT の有無で判定 */
  readonly signedIn?: boolean;
}

function messageOf(err: unknown, fallback: string): string {
  if (err instanceof ApiError) {
    const detail = (err.payload as { detail?: unknown } | undefined)?.detail;
    if (typeof detail === "string" && detail.trim() !== "") return detail;
  }
  return fallback;
}

export function InviteAcceptContainer({
  token,
  client: injected,
  signedIn,
}: InviteAcceptContainerProps) {
  const client = React.useMemo(() => injected ?? createAuthedApiClient(), [injected]);
  const router = useRouter();
  const [joined, setJoined] = useState<string | null>(null);
  const isSignedIn = signedIn ?? readAccessToken() !== null;

  const preview = useQuery({
    queryKey: ["invitation", token],
    queryFn: async () => {
      const res = await client.get("/invitations/{token}", {
        params: { path: { token } },
      });
      return ((res as { data?: unknown }).data ?? null) as Preview | null;
    },
    retry: false,
  });

  const accept = useMutation({
    retry: false,
    mutationFn: async () => {
      const res = await client.post("/invitations/{token}/accept", {
        params: { path: { token } },
      });
      return (res as { data?: { workspace_name?: string } }).data ?? null;
    },
    onSuccess: (d) => {
      setJoined(d?.workspace_name ?? "ワークスペース");
      setTimeout(() => router.push("/projects"), 1200);
    },
  });

  if (preview.isLoading) return <Loading className="py-md" />;

  if (preview.error) {
    return (
      <section className="rounded-lg border border-border bg-surface p-6">
        <h1 className="text-title-md font-bold text-on-surface">招待を開けませんでした</h1>
        <p role="alert" className="mt-2 text-body-md text-error">
          {messageOf(preview.error, "この招待リンクは無効です。")}
        </p>
        <p className="mt-3 text-body-sm text-on-surface-variant">
          招待した方にもう一度送ってもらってください。
        </p>
      </section>
    );
  }

  const p = preview.data;
  if (!p) return null;

  if (joined) {
    return (
      <section className="rounded-lg border border-border bg-surface p-6">
        <h1 className="text-title-md font-bold text-on-surface">参加しました</h1>
        <p role="status" className="mt-2 text-body-md text-on-surface-variant">
          「{joined}」に参加しました。プロジェクト一覧へ移動します。
        </p>
      </section>
    );
  }

  return (
    <section className="rounded-lg border border-border bg-surface p-6">
      <h1 className="text-title-md font-bold text-on-surface">
        「{p.workspace_name}」への招待
      </h1>
      <dl className="mt-4 grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-body-sm">
        <dt className="text-on-surface-variant">招待した人</dt>
        <dd className="text-on-surface">{p.invited_by_name ?? "メンバー"}</dd>
        <dt className="text-on-surface-variant">宛先</dt>
        <dd className="text-on-surface">{p.email}</dd>
        <dt className="text-on-surface-variant">役割</dt>
        <dd className="text-on-surface">{ROLE_LABEL[p.role] ?? p.role}</dd>
        <dt className="text-on-surface-variant">期限</dt>
        <dd className="text-on-surface">{p.expires_at.slice(0, 16).replace("T", " ")}</dd>
      </dl>

      {accept.error ? (
        <p role="alert" className="mt-4 text-body-sm text-error">
          {messageOf(accept.error, "参加できませんでした。時間をおいてお試しください。")}
        </p>
      ) : null}

      {isSignedIn ? (
        <button
          type="button"
          disabled={accept.isPending}
          onClick={() => accept.mutate()}
          className="mt-5 w-full rounded-md bg-primary px-4 py-2 text-sm font-semibold text-on-primary hover:opacity-90 disabled:opacity-50"
        >
          {accept.isPending ? "参加しています…" : "参加する"}
        </button>
      ) : (
        <div className="mt-5 flex flex-col gap-2">
          <p className="text-body-sm text-on-surface-variant">
            参加するには、招待された宛先 ({p.email}) でサインインしてください。
            アカウントがまだ無い場合は、このアドレスで登録してからこのリンクをもう一度開いてください。
          </p>
          <a
            href={`/signin?redirect=${encodeURIComponent(`/invite/${token}`)}`}
            className="rounded-md bg-primary px-4 py-2 text-center text-sm font-semibold text-on-primary hover:opacity-90"
          >
            サインインする
          </a>
          <a
            href={`/signup?redirect=${encodeURIComponent(`/invite/${token}`)}`}
            className="rounded-md border border-border px-4 py-2 text-center text-sm font-semibold text-on-surface hover:border-primary"
          >
            新規登録する
          </a>
        </div>
      )}
    </section>
  );
}
