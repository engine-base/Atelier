/**
 * S-L01 クライアント招待管理 コンテナ — T-UC-20 (実 client-invitations API 配線)
 *
 * GET /client-invitations?project_id 一覧、POST /client-invitations 発行、
 * POST /client-invitations/{id}/revoke 失効。発行時のみ返る raw token を 1 度だけ
 * バナー表示（R-T08: 再取得不可）。status は used_at/revoked_at/expires_at から導出。
 * 再送 API は存在しないため再送ボタンは出さない。api client は prop 注入可能。
 */

"use client";

import * as React from "react";
import { Loading } from "../../../../components/Loading";
import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { ApiError, type ApiClient } from "@atelier/api-client";

import { createAuthedApiClient } from "../../../../lib/auth/connector";
import {
  InvitationsList,
  type Invitation,
  type InvitationStatus,
} from "./InvitationsList";

interface ApiInvitation {
  id: string;
  email: string;
  expires_at: string;
  used_at?: string | null;
  revoked_at?: string | null;
}

const KEY = (projectId: string) => ["client-invitations", projectId] as const;

function deriveStatus(inv: ApiInvitation): InvitationStatus {
  if (inv.revoked_at) return "revoked";
  if (inv.used_at) return "used";
  if (new Date(inv.expires_at).getTime() < Date.now()) return "expired";
  return "pending";
}

export interface InvitationsListContainerProps {
  readonly projectId: string;
  readonly client?: ApiClient;
}

function isForbidden(error: unknown): boolean {
  return error instanceof ApiError && error.status === 403;
}

export function InvitationsListContainer({
  projectId,
  client: injected,
}: InvitationsListContainerProps) {
  const client = useMemo(() => injected ?? createAuthedApiClient(), [injected]);
  const queryClient = useQueryClient();
  const [issuedToken, setIssuedToken] = useState<string | null>(null);

  const list = useQuery({
    queryKey: KEY(projectId),
    queryFn: async () => {
      const res = await client.get("/client-invitations", {
        params: { query: { project_id: projectId } },
      });
      return (res as { data?: ApiInvitation[] }).data ?? [];
    },
    retry: false,
  });

  const issueMut = useMutation({
    mutationFn: async (email: string) => {
      const res = await client.post("/client-invitations", {
        body: { project_id: projectId, email },
      });
      return (res as { data?: { token?: string } }).data ?? {};
    },
    onSuccess: (data) => {
      if (data.token) setIssuedToken(data.token);
      void queryClient.invalidateQueries({ queryKey: KEY(projectId) });
    },
  });

  const revokeMut = useMutation({
    mutationFn: (id: string) =>
      client.post("/client-invitations/{invitation_id}/revoke", {
        params: { path: { invitation_id: id } },
      }),
    // 楽観更新: revoked_at を即座に付与、失敗時に戻す。
    onMutate: async (id) => {
      const key = KEY(projectId);
      await queryClient.cancelQueries({ queryKey: key });
      const prev = queryClient.getQueryData<ApiInvitation[]>(key);
      queryClient.setQueryData<ApiInvitation[]>(key, (old) =>
        (old ?? []).map((inv) =>
          inv.id === id
            ? { ...inv, revoked_at: new Date().toISOString() }
            : inv,
        ),
      );
      return { prev };
    },
    onError: (_e, _id, ctx) => {
      if (ctx?.prev) queryClient.setQueryData(KEY(projectId), ctx.prev);
    },
    onSettled: () =>
      void queryClient.invalidateQueries({ queryKey: KEY(projectId) }),
  });

  if (isForbidden(list.error)) {
    return (
      <p role="alert" className="text-body-md text-error">
        クライアント招待を管理する権限がありません。
      </p>
    );
  }
  if (list.error) {
    return (
      <p role="alert" className="text-body-md text-error">
        招待一覧の取得に失敗しました。
      </p>
    );
  }
  if (list.isLoading) {
    return <Loading className="py-md" />;
  }

  const invitations: Invitation[] = (list.data ?? []).map((inv) => ({
    id: inv.id,
    email: inv.email,
    status: deriveStatus(inv),
    expires_at: inv.expires_at.slice(0, 10),
  }));

  return (
    <div className="flex flex-col gap-6">
      {issuedToken ? (
        <div
          role="status"
          className="rounded-md border-l-[3px] border-primary bg-primary-container p-4 text-body-sm text-primary-container-fg"
        >
          <p className="font-semibold">
            招待リンク（この画面でのみ表示・再取得不可）
          </p>
          <p className="mt-1 text-[12px] opacity-90">
            クライアントにこのリンクを共有してください。メール送信が設定済みの環境では
            自動送信もされますが、確実に届けるには下のリンクを直接お渡しください。
          </p>
          {(() => {
            const origin =
              typeof window !== "undefined" ? window.location.origin : "";
            const link = `${origin}/portal/signin?token=${encodeURIComponent(issuedToken)}`;
            return (
              <>
                <code className="mt-2 block break-all font-mono text-[13px]">
                  {link}
                </code>
                <div className="mt-2 flex gap-3">
                  <button
                    type="button"
                    onClick={() => {
                      void navigator.clipboard?.writeText(link).catch(() => undefined);
                    }}
                    className="text-label-md font-semibold text-primary-container-fg underline"
                  >
                    リンクをコピー
                  </button>
                  <button
                    type="button"
                    onClick={() => setIssuedToken(null)}
                    className="text-label-md font-semibold text-primary-container-fg underline"
                  >
                    閉じる
                  </button>
                </div>
              </>
            );
          })()}
        </div>
      ) : null}
      <InvitationsList
        invitations={invitations}
        onIssue={(email) => issueMut.mutate(email)}
        onRevoke={(id) => revokeMut.mutate(id)}
      />
    </div>
  );
}
