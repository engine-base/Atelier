/**
 * T-UC-22 — S-L03 クライアントプロジェクトビュー 配線テスト (R-T08)
 *
 *   - token あり → fetchProject の結果を描画
 *   - token なし → サインイン誘導
 *   - 403 越境 → 拒否
 */

// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";

import * as React from "react";
import { render, screen } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createQueryClient } from "../../lib/query-client";
import { ClientProjectViewContainer } from "../../app/client/s_l03/_components/ClientProjectViewContainer";
import {
  ClientPortalError,
  type ClientProjectData,
} from "../../lib/auth/client-portal";

function renderWithQuery(ui: React.ReactElement) {
  const qc = createQueryClient();
  return render(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>);
}

const DATA: ClientProjectData = {
  id: "p1",
  name: "ACME 案件",
  description: "限定ビュー",
  scopes: ["view", "comment"],
  viewed_as_client_display_name: "山田",
};

afterEach(() => vi.clearAllMocks());

describe("S-L03 ClientProjectViewContainer (T-UC-22)", () => {
  it("renders the project view when a client token is present", async () => {
    const fetchProject = vi.fn(async () => DATA);
    renderWithQuery(
      <ClientProjectViewContainer
        projectId="p1"
        getToken={() => "ct"}
        fetchProject={fetchProject}
      />,
    );
    expect(
      await screen.findByRole("heading", { name: "ACME 案件" }),
    ).toBeInTheDocument();
    expect(screen.getByText("コメント")).toBeInTheDocument();
    expect(fetchProject).toHaveBeenCalledWith("p1", "ct");
  });

  it("prompts sign-in when there is no client token", async () => {
    renderWithQuery(
      <ClientProjectViewContainer
        projectId="p1"
        getToken={() => null}
        fetchProject={vi.fn()}
      />,
    );
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "サインインが必要です",
    );
  });

  it("denies cross-project access on 403 (R-T08)", async () => {
    const fetchProject = vi.fn(async () => {
      throw new ClientPortalError("cross", 403);
    });
    renderWithQuery(
      <ClientProjectViewContainer
        projectId="other"
        getToken={() => "ct"}
        fetchProject={fetchProject}
      />,
    );
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "権限がありません",
    );
  });
});
