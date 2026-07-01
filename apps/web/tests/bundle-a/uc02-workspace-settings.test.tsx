/**
 * T-UC-02 — S-A03 ワークスペース設定 配線テスト
 *
 *   - GET /workspaces/{id} で名称をフォームに反映
 *   - 保存で PATCH /workspaces/{id} {name} + POST /account/ai-learning {opt_out}
 *   - 403 拒否
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
});
