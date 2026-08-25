/**
 * GAP-021 — S-A03 プランタブ (PlanSection) 配線テスト
 *
 *   - stripe_configured=false → 「決済連携が未設定」表示のみ (アップグレードボタン無し)
 *   - free & configured → 「Pro にアップグレード」→ POST /billing/checkout → 返却 url へ遷移
 *   - ?session_id= 戻り → GET /billing/checkout/{session_id} 照会 → 成功/未完了を誠実表示
 *   - pro → アップグレードボタンを出さない
 *
 * GAP-208 追加: **やめる口**。申し込む口だけがあり、契約したあとに製品内で
 * 解約する手段が無かった (特定商取引法の観点でも成立しない)。
 */

// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";

import * as React from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";
import { type ApiClient, ApiError } from "@atelier/api-client";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createQueryClient } from "../../lib/query-client";
import { PlanSection } from "../../app/auth/s_a03/_components/PlanSection";

function renderWithQuery(ui: React.ReactElement) {
  const qc = createQueryClient();
  return render(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>);
}

function fakeClient(impl: { get?: unknown; post?: unknown }): ApiClient {
  const noop = vi.fn(async () => ({ data: {} }));
  return {
    get: impl.get ?? noop,
    post: impl.post ?? noop,
    patch: noop,
    delete: noop,
    put: noop,
    request: noop,
  } as unknown as ApiClient;
}

afterEach(() => vi.clearAllMocks());

