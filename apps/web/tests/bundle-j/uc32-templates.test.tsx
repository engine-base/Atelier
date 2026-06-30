/**
 * T-UC-32 — S-T03 AI 社員テンプレ 配線テスト
 *
 * fake client を注入し real API を叩かずに検証する:
 *   - GET /admin/ai-employee-templates の一覧描画（read-only: アクション列なし）
 *   - 空状態 / 403
 */

// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";

import * as React from "react";
import { render, screen } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";
import { ApiError, type ApiClient } from "@atelier/api-client";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createQueryClient } from "../../lib/query-client";
import { TemplateListContainer } from "../../app/admin/s_t03/_components/TemplateListContainer";

function renderWithQuery(ui: React.ReactElement) {
  const qc = createQueryClient();
  return render(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>);
}

function apiError(status: number): ApiError {
  return new ApiError({
    status,
    statusText: "x",
    payload: undefined,
    path: "/admin",
    method: "get",
  });
}

function fakeClient(get: unknown): ApiClient {
  const noop = vi.fn(async () => ({ data: [] }));
  return {
    get,
    post: noop,
    patch: noop,
    delete: noop,
    put: noop,
    request: noop,
  } as unknown as ApiClient;
}

const TEMPLATES = [
  {
    id: "t1",
    default_display_name: "シニアエンジニア",
    default_name: "senior_eng",
    role: "lead",
    specialty: "設計レビュー特化",
  },
];

afterEach(() => vi.clearAllMocks());

describe("S-T03 TemplateListContainer (T-UC-32)", () => {
  it("renders templates read-only (no action buttons)", async () => {
    const get = vi.fn(async () => ({ data: TEMPLATES }));
    renderWithQuery(<TemplateListContainer client={fakeClient(get)} />);
    expect(await screen.findByText("シニアエンジニア")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /を複製/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /を編集/ })).toBeNull();
    const [path] = get.mock.calls[0]! as unknown as [string];
    expect(path).toBe("/admin/ai-employee-templates");
  });

  it("shows empty state when there are no templates", async () => {
    const get = vi.fn(async () => ({ data: [] }));
    renderWithQuery(<TemplateListContainer client={fakeClient(get)} />);
    expect(await screen.findByText("テンプレがありません")).toBeInTheDocument();
  });

  it("shows a forbidden message on 403", async () => {
    const get = vi.fn(async () => {
      throw apiError(403);
    });
    renderWithQuery(<TemplateListContainer client={fakeClient(get)} />);
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "運営 admin 専用",
    );
  });
});
