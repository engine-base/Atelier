/**
 * T-UC-21 — S-L02 クライアントサインイン 配線テスト
 *
 *   - signin 成功 → onSignedIn(project.id)
 *   - 401 invalid_token / 410 expired を文言化
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
  type ClientSigninResult,
} from "../../lib/auth/client-portal";

const OK: ClientSigninResult = {
  client_access_token: "ct",
  expires_at: "2999-01-01T00:00:00Z",
  project: { id: "proj-9", name: "ACME" },
  scopes: ["view"],
};

afterEach(() => vi.clearAllMocks());

describe("S-L02 ClientSigninContainer (T-UC-21)", () => {
  it("signs in and calls onSignedIn with the project id", async () => {
    const signinFn = vi.fn(async () => OK);
    const onSignedIn = vi.fn();
    render(
      <ClientSigninContainer
        defaultToken="tok-1234567890"
        signinFn={signinFn}
        onSignedIn={onSignedIn}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "プロジェクトを開く" }));
    await waitFor(() =>
      expect(signinFn).toHaveBeenCalledWith("tok-1234567890", ""),
    );
    expect(onSignedIn).toHaveBeenCalledWith("proj-9");
  });

  it("shows an invalid-token message on 401", async () => {
    const signinFn = vi.fn(async () => {
      throw new ClientPortalError("invalid", 401);
    });
    render(
      <ClientSigninContainer
        defaultToken="tok-1234567890"
        signinFn={signinFn}
        onSignedIn={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "プロジェクトを開く" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "招待トークンが無効です",
    );
  });

  it("shows an expired message on 410", async () => {
    const signinFn = vi.fn(async () => {
      throw new ClientPortalError("expired", 410);
    });
    render(
      <ClientSigninContainer
        defaultToken="tok-1234567890"
        signinFn={signinFn}
        onSignedIn={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "プロジェクトを開く" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "有効期限が切れています",
    );
  });
});
