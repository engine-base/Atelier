/**
 * T-UC-06 — S-C01 AI 社員組織図 配線テスト
 *
 * fake client を注入し real API を叩かずに検証する:
 *   - GET /ai-employees を department 別にグルーピング描画
 *   - 社員クリックで onSelect
 *   - 空状態 / 403
 */

// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";

import * as React from "react";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";
import { ApiError, type ApiClient } from "@atelier/api-client";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createQueryClient } from "../../lib/query-client";
import { OrgChartContainer } from "../../app/employees/s_c01/_components/OrgChartContainer";

function renderWithQuery(ui: React.ReactElement) {
  const qc = createQueryClient();
  return render(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>);
}

function apiError(status: number): ApiError {
  return new ApiError({
    status,
    statusText: "x",
    payload: undefined,
    path: "/ai-employees",
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

const EMPLOYEES = [
  { id: "e1", name: "tony", display_name: "トニー", department: "dev_qa" },
  { id: "e2", name: "wanda", display_name: "ワンダ", department: "design" },
];

afterEach(() => vi.clearAllMocks());

describe("S-C01 OrgChartContainer (T-UC-06)", () => {
  it("groups employees by department", async () => {
    const get = vi.fn(async () => ({ data: EMPLOYEES }));
    renderWithQuery(<OrgChartContainer client={fakeClient(get)} />);
    const devqa = await screen.findByRole("article", { name: "開発・検証部" });
    expect(within(devqa).getByText("トニー")).toBeInTheDocument();
    expect(
      screen.getByRole("article", { name: "デザイン部" }),
    ).toBeInTheDocument();
    const [path] = get.mock.calls[0]! as unknown as [string];
    expect(path).toBe("/ai-employees");
  });

  it("invokes onSelect when a member is clicked", async () => {
    const get = vi.fn(async () => ({ data: EMPLOYEES }));
    const onSelect = vi.fn();
    renderWithQuery(
      <OrgChartContainer client={fakeClient(get)} onSelect={onSelect} />,
    );
    fireEvent.click(
      await screen.findByRole("button", { name: /トニー の詳細/ }),
    );
    // 遷移には実 UUID を渡す (name "tony" を渡すと詳細取得が 404/500 になる実バグがあった)
    expect(onSelect).toHaveBeenCalledWith("e1");
  });

  it("shows empty state when there are no employees", async () => {
    const get = vi.fn(async () => ({ data: [] }));
    renderWithQuery(<OrgChartContainer client={fakeClient(get)} />);
    expect(await screen.findByText("AI 社員がいません。")).toBeInTheDocument();
  });

  it("shows a forbidden message on 403", async () => {
    const get = vi.fn(async () => {
      throw apiError(403);
    });
    renderWithQuery(<OrgChartContainer client={fakeClient(get)} />);
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "権限がありません",
    );
  });
});

// ── v2 (モック忠実カード + スキル名前解決 + リストビュー) ─────────────

const RICH_EMPLOYEES = [
  {
    id: "e1",
    name: "tony",
    display_name: "トニー",
    department: "sales",
    role: "lead",
    template_id: "tp1",
    attached_skills: ["s1", "s2"],
    tone_preset: "friendly",
  },
  {
    id: "e2",
    name: "jarvis",
    display_name: "ジャービス",
    department: "executive",
    role: "coo",
    template_id: "tp2",
    attached_skills: [],
    tone_preset: "polite",
  },
];

function richGet() {
  return vi.fn(async (path: string) => {
    if (path === "/ai-employees") return { data: RICH_EMPLOYEES };
    if (path === "/skills")
      return {
        data: [
          { id: "s1", name: "sales-email" },
          { id: "s2", name: "proposal" },
        ],
      };
    if (path === "/ai-employees/templates")
      return {
        data: [
          { id: "tp1", specialty: "営業・提案・見積" },
          { id: "tp2", specialty: "全社統括・進捗管理" },
        ],
      };
    return { data: [] };
  });
}

describe("S-C01 v2: カード充実 + リストビュー", () => {
  it("resolves skill names and role labels on org cards", async () => {
    renderWithQuery(<OrgChartContainer client={fakeClient(richGet())} />);
    expect(await screen.findByText("トニー")).toBeInTheDocument();
    // 役割ライン: lead → 部長 / coo → COO · specialty 先頭
    expect(screen.getByText("部長")).toBeInTheDocument();
    expect(screen.getByText("COO · 全社統括")).toBeInTheDocument();
    // スキル名解決 (uuid → name) + 英名
    expect(
      screen.getByText(/2 skills · sales-email, proposal/),
    ).toBeInTheDocument();
    expect(screen.getByText("Tony")).toBeInTheDocument();
    // COO はスキル 0 件 → 未装着表示
    expect(screen.getByText("スキル未装着")).toBeInTheDocument();
  });

  it("renders the list view with the same real data", async () => {
    renderWithQuery(
      <OrgChartContainer client={fakeClient(richGet())} view="list" />,
    );
    const table = await screen.findByRole("table");
    expect(within(table).getByText("トニー")).toBeInTheDocument();
    expect(within(table).getByText("営業・契約部")).toBeInTheDocument();
    expect(within(table).getByText("sales-email, proposal")).toBeInTheDocument();
    // 口調プリセットのラベル化
    expect(within(table).getByText("フレンドリー")).toBeInTheDocument();
  });

  it("list view row click invokes onSelect with the real UUID", async () => {
    const onSelect = vi.fn();
    renderWithQuery(
      <OrgChartContainer
        client={fakeClient(richGet())}
        view="list"
        onSelect={onSelect}
      />,
    );
    fireEvent.click(
      await screen.findByRole("button", { name: "トニー の詳細" }),
    );
    expect(onSelect).toHaveBeenCalledWith("e1");
  });
});
