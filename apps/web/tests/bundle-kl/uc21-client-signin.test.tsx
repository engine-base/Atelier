/**
 * T-UC-21 — S-L02 クライアントサインイン 配線テスト
 *
 *   - signin 成功 → onSignedIn(project.id) + 同意 2 種をサーバーへ送信 (GAP-028)
 *   - 401 invalid_token / 410 expired を文言化
 *   - 署名前プレビュー (GAP-028): 実メタ描画 / 無効トークンの誠実表示
 */

// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";

import * as React from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn() }),
}));

import { ClientSigninContainer } from "../../app/client/s_l02/_components/ClientSigninContainer";
import {
  ClientPortalError,
  type ClientInvitationPreviewData,
  type ClientSigninResult,
} from "../../lib/auth/client-portal";

const OK: ClientSigninResult = {
  client_access_token: "ct",
  expires_at: "2999-01-01T00:00:00Z",
  project: { id: "proj-9", name: "ACME" },
  scopes: ["view"],
};

const PREVIEW: ClientInvitationPreviewData = {
  project_name: "小松様 EC モール統合",
  workspace_name: "ENGINE BASE",
  inviter_name: "高本まさと",
  invited_email: "komatsu@matsuride.com",
  expires_at: "2999-01-05T00:00:00Z",
  remaining_days: 4,
};

/** preview 未取得のまま進めるスタブ (通信失敗 → 汎用カードに留まる)。 */
const noPreview = vi.fn(async (): Promise<ClientInvitationPreviewData> => {
  throw new Error("network");
});

afterEach(() => vi.clearAllMocks());

describe("S-L02 ClientSigninContainer (T-UC-21)", () => {
  it("signs in, forwards both consents (GAP-028), and calls onSignedIn", async () => {
    const signinFn = vi.fn(async (..._args: unknown[]) => OK);
    const onSignedIn = vi.fn();
    render(
      <ClientSigninContainer
        defaultToken="tok-1234567890"
        signinFn={signinFn}
        previewFn={noPreview}
        onSignedIn={onSignedIn}
      />,
    );
    // 同意 2 種 (design-audit v2: モックの consent-row) をチェックしてから送信
    for (const cb of screen.getAllByRole("checkbox")) fireEvent.click(cb);
    fireEvent.click(
      screen.getByRole("button", { name: "同意してサインイン" }),
    );
    await waitFor(() =>
      expect(signinFn).toHaveBeenCalledWith("tok-1234567890", "", {
        agreeLegal: true,
        agreeConfidential: true,
      }),
    );
    expect(onSignedIn).toHaveBeenCalledWith("proj-9");
  });

  it("shows an invalid-token message on 401", async () => {
    const signinFn = vi.fn(async (..._args: unknown[]): Promise<ClientSigninResult> => {
      throw new ClientPortalError("invalid", 401);
    });
    render(
      <ClientSigninContainer
        defaultToken="tok-1234567890"
        signinFn={signinFn}
        previewFn={noPreview}
        onSignedIn={vi.fn()}
      />,
    );
    for (const cb of screen.getAllByRole("checkbox")) fireEvent.click(cb);
    fireEvent.click(
      screen.getByRole("button", { name: "同意してサインイン" }),
    );
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "招待トークンが無効です",
    );
  });

  it("shows an expired message on 410", async () => {
    const signinFn = vi.fn(async (..._args: unknown[]): Promise<ClientSigninResult> => {
      throw new ClientPortalError("expired", 410);
    });
    render(
      <ClientSigninContainer
        defaultToken="tok-1234567890"
        signinFn={signinFn}
        previewFn={noPreview}
        onSignedIn={vi.fn()}
      />,
    );
    for (const cb of screen.getAllByRole("checkbox")) fireEvent.click(cb);
    fireEvent.click(
      screen.getByRole("button", { name: "同意してサインイン" }),
    );
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "有効期限が切れています",
    );
  });

  it("renders the signed-out invitation preview (GAP-028)", async () => {
    const previewFn = vi.fn(async () => PREVIEW);
    render(
      <ClientSigninContainer
        defaultToken="tok-1234567890"
        signinFn={vi.fn(async (..._args: unknown[]) => OK)}
        previewFn={previewFn}
        onSignedIn={vi.fn()}
      />,
    );
    await waitFor(() => expect(previewFn).toHaveBeenCalledWith("tok-1234567890"));
    // greeting-card: 招待元 + プロジェクトカード (モック準拠)
    expect(
      await screen.findByText(
        "高本まさと さんから以下のプロジェクトへ招待されました。",
      ),
    ).toBeInTheDocument();
    expect(screen.getByText("小松様 EC モール統合")).toBeInTheDocument();
    expect(screen.getByText("高本まさと · ENGINE BASE")).toBeInTheDocument();
    // 有効期限バー: 実「残り 4 日」
    expect(screen.getByText("残り 4 日")).toBeInTheDocument();
    // 招待先メール (disabled)
    const email = screen.getByDisplayValue("komatsu@matsuride.com");
    expect(email).toBeDisabled();
  });

  it("shows an honest error when the previewed token is invalid (401)", async () => {
    const previewFn = vi.fn(async (): Promise<ClientInvitationPreviewData> => {
      throw new ClientPortalError("invalid", 401);
    });
    render(
      <ClientSigninContainer
        defaultToken="tok-1234567890"
        signinFn={vi.fn(async (..._args: unknown[]) => OK)}
        previewFn={previewFn}
        onSignedIn={vi.fn()}
      />,
    );
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "招待トークンが無効です",
    );
    // プレビューカードは出さず汎用文言のまま (推測で埋めない)
    expect(
      screen.queryByText(/さんから以下のプロジェクトへ招待されました/),
    ).not.toBeInTheDocument();
  });
});
