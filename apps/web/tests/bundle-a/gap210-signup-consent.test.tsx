/**
 * GAP-210 — 登録時の同意記録と、同意文の見え方。
 *
 * 通しの検証 (.qa/journey-20260825) で見つけた 3 件を固定する:
 *   ① 同意記録の版が **その人が読んだ文書の版** であること
 *      (以前は `new Date()` の日付を入れていたため、どの文面に同意したか
 *       記録から特定できず、登録直後の人に再同意の帯が出ていた)
 *   ② 同意文に **社内の課題番号を出さない**
 *   ③ 入力エラーが **日本語** で出る (zod の既定は英語)
 */

import * as React from "react";
import "@testing-library/jest-dom/vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

void React;

import { SignupForm } from "../../app/auth/s_a01/_components/SignupForm";
import { signup } from "../../lib/auth/connector";

afterEach(() => vi.unstubAllGlobals());

const LEGAL = {
  data: [
    { doc_type: "terms_of_service", version: "2026-08-22" },
    { doc_type: "privacy_policy", version: "2026-08-22" },
    { doc_type: "tokushoho", version: "2026-08-22" },
  ],
};

/** fetch を差し替えて、呼ばれた URL と body を記録する。 */
function stubFetch(legalOk = true) {
  const calls: { url: string; body: unknown }[] = [];
  const impl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    if (url.includes("/public/legal-documents")) {
      return new Response(legalOk ? JSON.stringify(LEGAL) : "boom", {
        status: legalOk ? 200 : 503,
        headers: { "content-type": "application/json" },
      });
    }
    if (url.includes("/auth/signup")) {
      return new Response(JSON.stringify({ data: {} }), {
        status: 201,
        headers: { "content-type": "application/json" },
      });
    }
    // signin
    return new Response(
      JSON.stringify({
        data: { access_token: "a.b.c", expires_at: "2099-01-01T00:00:00Z", user_id: "u", email: "e" },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  });
  vi.stubGlobal("fetch", impl);
  return calls;
}

describe("GAP-210 ① 同意記録は「読んだ版」を送る", () => {
  it("signup が現行の法務文書の版を同意記録に載せる (日付ではない)", async () => {
    const calls = stubFetch();
    await signup("who@example.com", "strong-password-2026");

    const su = calls.find((c) => c.url.includes("/auth/signup"));
    expect(su, "signup が呼ばれている").toBeTruthy();
    const consents = (su!.body as { consents: { type: string; version: string }[] }).consents;
    const byType = Object.fromEntries(consents.map((c) => [c.type, c.version]));

    expect(byType["terms_of_service"]).toBe("2026-08-22");
    expect(byType["privacy_policy"]).toBe("2026-08-22");

    // 「今日の日付」を入れていた退行を直接禁止する
    const today = new Date().toISOString().slice(0, 10);
    for (const c of consents) {
      expect(c.version, "同意の版に登録日を入れてはいけない").not.toBe(today);
    }
  });

  it("版を取得できないときは登録を止める (日付で代用しない)", async () => {
    stubFetch(false);
    await expect(signup("who@example.com", "strong-password-2026")).rejects.toThrow();
  });

  it("AI 学習は既定 OFF のまま (絶対ルール #6)", async () => {
    const calls = stubFetch();
    await signup("who@example.com", "strong-password-2026");
    const su = calls.find((c) => c.url.includes("/auth/signup"));
    const consents = (su!.body as { consents: { type: string; accepted: boolean }[] }).consents;
    expect(consents.find((c) => c.type === "ai_training_optin")?.accepted).toBe(false);
  });
});

describe("GAP-210 ② 同意文に社内の課題番号を出さない", () => {
  it("同意チェックの文言に GAP-xxx が含まれない", () => {
    render(<SignupForm onSubmit={vi.fn()} />);
    const box = screen.getByRole("checkbox");
    const label = box.closest("label");
    expect(label).toBeTruthy();
    expect(label!.textContent ?? "").not.toMatch(/GAP-\d+/);
  });

  it("越境同意の説明そのものは残っている (番号だけ消した)", () => {
    render(<SignupForm onSubmit={vi.fn()} />);
    const label = screen.getByRole("checkbox").closest("label")!;
    expect(label.textContent).toContain("越境同意");
    expect(label.textContent).toContain("Anthropic");
    expect(label.textContent).toContain("外部送信されません");
  });
});

describe("GAP-210 ③ 入力エラーは日本語で出る", () => {
  it("パスワード確認が空のとき、英語の zod 既定メッセージを出さない", async () => {
    render(<SignupForm onSubmit={vi.fn()} />);
    fireEvent.change(screen.getByLabelText(/メールアドレス/), {
      target: { value: "a@example.com" },
    });
    // 「パスワード」と「パスワード確認」の 2 つが一致するので name で特定する
    fireEvent.change(document.querySelector('input[name="password"]')!, {
      target: { value: "strong-password-2026" },
    });
    fireEvent.click(screen.getByRole("button", { name: "新規登録" }));

    const alerts = await screen.findAllByRole("alert");
    const text = alerts.map((a) => a.textContent ?? "").join(" ");
    expect(text).not.toContain("String must contain");
    expect(text).toContain("パスワード確認を入力してください");
  });
});
