/**
 * a11y (axe) — 主要画面の 0 critical violations を担保する。
 *
 * 各チケットの test_scenario「a11y: axe scan → 0 critical violations」に対応。
 * fake client を注入し、コンテンツ確定後に axe を実行して重大違反が無いことを検証する。
 */

// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import "vitest-axe/extend-expect";

import * as React from "react";
import { render, screen } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";
import { type ApiClient } from "@atelier/api-client";
import { axe } from "vitest-axe";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createQueryClient } from "../../lib/query-client";
import { MockViewerContainer } from "../../app/mocks/s_h01/_components/MockViewerContainer";
import { OutputViewerContainer } from "../../app/outputs/s_g01/_components/OutputViewerContainer";
import { TaskDetailContainer } from "../../app/tasks/s_i02/_components/TaskDetailContainer";
import { SearchContainer } from "../../app/t-uc-40/_components/SearchContainer";
import { NotificationsContainer } from "../../app/t-uc-36/_components/NotificationsContainer";
import { ProfileContainer } from "../../app/t-uc-37/_components/ProfileContainer";
import { PhaseListContainer } from "../../app/workflow/s_f02/_components/PhaseListContainer";
import { InvitationsListContainer } from "../../app/client/s_l01/_components/InvitationsListContainer";

function renderWithQuery(ui: React.ReactElement) {
  const qc = createQueryClient();
  return render(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>);
}

function fakeClient(
  impl: Partial<Record<"get" | "post" | "patch", unknown>>,
): ApiClient {
  const noop = vi.fn(async () => ({ data: [] }));
  return {
    get: impl.get ?? noop,
    post: impl.post ?? noop,
    patch: impl.patch ?? noop,
    delete: noop,
    put: noop,
    request: noop,
  } as unknown as ApiClient;
}

/** critical/serious な違反のみを厳格に 0 とみなす（jsdom はレイアウト系を判定不能とするため）。 */
async function expectNoSeriousViolations(
  container: HTMLElement,
): Promise<void> {
  // iframes:false — jsdom は about:blank iframe 内部を走査できず axe が例外を投げるため
  // フレーム内部の検査は無効化（本テストの対象はアプリ自身の DOM）。
  const results = (await axe(container, { iframes: false })) as unknown as {
    violations: { impact?: string | null; id: string }[];
  };
  const serious = results.violations.filter(
    (v) => v.impact === "critical" || v.impact === "serious",
  );
  expect(serious, JSON.stringify(serious.map((v) => v.id))).toEqual([]);
}

afterEach(() => vi.clearAllMocks());

describe("a11y: 主要画面 axe (0 critical/serious)", () => {
  it("S-H01 モックビューア", async () => {
    const get = vi.fn(async (path: string) =>
      path.includes("content-url")
        ? { data: { url: "about:blank" } }
        : { data: { screen_name: "ログイン画面" } },
    );
    const { container } = renderWithQuery(
      <MockViewerContainer mockId="m1" client={fakeClient({ get })} />,
    );
    await screen.findByTitle("ログイン画面");
    await expectNoSeriousViolations(container);
  });

  it("S-G01 成果物ビューア", async () => {
    const get = vi.fn(async (path: string) => {
      if (path.includes("content-url")) return { data: { url: "about:blank" } };
      if (path === "/comments")
        return { data: [{ id: "c1", author_user_id: "u1", content: "x" }] };
      return { data: { summary: "見積書", stage: "estimate" } };
    });
    const { container } = renderWithQuery(
      <OutputViewerContainer outputId="o1" client={fakeClient({ get })} />,
    );
    await screen.findByRole("heading", { name: "見積書" });
    await expectNoSeriousViolations(container);
  });

  it("S-I02 タスク詳細", async () => {
    const get = vi.fn(async () => ({
      data: { title: "API 設計", lifecycle_stage: "in_progress" },
    }));
    const { container } = renderWithQuery(
      <TaskDetailContainer taskId="t1" client={fakeClient({ get })} />,
    );
    await screen.findByRole("heading", { name: "API 設計" });
    await expectNoSeriousViolations(container);
  });

  it("T-UC-40 検索", async () => {
    const { container } = renderWithQuery(
      <SearchContainer client={fakeClient({})} debounceMs={0} />,
    );
    await screen.findByText("キーワードを入力してください。");
    await expectNoSeriousViolations(container);
  });

  it("T-UC-36 通知センター", async () => {
    const get = vi.fn(async () => ({
      data: [
        { id: "a1", title: "承認待ち", created_at: "2026-06-20T10:00:00Z" },
      ],
    }));
    const { container } = renderWithQuery(
      <NotificationsContainer client={fakeClient({ get })} />,
    );
    await screen.findByText("承認待ち");
    await expectNoSeriousViolations(container);
  });

  it("T-UC-37 プロフィール", async () => {
    const get = vi.fn(async () => ({
      data: { email: "a@example.com", display_name: "山田" },
    }));
    const { container } = renderWithQuery(
      <ProfileContainer client={fakeClient({ get })} />,
    );
    await screen.findByDisplayValue("山田");
    await expectNoSeriousViolations(container);
  });

  it("S-F02 フェーズ管理", async () => {
    const get = vi.fn(async () => ({
      data: [
        { id: "ph1", name: "設計", status: "in_progress", order_index: 1 },
      ],
    }));
    const { container } = renderWithQuery(
      <PhaseListContainer projectId="p1" client={fakeClient({ get })} />,
    );
    await screen.findByText("設計");
    await expectNoSeriousViolations(container);
  });

  it("S-L01 クライアント招待管理", async () => {
    const get = vi.fn(async () => ({
      data: [
        {
          id: "inv1",
          email: "a@example.com",
          expires_at: "2999-12-31T00:00:00Z",
        },
      ],
    }));
    const { container } = renderWithQuery(
      <InvitationsListContainer projectId="p1" client={fakeClient({ get })} />,
    );
    await screen.findByText("a@example.com");
    await expectNoSeriousViolations(container);
  });
});
