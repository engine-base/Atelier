/**
 * T-UC-07 — S-C02 AI 社員詳細・編集 配線テスト
 *
 * fake client を注入し real API を叩かずに検証する:
 *   - GET /ai-employees/{id} で初期値をフォームへ反映
 *   - 保存で PATCH /ai-employees/{id} (display_name / tone_preset)
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
import { EmployeeEditorContainer } from "../../app/employees/s_c02/_components/EmployeeEditorContainer";

function renderWithQuery(ui: React.ReactElement) {
  const qc = createQueryClient();
  return render(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>);
}

function apiError(status: number): ApiError {
  return new ApiError({
    status,
    statusText: "x",
    payload: undefined,
    path: "/e",
    method: "get",
  });
}

function fakeClient(
  impl: Partial<Record<"get" | "patch" | "post", unknown>>,
): ApiClient {
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

const EMP = {
  name: "tony",
  display_name: "トニー",
  role: "開発リード",
  department: "dev_qa",
  tone_preset: "coaching",
  custom_tone_text: "",
  attached_skills: ["task_prioritization"],
  attached_knowledge_cats: ["dev"],
};

afterEach(() => vi.clearAllMocks());

describe("S-C02 EmployeeEditorContainer (T-UC-07)", () => {
  it("loads the employee into the form", async () => {
    const get = vi.fn(async () => ({ data: EMP }));
    renderWithQuery(
      <EmployeeEditorContainer employeeId="e1" client={fakeClient({ get })} />,
    );
    const name = (await screen.findByLabelText(/表示名/)) as HTMLInputElement;
    expect(name.value).toBe("トニー");
    expect(
      (screen.getByRole("radio", { name: /コーチング・前向き/ }) as HTMLInputElement)
        .checked,
    ).toBe(true);
  });

  it("saves via PATCH /ai-employees/{id}", async () => {
    const get = vi.fn(async () => ({ data: EMP }));
    const patch = vi.fn(async () => ({ data: {} }));
    renderWithQuery(
      <EmployeeEditorContainer
        employeeId="e1"
        client={fakeClient({ get, patch })}
      />,
    );
    await screen.findByLabelText(/表示名/);
    fireEvent.click(screen.getByRole("button", { name: "保存" }));
    await waitFor(() => expect(patch).toHaveBeenCalledTimes(1));
    const [path, init] = patch.mock.calls[0]! as unknown as [
      string,
      {
        params: { path: { employee_id: string } };
        body: { display_name: string; tone_preset: string };
      },
    ];
    expect(path).toBe("/ai-employees/{employee_id}");
    expect(init.params.path.employee_id).toBe("e1");
    expect(init.body.display_name).toBe("トニー");
    expect(init.body.tone_preset).toBe("coaching");
  });

  it("shows a forbidden message on 403", async () => {
    const get = vi.fn(async () => {
      throw apiError(403);
    });
    renderWithQuery(
      <EmployeeEditorContainer employeeId="e1" client={fakeClient({ get })} />,
    );
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "権限がありません",
    );
  });
});

// ── v2 (モック忠実再構築): スキル名前解決 / タブ / アイコンピッカー ────────

const RICH_EMP = {
  id: "e1",
  name: "tony",
  display_name: "トニー",
  role: "lead",
  department: "sales",
  tone_preset: "polite",
  custom_tone_text: "",
  icon: "",
  template_id: "tp1",
  attached_skills: ["s1"],
  attached_knowledge_cats: ["sales-docs"],
};

function richGet() {
  return vi.fn(async (path: string) => {
    if (path === "/ai-employees/{employee_id}") return { data: RICH_EMP };
    if (path === "/skills")
      return {
        data: [{ id: "s1", name: "sales-email", description: "営業メールの下書きを書く" }],
      };
    if (path === "/ai-employees")
      return {
        data: [
          RICH_EMP,
          {
            id: "e0",
            name: "jarvis",
            display_name: "ジャービス",
            role: "coo",
            department: "executive",
          },
          {
            id: "e2",
            name: "natasha",
            display_name: "ナターシャ",
            role: "member",
            department: "sales",
          },
        ],
      };
    if (path === "/ai-employees/templates")
      return { data: [{ id: "tp1", specialty: "営業・提案・見積" }] };
    return { data: [] };
  });
}

describe("S-C02 v2: 実データ表示 + アイコンピッカー", () => {
  it("resolves skill names, dept label, and org relations", async () => {
    renderWithQuery(
      <EmployeeEditorContainer employeeId="e1" client={fakeClient({ get: richGet() })} />,
    );
    await screen.findByLabelText(/表示名/);
    // できること: uuid ではなく実スキル名
    // GAP-274 (R-T06): 「できること」は説明文だけ。スキル名 (内部識別子) は出さない
    expect(screen.getByText("営業メールの下書きを書く")).toBeInTheDocument();
    expect(screen.queryByText("sales-email")).not.toBeInTheDocument();
    // 担当範囲: 表示ラベル + 組織関係の実算出
    expect(screen.getByText("営業・契約部")).toBeInTheDocument();
    expect(screen.getAllByText("部長").length).toBeGreaterThan(0); // ヘッダバッジ + 担当範囲
    expect(screen.getByText("ジャービス")).toBeInTheDocument(); // レポート対象 = COO
    expect(screen.getByText("メンバー 1 名")).toBeInTheDocument(); // 直属の部下
  });

  it("switches to the knowledge tab and shows real categories", async () => {
    renderWithQuery(
      <EmployeeEditorContainer employeeId="e1" client={fakeClient({ get: richGet() })} />,
    );
    await screen.findByLabelText(/表示名/);
    fireEvent.click(screen.getByRole("tab", { name: /ナレッジ/ }));
    expect(screen.getByText("sales-docs")).toBeInTheDocument();
    // フォームはプロフィールタブ側なので非表示に
    expect(screen.queryByLabelText(/表示名/)).toBeNull();
  });

  it("picks a lucide icon and saves it via PATCH icon", async () => {
    const patch = vi.fn(async () => ({ data: {} }));
    renderWithQuery(
      <EmployeeEditorContainer
        employeeId="e1"
        client={fakeClient({ get: richGet(), patch })}
      />,
    );
    await screen.findByLabelText(/表示名/);
    fireEvent.click(screen.getByRole("button", { name: "Lucide から選ぶ" }));
    fireEvent.click(screen.getByRole("option", { name: "アイコン bot" }));
    fireEvent.click(screen.getByRole("button", { name: "保存" }));
    await waitFor(() => expect(patch).toHaveBeenCalledTimes(1));
    const [, init] = patch.mock.calls[0]! as unknown as [
      string,
      { body: { icon?: string } },
    ];
    expect(init.body.icon).toBe("bot");
  });
});

describe("S-C02 活動履歴タブ (GAP-008)", () => {
  it("活動フィードを実 API から取得してタブ描画 (種別バッジ + 件数)", async () => {
    const activities = [
      { type: "task", title: "LP 実装", detail: "状態: done", at: "2026-08-02T10:00:00Z" },
      { type: "decision", title: "配色を確定", detail: "確定事項", at: "2026-08-01T09:00:00Z" },
      { type: "execution", title: "LP 実装", detail: "実行 succeeded · score 0.90", at: "2026-07-31T08:00:00Z" },
      { type: "thread", title: "見積相談", detail: "チャット対応", at: "2026-07-30T07:00:00Z" },
    ];
    const get = vi.fn(async (path: unknown) =>
      path === "/ai-employees/{employee_id}/activities"
        ? { data: activities }
        : { data: EMP },
    );
    renderWithQuery(
      <EmployeeEditorContainer employeeId="e1" client={fakeClient({ get })} />,
    );
    const tab = await screen.findByRole("tab", { name: /活動履歴/ });
    expect(tab).toHaveTextContent("4");
    fireEvent.click(tab);
    expect(await screen.findByText("最近の活動")).toBeInTheDocument();
    expect(screen.getByText("配色を確定")).toBeInTheDocument();
    expect(screen.getByText("実行 succeeded · score 0.90")).toBeInTheDocument();
    expect(screen.getByText("決定")).toBeInTheDocument();
    expect(screen.getByText("チャット")).toBeInTheDocument();
  });
});

describe("S-C02 アイコン画像アップロード (GAP-009)", () => {
  it("画像を選ぶと 署名付き URL 発行 → PUT → PATCH icon=storage_path", async () => {
    const post = vi.fn(async () => ({
      data: {
        upload_url: "http://storage.test/storage/v1/object/upload/sign/avatars/x?token=t",
        storage_path: "avatars/ai-employees/e1/x/icon.png",
      },
    }));
    const patch = vi.fn(async () => ({ data: {} }));
    const putFileFn = vi.fn(async (..._args: unknown[]) => undefined);
    renderWithQuery(
      <EmployeeEditorContainer
        employeeId="e1"
        client={fakeClient({ get: richGet(), post, patch })}
        putFileFn={putFileFn}
      />,
    );
    await screen.findByRole("button", { name: "画像アップロード" });
    const file = new File(["png-bytes"], "icon.png", { type: "image/png" });
    fireEvent.change(screen.getByLabelText("アイコン画像を選択"), {
      target: { files: [file] },
    });
    await waitFor(() => expect(patch).toHaveBeenCalledTimes(1));
    expect(post).toHaveBeenCalledWith(
      "/ai-employees/{employee_id}/icon-upload-url",
      expect.objectContaining({
        body: expect.objectContaining({ mime_type: "image/png" }),
      }),
    );
    expect(putFileFn).toHaveBeenCalledWith(
      "http://storage.test/storage/v1/object/upload/sign/avatars/x?token=t",
      file,
    );
    const [, init] = patch.mock.calls[0]! as unknown as [
      string,
      { body: { icon: string } },
    ];
    expect(init.body.icon).toBe("avatars/ai-employees/e1/x/icon.png");
  });

  it("画像以外は client 側で即時拒否 (API を呼ばない)", async () => {
    const post = vi.fn(async () => ({ data: {} }));
    renderWithQuery(
      <EmployeeEditorContainer
        employeeId="e1"
        client={fakeClient({ get: richGet(), post })}
      />,
    );
    await screen.findByRole("button", { name: "画像アップロード" });
    fireEvent.change(screen.getByLabelText("アイコン画像を選択"), {
      target: {
        files: [new File(["x"], "doc.pdf", { type: "application/pdf" })],
      },
    });
    expect(
      await screen.findByText("PNG / JPEG / WebP の画像のみアップロードできます。"),
    ).toBeInTheDocument();
    expect(post).not.toHaveBeenCalled();
  });

  it("icon が storage path のとき icon-url を解決して <img> 描画", async () => {
    const IMG_EMP = { ...RICH_EMP, icon: "avatars/ai-employees/e1/x/icon.png" };
    const get = vi.fn(async (path: string) => {
      if (path === "/ai-employees/{employee_id}") return { data: IMG_EMP };
      if (path === "/ai-employees/{employee_id}/icon-url")
        return { data: { url: "http://storage.test/signed/icon.png?token=t" } };
      if (path === "/ai-employees") return { data: [IMG_EMP] };
      return { data: [] };
    });
    const { container } = renderWithQuery(
      <EmployeeEditorContainer employeeId="e1" client={fakeClient({ get })} />,
    );
    await screen.findByLabelText(/表示名/);
    await waitFor(() => {
      const img = container.querySelector(
        'img[src="http://storage.test/signed/icon.png?token=t"]',
      );
      expect(img).not.toBeNull();
    });
  });
});
