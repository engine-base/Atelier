/**
 * S-T04 ユーザー管理 コンテナ — T-UC-33 (実 admin API 配線)
 *
 * GET /admin/users（運営 admin: 所属 workspace 横断メンバー・read-only）を取得し
 * UserAdminList に渡す。停止/復元 API は未提供のため read-only 表示（アクション列なし）。
 * API は state/last_login を持たないため state='active'（停止機能なし）・last_login=null とする。
 * api client は prop 注入可能 (テスト時に fake を渡す)。
 */

"use client";

import * as React from "react";
import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";

import { ApiError, type ApiClient } from "@atelier/api-client";

import { createAuthedApiClient } from "../../../../lib/auth/connector";
import { UserAdminList, type AdminUser } from "./UserAdminList";

interface ApiUser {
  user_id: string;
  email: string;
  display_name?: string | null;
}

export interface UserAdminContainerProps {
  readonly client?: ApiClient;
}

function isForbidden(error: unknown): boolean {
  return error instanceof ApiError && error.status === 403;
}

export function UserAdminContainer({
  client: injected,
}: UserAdminContainerProps) {
  const client = useMemo(() => injected ?? createAuthedApiClient(), [injected]);

  const list = useQuery({
    queryKey: ["admin", "users"],
    queryFn: async () => {
      const res = await client.get("/admin/users");
      return (res as { data?: ApiUser[] }).data ?? [];
    },
    retry: false,
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
    return <p className="text-body-md text-surface">読み込み中…</p>;
  }

  const users: AdminUser[] = (list.data ?? []).map((u) => ({
    id: u.user_id,
    email: u.email,
    state: "active",
    last_login: null,
  }));

  return <UserAdminList users={users} />;
}
