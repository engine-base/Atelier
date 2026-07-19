/**
 * T-UC-41 — S-B04 プロジェクト・シークレット コンポーネントテスト (design-audit v2 で新規作成)
 *
 * 監査時点で本画面の web テストが 1 本も無かったため起票を兼ねて整備:
 *   - 一覧: マスク表示 (••••last4) / 作成者列 / 作成日の YYYY-MM-DD 整形
 *   - 表示 (reveal): 平文表示 + コピー/隠す、失敗時の明示エラー
 *   - 削除: 2 段階確認 (確定まで onDelete 不発)
 *   - フォーム: 必須バリデーション / 送信ペイロード / 成功後クリア / 既定種別=トークン (モック準拠)
 */

// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";

import * as React from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  CredentialList,
  type CredentialRow,
} from "../../app/projects/s_b04/_components/CredentialList";
import { CredentialForm } from "../../app/projects/s_b04/_components/CredentialForm";

const ROWS: CredentialRow[] = [
  {
    id: "c1",
    name: "顧客 Slack Bot Token",
    kind: "token",
    last4: "1a2b",
    created_by_name: "三宅",
    created_at: "2026-06-20T09:30:00Z",
  },
  {
    id: "c2",
    name: "本番 DB 接続文字列",
    kind: "connection_string",
    last4: "f9c0",
    created_by_name: null,
    created_at: "2026-06-18T01:00:00Z",
  },
];

afterEach(() => vi.clearAllMocks());

describe("S-B04 CredentialList (T-UC-41)", () => {
  it("renders mask, kind badge, creator, and formatted date", () => {
    render(
      <CredentialList rows={ROWS} onReveal={vi.fn()} onDelete={vi.fn()} />,
    );
    expect(screen.getByText("••••••••1a2b")).toBeInTheDocument();
    expect(screen.getByText("トークン")).toBeInTheDocument();
    expect(screen.getByText("三宅")).toBeInTheDocument();
    // 生 ISO を出さず YYYY-MM-DD (鉄則5: 人間可読)
    expect(screen.getByText("2026-06-20")).toBeInTheDocument();
    expect(screen.queryByText(/T09:30:00/)).not.toBeInTheDocument();
    // 作成者不明は — 表示
    expect(screen.getByText("—")).toBeInTheDocument();
  });

  it("reveal shows plaintext with copy/hide and calls the API once", async () => {
    const onReveal = vi.fn(async () => "xoxb-secret-1a2b");
    render(
      <CredentialList rows={ROWS} onReveal={onReveal} onDelete={vi.fn()} />,
    );
    fireEvent.click(screen.getAllByRole("button", { name: /表示/ })[0]!);
    expect(await screen.findByText("xoxb-secret-1a2b")).toBeInTheDocument();
    expect(onReveal).toHaveBeenCalledWith("c1");
    expect(screen.getByRole("button", { name: "コピー" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "隠す" }));
    expect(screen.queryByText("xoxb-secret-1a2b")).not.toBeInTheDocument();
    expect(screen.getByText("••••••••1a2b")).toBeInTheDocument();
  });

  it("surfaces reveal failure as a visible alert (no silent swallow)", async () => {
    const onReveal = vi.fn(async () => {
      throw new Error("boom");
    });
    render(
      <CredentialList rows={ROWS} onReveal={onReveal} onDelete={vi.fn()} />,
    );
    fireEvent.click(screen.getAllByRole("button", { name: /表示/ })[0]!);
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "復号に失敗しました",
    );
  });

  it("delete requires 2-step confirmation", () => {
    const onDelete = vi.fn();
    render(
      <CredentialList rows={ROWS} onReveal={vi.fn()} onDelete={onDelete} />,
    );
    fireEvent.click(
      screen.getByRole("button", { name: "顧客 Slack Bot Token を削除" }),
    );
    // 1 クリック目では削除しない
    expect(onDelete).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "削除する" }));
    expect(onDelete).toHaveBeenCalledWith("c1");
  });

  it("cancel aborts the delete confirmation", () => {
    const onDelete = vi.fn();
    render(
      <CredentialList rows={ROWS} onReveal={vi.fn()} onDelete={onDelete} />,
    );
    fireEvent.click(
      screen.getByRole("button", { name: "顧客 Slack Bot Token を削除" }),
    );
    fireEvent.click(screen.getByRole("button", { name: "キャンセル" }));
    expect(onDelete).not.toHaveBeenCalled();
    expect(
      screen.getByRole("button", { name: "顧客 Slack Bot Token を削除" }),
    ).toBeInTheDocument();
  });

  it("shows empty state for 0 rows", () => {
    render(<CredentialList rows={[]} onReveal={vi.fn()} onDelete={vi.fn()} />);
    expect(screen.getByText("まだ何も保管されていません。")).toBeInTheDocument();
  });
});

describe("S-B04 CredentialForm (T-UC-41)", () => {
  it("defaults kind to token (mock parity) and validates required fields", async () => {
    const onSubmit = vi.fn();
    render(<CredentialForm onSubmit={onSubmit} />);
    expect((screen.getByLabelText("種別") as HTMLSelectElement).value).toBe(
      "token",
    );
    fireEvent.click(screen.getByRole("button", { name: "暗号化して保存" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "名前と値は必須です。",
    );
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("submits the payload and clears the form on success", async () => {
    const onSubmit = vi.fn(async () => undefined);
    render(<CredentialForm onSubmit={onSubmit} />);
    fireEvent.change(screen.getByLabelText("名称"), {
      target: { value: "Stripe キー" },
    });
    fireEvent.change(screen.getByLabelText("種別"), {
      target: { value: "api_key" },
    });
    fireEvent.change(
      screen.getByLabelText("値（保存後は二度と表示されません）"),
      { target: { value: "sk_live_xyz" } },
    );
    fireEvent.click(screen.getByRole("button", { name: "暗号化して保存" }));
    await waitFor(() =>
      expect(onSubmit).toHaveBeenCalledWith({
        name: "Stripe キー",
        kind: "api_key",
        value: "sk_live_xyz",
      }),
    );
    // 成功後は値を画面に残さない (機密)
    expect(
      (screen.getByLabelText("値（保存後は二度と表示されません）") as HTMLInputElement)
        .value,
    ).toBe("");
    expect((screen.getByLabelText("名称") as HTMLInputElement).value).toBe("");
    expect((screen.getByLabelText("種別") as HTMLSelectElement).value).toBe(
      "token",
    );
  });

  it("shows the server error when submit fails", async () => {
    const onSubmit = vi.fn(async () => {
      throw new Error("保存に失敗しました");
    });
    render(<CredentialForm onSubmit={onSubmit} />);
    fireEvent.change(screen.getByLabelText("名称"), {
      target: { value: "X" },
    });
    fireEvent.change(
      screen.getByLabelText("値（保存後は二度と表示されません）"),
      { target: { value: "v" } },
    );
    fireEvent.click(screen.getByRole("button", { name: "暗号化して保存" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "保存に失敗しました",
    );
  });
});
