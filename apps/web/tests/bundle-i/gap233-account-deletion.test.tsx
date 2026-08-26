/**
 * GAP-233 — 退会 UI が退会の本体 (T-A-05) に配線されていることのテスト。
 *
 * 通し J52 (2026-08-26) で発見: /data-deletion の申請は
 * POST /public/data-deletion-requests (監査ログ記録のみ) しか呼んでおらず、
 * users.deleted_at を立てる POST /auth/account/delete はどの UI からも
 * 呼ばれていなかった。purge ジョブは deleted_at しか見ないため、
 * 「申請から 30 日後にハード削除」という受付表示が嘘になっていた。
 * 復元 (POST /auth/account/restore) も UI から実行不能だった。
 *
 * ここで固定するもの:
 *   1. 申請は password で本人確認し /auth/account/delete を呼ぶ
 *   2. 受付には実際の削除予定日時 (scheduled_purge_at) と復元の案内が出る
 *   3. password 不一致 (401) は受付を出さず理由を明示する
 *   4. 復元フォームは email + password を渡す
 */

// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";

import * as React from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type * as Connector from "../../lib/auth/connector";

const getJson = vi.fn();
const sendJson = vi.fn();
const clearLocalSession = vi.fn();
vi.mock("../../lib/auth/connector", async () => {
  const actual = await vi.importActual<typeof Connector>(
    "../../lib/auth/connector",
  );
  return {
    ...actual,
    getJson: (...args: unknown[]) => getJson(...(args as [])),
    sendJson: (...args: unknown[]) => sendJson(...(args as [])),
    clearLocalSession: () => clearLocalSession(),
  };
});

import { ApiError } from "../../lib/auth/connector";
import { DataDeletionContainer } from "../../app/public/s_pub04/_components/DataDeletionContainer";
import { RestoreForm } from "../../app/auth/s_a01/_components/RestoreForm";

afterEach(() => {
  getJson.mockReset();
  sendJson.mockReset();
  clearLocalSession.mockReset();
});

async function fillAndSubmit(password: string): Promise<void> {
  fireEvent.change(
    screen.getByLabelText("本人確認のためパスワードを入力してください", {
      exact: false,
    }),
    { target: { value: password } },
  );
  fireEvent.change(screen.getByPlaceholderText("削除する"), {
    target: { value: "削除する" },
  });
  fireEvent.click(screen.getByRole("checkbox"));
  fireEvent.click(screen.getByRole("button", { name: "削除を申請する" }));
}

describe("GAP-233 退会が本体 (T-A-05) に配線されている", () => {
  it("申請は password つきで /auth/account/delete を呼び、実際の削除予定日時と復元案内を出す", async () => {
    getJson.mockResolvedValue({ data: { email: "taro@example.com" } });
    sendJson.mockResolvedValue({
      user_id: "u-1",
      scheduled_purge_at: "2026-09-25T15:00:00+00:00",
      deleted_at: "2026-08-26T15:00:00+00:00",
    });

    render(<DataDeletionContainer />);
    await screen.findByPlaceholderText("削除する");
    await fillAndSubmit("correct-password");

    await screen.findByText("削除申請を受け付けました");
    expect(sendJson).toHaveBeenCalledWith("POST", "/auth/account/delete", {
      password: "correct-password",
      reason: undefined,
    });
    // 監査記録だけの endpoint に落ちていない (これが GAP-233 の本体)
    expect(sendJson).not.toHaveBeenCalledWith(
      "POST",
      "/public/data-deletion-requests",
      expect.anything(),
    );
    // 実際の削除予定日時と、実行可能な取り消し手段 (復元) の案内
    expect(screen.getByText(/削除予定日時/)).toBeInTheDocument();
    expect(screen.getByText(/退会済みアカウントの復元/)).toBeInTheDocument();
    // 退会後のセッションは手放す
    expect(clearLocalSession).toHaveBeenCalled();
  });

  it("password 不一致 (401) は受付を出さず、理由を明示する", async () => {
    getJson.mockResolvedValue({ data: { email: "taro@example.com" } });
    sendJson.mockRejectedValue(new ApiError("unauthorized", 401));

    render(<DataDeletionContainer />);
    await screen.findByPlaceholderText("削除する");
    await fillAndSubmit("wrong-password");

    await screen.findByText("パスワードが正しくありません。");
    expect(screen.queryByText("削除申請を受け付けました")).toBeNull();
    expect(clearLocalSession).not.toHaveBeenCalled();
  });

  it("復元フォームは email + password を onSubmit に渡す", async () => {
    const onSubmit = vi.fn();
    render(<RestoreForm onSubmit={onSubmit} />);

    fireEvent.change(screen.getByLabelText("メールアドレス", { exact: false }), {
      target: { value: "taro@example.com" },
    });
    fireEvent.change(screen.getByLabelText("パスワード", { exact: false }), {
      target: { value: "pw-123456" },
    });
    fireEvent.click(
      screen.getByRole("button", { name: "アカウントを復元する" }),
    );

    await waitFor(() =>
      expect(onSubmit).toHaveBeenCalledWith(
        expect.objectContaining({
          email: "taro@example.com",
          password: "pw-123456",
        }),
        expect.anything(),
      ),
    );
  });
});
