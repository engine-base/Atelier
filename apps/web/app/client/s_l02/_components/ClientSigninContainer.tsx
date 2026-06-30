/**
 * S-L02 クライアントサインイン コンテナ — T-UC-21 (R-T08)
 *
 * ClientSigninForm の onSubmit を実 /client/auth/signin に配線。成功で
 * client_portal cookie を設定し /client/s_l03?project={id} へ遷移。
 * 401(invalid_token)/410(expired) を文言化して表示。
 * signin / 遷移はテスト用に注入可能。
 */

"use client";

import * as React from "react";
import { useState } from "react";
import { useRouter } from "next/navigation";

import { ClientSigninForm, type ClientSigninValues } from "./ClientSigninForm";
import {
  clientSignin as defaultClientSignin,
  ClientPortalError,
  type ClientSigninResult,
} from "../../../../lib/auth/client-portal";

export interface ClientSigninContainerProps {
  readonly defaultToken?: string;
  /** テスト用に注入可能。既定は実 API の clientSignin。 */
  readonly signinFn?: (
    token: string,
    displayName?: string,
  ) => Promise<ClientSigninResult>;
  /** サインイン成功時の遷移。既定は /client/s_l03?project={id} へ push。 */
  readonly onSignedIn?: (projectId: string) => void;
}

function messageFor(error: unknown): string {
  if (error instanceof ClientPortalError) {
    if (error.status === 401)
      return "招待トークンが無効です。リンクをご確認ください。";
    if (error.status === 410)
      return "招待の有効期限が切れています。再発行を依頼してください。";
    return "サインインに失敗しました。時間をおいて再度お試しください。";
  }
  return "通信エラーが発生しました。接続を確認してください。";
}

export function ClientSigninContainer({
  defaultToken,
  signinFn = defaultClientSignin,
  onSignedIn,
}: ClientSigninContainerProps) {
  const router = useRouter();
  const [serverError, setServerError] = useState<string | null>(null);

  const onSubmit = async (v: ClientSigninValues): Promise<void> => {
    setServerError(null);
    try {
      const result = await signinFn(v.invitation_token, v.display_name);
      if (onSignedIn) onSignedIn(result.project.id);
      else
        router.push(
          `/client/s_l03?project=${encodeURIComponent(result.project.id)}`,
        );
    } catch (error) {
      setServerError(messageFor(error));
    }
  };

  return (
    <ClientSigninForm
      defaultToken={defaultToken}
      onSubmit={onSubmit}
      serverError={serverError}
    />
  );
}
