/**
 * S-J01 承認インボックス コンテナ — T-UC-17 系 (実 approval-inbox API 配線)
 *
 * GET /approval-inbox で本人の承認待ち 5 種統合一覧を取得し、
 * POST /approval-inbox/{id}/decide {decision} で承認 / 差戻 → 再取得。
 * api client は prop 注入可能 (テスト時に fake を渡す)。
 */

"use client";

import * as React from "react";
import { useMemo } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { ApiError, type ApiClient } from "@atelier/api-client";

import { createAuthedApiClient } from "../../../../lib/auth/connector";
import {
  ApprovalsList,
  type ApprovalKind,
  type ApprovalRow,
} from "./ApprovalsList";

const KINDS: readonly ApprovalKind[] = [
  "task",
  "output",
  "publish",
  "refund",
  "access",
];
const KEY = ["approval-inbox"] as const;

interface ApiApproval {
  id: string;
  type: string;
  title: string;
  payload?: Record<string, unknown>;
  created_at: string;
}

function toKind(type: string): ApprovalKind {
  return (KINDS as readonly string[]).includes(type)
    ? (type as ApprovalKind)
    : "task";
}

function requesterOf(payload: Record<string, unknown> | undefined): string {
  const r =
    payload?.requested_by ?? payload?.actor ?? payload?.assigned_employee_id;
  return typeof r === "string" && r ? r : "—";
}

export interface ApprovalsContainerProps {
  readonly client?: ApiClient;
}

function isForbidden(error: unknown): boolean {
  return error instanceof ApiError && error.status === 403;
}

export function ApprovalsContainer({
  client: injected,
}: ApprovalsContainerProps) {
  const client = useMemo(() => injected ?? createAuthedApiClient(), [injected]);
  const queryClient = useQueryClient();

  const list = useQuery({
    queryKey: KEY,
    queryFn: async () => {
      const res = await client.get("/approval-inbox");
      return (res as { data?: ApiApproval[] }).data ?? [];
    },
    retry: false,
  });

  const decideMut = useMutation({
    mutationFn: (vars: { id: string; decision: "approve" | "reject" }) =>
      client.post("/approval-inbox/{approval_id}/decide", {
        params: { path: { approval_id: vars.id } },
        body: { decision: vars.decision },
      }),
    // 楽観更新: 決裁した項目を即座にインボックスから除外。失敗時は元に戻す。
    onMutate: async (vars) => {
      await queryClient.cancelQueries({ queryKey: KEY });
      const prev = queryClient.getQueryData<ApiApproval[]>(KEY);
      queryClient.setQueryData<ApiApproval[]>(KEY, (old) =>
        (old ?? []).filter((a) => a.id !== vars.id),
      );
      return { prev };
    },
    onError: (_e, _vars, ctx) => {
      if (ctx?.prev) queryClient.setQueryData(KEY, ctx.prev);
    },
    onSettled: () => void queryClient.invalidateQueries({ queryKey: KEY }),
  });

  if (isForbidden(list.error)) {
    return (
      <p role="alert" className="text-body-md text-error">
        承認インボックスにアクセスする権限がありません。
      </p>
    );
  }
  if (list.error) {
    return (
      <p role="alert" className="text-body-md text-error">
        承認待ちの取得に失敗しました。
      </p>
    );
  }
  if (list.isLoading) {
    return <p className="text-body-md text-on-surface-variant">読み込み中…</p>;
  }

  const items = list.data ?? [];
  if (items.length === 0) {
    return (
      <p className="text-body-md text-on-surface-variant">
        承認待ちはありません。
      </p>
    );
  }

  const rows: ApprovalRow[] = items.map((a) => ({
    id: a.id,
    kind: toKind(a.type),
    title: a.title,
    requester: requesterOf(a.payload),
    created_at: a.created_at.slice(0, 10),
  }));

  return (
    <ApprovalsList
      rows={rows}
      onApprove={(id) => decideMut.mutate({ id, decision: "approve" })}
      onReject={(id) => decideMut.mutate({ id, decision: "reject" })}
    />
  );
}
