/**
 * T-UC-02 — S-A03 ワークスペース設定 配線テスト
 *
 *   - GET /workspaces/{id} で名称をフォームに反映
 *   - 保存で PATCH /workspaces/{id} {name} + POST /account/ai-learning {opt_out}
 *   - 403 拒否
 *   - GAP-021: アイコン表示 (icon 優先 / 未設定は頭文字) と「変更」→ PATCH {icon}
 */

// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";

import * as React from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";
import { ApiError, type ApiClient } from "@atelier/api-client";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createQueryClient } from "../../lib/query-client";
import { WorkspaceSettingsContainer } from "../../app/auth/s_a03/_components/WorkspaceSettingsContainer";

function renderWithQuery(ui: React.ReactElement) {
  const qc = createQueryClient();
  return render(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>);
}

function apiError(status: number): ApiError {
  return new ApiError({
    status,
    statusText: "x",
    payload: undefined,
    path: "/workspaces",
    method: "get",
  });
}

function fakeClient(impl: {
  get?: unknown;
  patch?: unknown;
  post?: unknown;
}): ApiClient {
  const noop = vi.fn(async () => ({ data: {} }));
  return {
    get: impl.get ?? noop,
    patch: impl.patch ?? noop,
    post: impl.post ?? noop,
    delete: noop,
    put: noop,
    request: noop,
  } as unknown as ApiClient;
}

afterEach(() => vi.clearAllMocks());

