/**
 * T-UC-37 — プロフィール 配線テスト
 *
 *   - GET /me で表示名/メールをフォームに反映（email は readonly）
 *   - 保存で PATCH /me {display_name}
 *   - 401 拒否
 */

// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";

import * as React from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";
import { ApiError, type ApiClient } from "@atelier/api-client";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createQueryClient } from "../../lib/query-client";
import { ProfileContainer } from "../../app/t-uc-37/_components/ProfileContainer";

function renderWithQuery(ui: React.ReactElement) {
  const qc = createQueryClient();
  return render(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>);
}

function apiError(status: number): ApiError {
  return new ApiError({
    status,
    statusText: "x",
    payload: undefined,
    path: "/me",
    method: "get",
  });
}

function fakeClient(impl: { get?: unknown; patch?: unknown }): ApiClient {
  const noop = vi.fn(async () => ({ data: {} }));
  return {
    get: impl.get ?? noop,
    patch: impl.patch ?? noop,
    post: noop,
    delete: noop,
    put: noop,
    request: noop,
  } as unknown as ApiClient;
}

afterEach(() => vi.clearAllMocks());

describe("T-UC-37 ProfileContainer", () => {
  it("loads the profile and saves display_name via PATCH /me", async () => {
    const get = vi.fn(async () => ({
      data: { email: "a@example.com", display_name: "山田" },
    }));
    const patch = vi.fn(async () => ({ data: {} }));
    renderWithQuery(<ProfileContainer client={fakeClient({ get, patch })} />);

    const nameInput = (await screen.findByDisplayValue(
      "山田",
    )) as HTMLInputElement;
    expect(nameInput).toBeInTheDocument();
    // email は readonly で表示
    const emailInput = screen.getByDisplayValue(
      "a@example.com",
    ) as HTMLInputElement;
    expect(emailInput).toHaveAttribute("readonly");

    fireEvent.change(nameInput, { target: { value: "田中" } });
    fireEvent.click(screen.getByRole("button", { name: /保存|save/i }));

    await waitFor(() => expect(patch).toHaveBeenCalledTimes(1));
    const [path, init] = patch.mock.calls[0]! as unknown as [
      string,
      { body: { display_name: string } },
    ];
    expect(path).toBe("/me");
    expect(init.body.display_name).toBe("田中");
  });

  it("shows a sign-in message on 401", async () => {
    const get = vi.fn(async () => {
      throw apiError(401);
    });
    renderWithQuery(<ProfileContainer client={fakeClient({ get })} />);
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "サインインが必要",
    );
  });
});