describe("S-A03 PlanSection (GAP-021)", () => {
  it("shows an honest notice and no upgrade button when Stripe is not configured", async () => {
    const get = vi.fn(async () => ({
      data: { plan: "free", status: "inactive", stripe_configured: false },
    }));
    renderWithQuery(
      <PlanSection workspaceId="w1" client={fakeClient({ get })} />,
    );

    expect(
      await screen.findByText(/決済連携が未設定です/),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /アップグレード/ }),
    ).not.toBeInTheDocument();
    // plan は誠実に free 表示
    expect(screen.getByText("Free プラン")).toBeInTheDocument();
  });

  it("upgrades via POST /billing/checkout and navigates to the returned url", async () => {
    const get = vi.fn(async () => ({
      data: { plan: "free", status: "inactive", stripe_configured: true },
    }));
    const post = vi.fn(async () => ({
      data: {
        url: "https://checkout.stripe.com/c/pay/cs_test_1",
        session_id: "cs_test_1",
      },
    }));
    const onNavigate = vi.fn();
    renderWithQuery(
      <PlanSection
        workspaceId="w1"
        client={fakeClient({ get, post })}
        onNavigate={onNavigate}
      />,
    );

    const button = await screen.findByRole("button", {
      name: "Pro にアップグレード",
    });
    fireEvent.click(button);

    await waitFor(() => expect(post).toHaveBeenCalledTimes(1));
    const [postPath, postInit] = post.mock.calls[0]! as unknown as [
      string,
      { body: { workspace_id: string } },
    ];
    expect(postPath).toBe("/billing/checkout");
    expect(postInit.body.workspace_id).toBe("w1");
    await waitFor(() =>
      expect(onNavigate).toHaveBeenCalledWith(
        "https://checkout.stripe.com/c/pay/cs_test_1",
      ),
    );
  });

  it("shows a 503 upgrade failure honestly", async () => {
    const get = vi.fn(async () => ({
      data: { plan: "free", status: "inactive", stripe_configured: true },
    }));
    const post = vi.fn(async () => {
      throw new ApiError({
        status: 503,
        statusText: "Service Unavailable",
        payload: undefined,
        path: "/billing/checkout",
        method: "post",
      });
    });
    renderWithQuery(
      <PlanSection workspaceId="w1" client={fakeClient({ get, post })} />,
    );
    fireEvent.click(
      await screen.findByRole("button", { name: "Pro にアップグレード" }),
    );
    // 5xx は QueryClient 既定で 2 回 retry (計 ~3s) してから fail する
    expect(
      await screen.findByRole("alert", {}, { timeout: 8000 }),
    ).toHaveTextContent("決済連携が未設定のためアップグレードできません。");
  }, 15000);

  it("polls the checkout session on return and reflects a paid result", async () => {
    const get = vi.fn(async (path: string) => {
      if (path === "/billing/checkout/{session_id}") {
        return {
          data: {
            session_id: "cs_test_ok",
            payment_status: "paid",
            status: "complete",
            plan: "pro",
          },
        };
      }
      return {
        data: {
          plan: "pro",
          status: "active",
          stripe_configured: true,
          current_period_end: "2026-09-16T00:00:00Z",
        },
      };
    });
    renderWithQuery(
      <PlanSection
        workspaceId="w1"
        client={fakeClient({ get })}
        checkoutSessionId="cs_test_ok"
      />,
    );

    expect(await screen.findByText(/決済が完了しました/)).toBeInTheDocument();
    const pollCall = get.mock.calls.find(
      (c) => (c as unknown as [string])[0] === "/billing/checkout/{session_id}",
    ) as unknown as
      | [string, { params: { path: { session_id: string } } }]
      | undefined;
    expect(pollCall).toBeDefined();
    expect(pollCall![1].params.path.session_id).toBe("cs_test_ok");
    // pro になったのでアップグレードボタンは出ない
    expect(screen.getByText("Atelier Pro")).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /アップグレード/ }),
    ).not.toBeInTheDocument();
  });

  it("reports an incomplete checkout honestly (no fake success)", async () => {
    const get = vi.fn(async (path: string) => {
      if (path === "/billing/checkout/{session_id}") {
        return {
          data: {
            session_id: "cs_test_open",
            payment_status: "unpaid",
            status: "open",
            plan: "free",
          },
        };
      }
      return {
        data: { plan: "free", status: "inactive", stripe_configured: true },
      };
    });
    renderWithQuery(
      <PlanSection
        workspaceId="w1"
        client={fakeClient({ get })}
        checkoutSessionId="cs_test_open"
      />,
    );

    expect(
      await screen.findByText(/決済はまだ完了していません/),
    ).toBeInTheDocument();
    expect(screen.queryByText(/決済が完了しました/)).not.toBeInTheDocument();
    // free のままなのでアップグレードは引き続き可能
    expect(
      await screen.findByRole("button", { name: "Pro にアップグレード" }),
    ).toBeInTheDocument();
  });

  it("GAP-208: 契約者には解約導線を出し、Stripe のポータルへ送る", async () => {
    const get = vi.fn(async () => ({
      data: { plan: "pro", status: "active", stripe_configured: true },
    }));
    const post = vi.fn(async () => ({
      data: { url: "https://billing.stripe.com/p/session/test_1" },
    }));
    const onNavigate = vi.fn();
    renderWithQuery(
      <PlanSection
        workspaceId="w1"
        client={fakeClient({ get, post })}
        onNavigate={onNavigate}
      />,
    );

    const button = await screen.findByRole("button", {
      name: "プランの管理・解約",
    });
    fireEvent.click(button);
    await waitFor(() => expect(post).toHaveBeenCalled());
    expect(post).toHaveBeenCalledWith("/billing/portal", {
      body: { workspace_id: "w1" },
    });
    await waitFor(() =>
      expect(onNavigate).toHaveBeenCalledWith(
        "https://billing.stripe.com/p/session/test_1",
      ),
    );
    // 返金条件を **押す前に** 書いておく (あとから知らせない)
    expect(screen.getByText(/日割りでの返金はありません/)).toBeInTheDocument();
  });

  it("GAP-208: 無料プランには解約導線を出さない (死にボタンを置かない)", async () => {
    const get = vi.fn(async () => ({
      data: { plan: "free", status: "inactive", stripe_configured: true },
    }));
    renderWithQuery(
      <PlanSection workspaceId="w1" client={fakeClient({ get })} />,
    );
    await screen.findByRole("button", { name: "Pro にアップグレード" });
    expect(
      screen.queryByRole("button", { name: "プランの管理・解約" }),
    ).not.toBeInTheDocument();
  });

  it("GAP-208: ポータルを開けなかったら理由を出す (黙って何も起きないをやめる)", async () => {
    const get = vi.fn(async () => ({
      data: { plan: "pro", status: "active", stripe_configured: true },
    }));
    const post = vi.fn(async () => {
      throw new ApiError({
        status: 409,
        statusText: "Conflict",
        payload: undefined,
        path: "/billing/portal",
        method: "post",
      });
    });
    renderWithQuery(
      <PlanSection workspaceId="w1" client={fakeClient({ get, post })} />,
    );
    fireEvent.click(
      await screen.findByRole("button", { name: "プランの管理・解約" }),
    );
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "有料プランのご契約がありません",
    );
  });

  it("renders the current pro plan with period end and no upgrade button", async () => {
    const get = vi.fn(async () => ({
      data: {
        plan: "pro",
        status: "active",
        stripe_configured: true,
        current_period_end: "2026-09-16T00:00:00Z",
      },
    }));
    renderWithQuery(
      <PlanSection workspaceId="w1" client={fakeClient({ get })} />,
    );

    expect(await screen.findByText("Atelier Pro")).toBeInTheDocument();
    expect(screen.getByText("active")).toBeInTheDocument();
    expect(screen.getByText(/現在の請求期間/)).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /アップグレード/ }),
    ).not.toBeInTheDocument();
  });
});