describe("S-A03 WorkspaceSettingsContainer (T-UC-02)", () => {
  it("loads the workspace name and saves name + ai-learning opt-out", async () => {
    const get = vi.fn(async () => ({ data: { name: "My WS" } }));
    const patch = vi.fn(async () => ({ data: {} }));
    const post = vi.fn(async () => ({ data: { ai_learning_opt_out: true } }));
    renderWithQuery(
      <WorkspaceSettingsContainer
        workspaceId="w1"
        client={fakeClient({ get, patch, post })}
      />,
    );

    const nameInput = (await screen.findByDisplayValue(
      "My WS",
    )) as HTMLInputElement;
    expect(nameInput).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /保存|save/i }));

    await waitFor(() => expect(patch).toHaveBeenCalledTimes(1));
    const [patchPath, patchInit] = patch.mock.calls[0]! as unknown as [
      string,
      { params: { path: { workspace_id: string } }; body: { name: string } },
    ];
    expect(patchPath).toBe("/workspaces/{workspace_id}");
    expect(patchInit.params.path.workspace_id).toBe("w1");
    expect(patchInit.body.name).toBe("My WS");

    await waitFor(() => expect(post).toHaveBeenCalledTimes(1));
    const [postPath, postInit] = post.mock.calls[0]! as unknown as [
      string,
      { body: { opt_out: boolean } },
    ];
    expect(postPath).toBe("/account/ai-learning");
    expect(postInit.body.opt_out).toBe(true);
  });

  it("shows a forbidden message on 403", async () => {
    const get = vi.fn(async () => {
      throw apiError(403);
    });
    renderWithQuery(
      <WorkspaceSettingsContainer
        workspaceId="w1"
        client={fakeClient({ get })}
      />,
    );
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "権限がありません",
    );
  });

  it("changes the workspace icon via PATCH {icon} (GAP-021)", async () => {
    const get = vi.fn(async () => ({ data: { name: "My WS", icon: null } }));
    const patch = vi.fn(async () => ({ data: {} }));
    renderWithQuery(
      <WorkspaceSettingsContainer
        workspaceId="w1"
        client={fakeClient({ get, patch })}
      />,
    );
    await screen.findByDisplayValue("My WS");
    // 未設定時は頭文字案内を出す
    expect(screen.getByText(/名前の頭文字を表示します/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "変更" }));
    const input = screen.getByLabelText(/アイコン（絵文字または短い文字）/);
    fireEvent.change(input, { target: { value: "🎨" } });
    fireEvent.click(screen.getByRole("button", { name: "アイコンを保存" }));

    await waitFor(() => expect(patch).toHaveBeenCalledTimes(1));
    const [patchPath, patchInit] = patch.mock.calls[0]! as unknown as [
      string,
      { params: { path: { workspace_id: string } }; body: { icon: string } },
    ];
    expect(patchPath).toBe("/workspaces/{workspace_id}");
    expect(patchInit.params.path.workspace_id).toBe("w1");
    expect(patchInit.body.icon).toBe("🎨");
  });

  it("shows the stored icon instead of the initial and can clear it", async () => {
    const get = vi.fn(async () => ({ data: { name: "My WS", icon: "🚀" } }));
    const patch = vi.fn(async () => ({ data: {} }));
    renderWithQuery(
      <WorkspaceSettingsContainer
        workspaceId="w1"
        client={fakeClient({ get, patch })}
      />,
    );
    await screen.findByDisplayValue("My WS");
    expect(screen.getByText("🚀")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "変更" }));
    fireEvent.click(screen.getByRole("button", { name: "クリア" }));

    await waitFor(() => expect(patch).toHaveBeenCalledTimes(1));
    const [, patchInit] = patch.mock.calls[0]! as unknown as [
      string,
      { body: { icon: string | null } },
    ];
    expect(patchInit.body.icon).toBeNull();
  });

  it("rejects an icon longer than 8 bytes client-side (no PATCH)", async () => {
    const get = vi.fn(async () => ({ data: { name: "My WS", icon: null } }));
    const patch = vi.fn(async () => ({ data: {} }));
    renderWithQuery(
      <WorkspaceSettingsContainer
        workspaceId="w1"
        client={fakeClient({ get, patch })}
      />,
    );
    await screen.findByDisplayValue("My WS");
    fireEvent.click(screen.getByRole("button", { name: "変更" }));
    fireEvent.change(
      screen.getByLabelText(/アイコン（絵文字または短い文字）/),
      { target: { value: "アトリエ" } }, // 12 バイト
    );
    fireEvent.click(screen.getByRole("button", { name: "アイコンを保存" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "アイコンは絵文字 1 つまたは 1〜3 文字までです。",
    );
    expect(patch).not.toHaveBeenCalled();
  });

  it("renders the plan tab in the settings navigation (GAP-021)", async () => {
    const get = vi.fn(async () => ({ data: { name: "My WS" } }));
    renderWithQuery(
      <WorkspaceSettingsContainer
        workspaceId="w1"
        client={fakeClient({ get })}
      />,
    );
    await screen.findByDisplayValue("My WS");
    // GAP-116: パネルタブは tablist、招待管理/退会は実ページへのリンク (tablist 外 —
    // ARIA: tablist の子は tab のみ)
    const nav = screen.getByRole("tablist", { name: "設定セクション" });
    const labels = Array.from(nav.querySelectorAll("button[role='tab']")).map(
      (a) => a.textContent,
    );
    expect(labels).toEqual(["基本情報", "メンバー", "MCPトークン", "AI学習", "プラン"]);
    expect(screen.getByRole("link", { name: "招待管理" })).toHaveAttribute(
      "href",
      "/portal/invitations",
    );
    expect(screen.getByRole("link", { name: "退会" })).toHaveAttribute(
      "href",
      "/data-deletion",
    );
    // プランセクション実体 (PlanSection) も描画される
    expect(
      document.getElementById("ws-plan"),
    ).not.toBeNull();
  });

  it("rolls back and shows an error when the save fails", async () => {
    const get = vi.fn(async () => ({ data: { name: "My WS" } }));
    const patch = vi.fn(async () => {
      throw apiError(403);
    });
    renderWithQuery(
      <WorkspaceSettingsContainer
        workspaceId="w1"
        client={fakeClient({ get, patch })}
      />,
    );
    await screen.findByDisplayValue("My WS");
    fireEvent.click(screen.getByRole("button", { name: /保存|save/i }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "権限がありません",
    );
  });

  it("switches panels per tab instead of stacking sections (GAP-116)", async () => {
    const get = vi.fn(async () => ({ data: { name: "My WS" } }));
    renderWithQuery(
      <WorkspaceSettingsContainer
        workspaceId="w1"
        client={fakeClient({ get })}
      />,
    );
    await screen.findByDisplayValue("My WS");
    // 初期表示は基本情報のみ (AI 学習のチェックは隠れている)
    expect(screen.queryByRole("checkbox")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("tab", { name: "AI学習" }));
    // AI タブに切替: チェックボックスが見え、基本情報の名前入力は隠れる
    expect(screen.getByRole("checkbox")).toBeInTheDocument();
    expect(screen.getByDisplayValue("My WS")).not.toBeVisible();
    fireEvent.click(screen.getByRole("tab", { name: "基本情報" }));
    expect(screen.getByDisplayValue("My WS")).toBeVisible();
  });

  it("opens the plan tab when returning from Stripe (GAP-116)", async () => {
    const get = vi.fn(async (path: string) => {
      if (path.startsWith("/billing/plan")) {
        return { data: { plan: "free", status: "inactive", stripe_configured: true } };
      }
      return { data: { name: "My WS" } };
    });
    renderWithQuery(
      <WorkspaceSettingsContainer
        workspaceId="w1"
        client={fakeClient({ get })}
        initialTab="plan"
      />,
    );
    await screen.findByRole("tab", { name: "プラン", selected: true });
    // プランパネルが表示され、基本情報は隠れている
    expect(screen.getByDisplayValue("My WS")).not.toBeVisible();
  });
});
