/**
 * S-L02 クライアントサインイン コンテナ — T-UC-21 (R-T08) / GAP-028
 *
 * ClientSigninForm の onSubmit を実 /client/auth/signin に配線。成功で
 * client_portal cookie を設定し /portal?project={id} へ遷移。
 * 401(invalid_token)/410(expired) を文言化して表示。
 *
 * GAP-028: URL トークンがあるとき実 /client/auth/preview で署名前プレビュー
 * (招待元名・プロジェクト名・招待先メール・残り日数) を取得し、モックの
 * greeting-card / project-card / 招待先メール欄 / 実「残り N 日」を描画する。
 * プレビュー未取得 (トークン無し・API 未到達) は汎用文言のまま (推測しない)。
 * signin / preview / 遷移はテスト用に注入可能。
 */

"use client";

import * as React from "react";
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";

import { ClientSigninForm, type ClientSigninValues } from "./ClientSigninForm";
import {
  clientSignin as defaultClientSignin,
  clientInvitationPreview as defaultPreview,
  ClientPortalError,
  type ClientInvitationPreviewData,
  type ClientSigninConsents,
  type ClientSigninResult,
} from "../../../../lib/auth/client-portal";

export interface ClientSigninContainerProps {
  readonly defaultToken?: string;
  /** テスト用に注入可能。既定は実 API の clientSignin。 */
  readonly signinFn?: (
    token: string,
    displayName?: string,
    consents?: ClientSigninConsents,
  ) => Promise<ClientSigninResult>;
  /** テスト用に注入可能。既定は実 API の clientInvitationPreview。 */
  readonly previewFn?: (token: string) => Promise<ClientInvitationPreviewData>;
  /** サインイン成功時の遷移。既定は /portal?project={id} へ push。 */
  readonly onSignedIn?: (projectId: string) => void;
}

/** API の detail (user_messages の日本語) をそのまま使える形か。`HTTP 401` や英語の内部コードは除く。 */
function apiDetail(error: ClientPortalError): string | null {
  const m = error.message.trim();
  return /[\u3040-\u30ff\u4e00-\u9fff]/.test(m) ? m : null;
}

function messageFor(error: unknown): string {
  if (error instanceof ClientPortalError) {
    // GAP-251: 取り消し / 削除済み / リンク誤りは API が理由を言い分ける。画面で 1 文に潰さない
    if (error.status === 401)
      return apiDetail(error) ?? "招待トークンが無効です。リンクをご確認ください。";
    if (error.status === 410)
      return "招待の有効期限が切れています。再発行を依頼してください。";
    return "サインインに失敗しました。時間をおいて再度お試しください。";
  }
  return "通信エラーが発生しました。接続を確認してください。";
}

/** モック .greeting-card / .project-card 準拠の招待グリーティング。 */
function GreetingCard({
  preview,
}: {
  readonly preview: ClientInvitationPreviewData | null;
}) {
  const inviterLine = preview
    ? `${preview.inviter_name ?? preview.workspace_name} さんから以下のプロジェクトへ招待されました。`
    : null;
  const avatarInitial = (
    preview?.inviter_name ??
    preview?.workspace_name ??
    ""
  ).charAt(0);
  return (
    <div className="mb-4 rounded-lg bg-[linear-gradient(135deg,var(--color-primary-container)_0%,var(--color-tertiary-container)_100%)] px-8 py-7 text-center">
      <div className="mb-2 text-[11px] font-bold uppercase tracking-[0.14em] text-on-primary-container opacity-[0.85]">
        Client Portal
      </div>
      <h1 className="mb-2.5 text-[22px] font-bold tracking-[-0.02em] text-on-primary-container">
        ご招待ありがとうございます
      </h1>
      {preview ? (
        <>
          <p className="text-[13px] text-on-primary-container opacity-90">
            {inviterLine}
          </p>
          {/* モック .project-card: プロジェクト名 + 招待元 (人 · 組織) */}
          <div className="mt-3 rounded-md bg-white/85 px-4 py-3 text-left">
            <div className="text-[12px] text-on-surface-variant">
              プロジェクト
            </div>
            <div className="mb-2 text-[15px] font-bold text-on-surface">
              {preview.project_name}
            </div>
            <div className="flex items-center gap-2 text-[13px] text-on-surface">
              <span
                aria-hidden="true"
                className="flex h-6 w-6 items-center justify-center rounded-full bg-primary-container text-[11px] font-bold text-on-primary-container"
              >
                {avatarInitial}
              </span>
              <span>
                {preview.inviter_name
                  ? `${preview.inviter_name} · ${preview.workspace_name}`
                  : preview.workspace_name}
              </span>
            </div>
          </div>
        </>
      ) : (
        <p className="text-[13px] text-on-primary-container opacity-90">
          プロジェクトのクライアントポータルへの招待が届いています。
          <br />
          下のフォームからサインインすると、招待されたプロジェクトが表示されます。
        </p>
      )}
    </div>
  );
}

export function ClientSigninContainer({
  defaultToken,
  signinFn = defaultClientSignin,
  previewFn = defaultPreview,
  onSignedIn,
}: ClientSigninContainerProps) {
  const router = useRouter();
  const [serverError, setServerError] = useState<string | null>(null);
  const [preview, setPreview] = useState<ClientInvitationPreviewData | null>(
    null,
  );
  const [previewError, setPreviewError] = useState<string | null>(null);

  useEffect(() => {
    if (!defaultToken || defaultToken.length < 10) return;
    let cancelled = false;
    previewFn(defaultToken)
      .then((data) => {
        if (!cancelled) setPreview(data);
      })
      .catch((error: unknown) => {
        // 無効/期限切れは署名前に誠実に表示。通信失敗は汎用カードに留める
        // (プレビューは補助情報 — サインイン自体は妨げない)
        if (cancelled) return;
        if (
          error instanceof ClientPortalError &&
          (error.status === 401 || error.status === 410)
        )
          setPreviewError(messageFor(error));
      });
    return () => {
      cancelled = true;
    };
  }, [defaultToken, previewFn]);

  const onSubmit = async (v: ClientSigninValues): Promise<void> => {
    setServerError(null);
    try {
      const result = await signinFn(v.invitation_token, v.display_name, {
        agreeLegal: v.agree_legal,
        agreeConfidential: v.agree_confidential,
      });
      if (onSignedIn) onSignedIn(result.project.id);
      else
        router.push(
          `/portal?project=${encodeURIComponent(result.project.id)}`,
        );
    } catch (error) {
      setServerError(messageFor(error));
    }
  };

  return (
    <div>
      <GreetingCard preview={preview} />
      {previewError ? (
        <p
          role="alert"
          className="mb-4 rounded-md border border-error/30 bg-white px-4 py-3 text-[13px] font-semibold text-error"
        >
          {previewError}
        </p>
      ) : null}
      <ClientSigninForm
        defaultToken={defaultToken}
        preview={preview}
        onSubmit={onSubmit}
        serverError={serverError}
      />
    </div>
  );
}
