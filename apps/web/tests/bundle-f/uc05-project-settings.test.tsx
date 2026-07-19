/**
 * T-UC-05 — S-B03 プロジェクト設定 配線テスト (design-audit v2)
 *
 * fake client を注入し real API を叩かずに検証する:
 *   - GET /projects/{id} で初期値を読み込みフォームに反映 (status→lifecycle, client_name/type)
 *   - 保存で PATCH /projects/{id} (lifecycle→status マップ + client_name/type 送信)
 *   - ステータス draft (下書き) が選択肢にあり丸められない
 *   - AI 学習トグルが GET の ai_learning_opt_out で初期化される (v2 実バグ修正)
 *   - 削除は 2 段階確認 (確定まで DELETE しない)
 *   - エクスポート: /outputs → content-url → openUrl / 0 件・503 の明示メッセージ
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
import { ProjectSettingsContainer } from "../../app/projects/s_b03/_components/ProjectSettingsContainer";

function renderWithQuery(ui: React.ReactElement) {
  const qc = createQueryClient();
  return render(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>);
}

function apiError(status: number): ApiError {
  return new ApiError({
    status,
    statusText: "x",
    payload: undefined,
    path: "/p",
    method: "get",
  });
}

function fakeClient(
  impl: Partial<Record<"get" | "patch" | "delete" | "post", unknown>>,
): ApiClient {
  const noop = vi.fn(async () => ({ data: {} }));
  return {
    get: impl.get ?? noop,
    patch: impl.patch ?? noop,
    delete: impl.delete ?? noop,
    post: impl.post ?? noop,
    put: noop,
    request: noop,
  } as unknown as ApiClient;
}

const PROJECT = {
  name: "受託案件A",
  client_name: "顧客X",
  description: "説明",
  type: "client_project",
  status: "paused",
  ai_learning_opt_out: true,
};

afterEach(() => vi.clearAllMocks());

describe("S-B03 ProjectSettingsContainer (T-UC-05)", () => {
  it("loads the project into the form (status → lifecycle, client_name/type)", async () => {
    const get = vi.fn(async () => ({ data: PROJECT }));
    renderWithQuery(
      <ProjectSettingsContainer projectId="p1" client={fakeClient({ get })} />,
    );
    const name = (await screen.findByLabelText(
      /プロジェクト名/,
    )) as HTMLInputElement;
    expect(name.value).toBe("受託案件A");
    expect(
      (screen.getByLabelText(/クライアント名/) as HTMLInputElement).value,
    ).toBe("顧客X");
    expect((screen.getByLabelText(/種別/) as HTMLSelectElement).value).toBe(
      "client_project",
    );
    expect(
      (screen.getByLabelText(/ステータス/) as HTMLSelectElement).value,
    ).toBe("paused");
  });

  it("offers draft (下書き) in the status select and keeps it on save", async () => {
    const get = vi.fn(async () => ({ data: { ...PROJECT, status: "draft" } }));
    const patch = vi.fn(async () => ({ data: {} }));
    renderWithQuery(
      <ProjectSettingsContainer
        projectId="p1"
        client={fakeClient({ get, patch })}
      />,
    );
    await screen.findByLabelText(/プロジェクト名/);
    const sel = screen.getByLabelText(/ステータス/) as HTMLSelectElement;
    // 下書きが丸められず初期表示される (v2 実バグ修正)
    expect(sel.value).toBe("draft");
    expect(
      Array.from(sel.options).map((o) => o.textContent),
    ).toEqual(["進行中", "下書き", "一時停止", "アーカイブ"]);
    fireEvent.click(screen.getByRole("button", { name: "保存" }));
    await waitFor(() => expect(patch).toHaveBeenCalledTimes(1));
    const [, init] = patch.mock.calls[0]! as unknown as [
      string,
      { body: { status: string } },
    ];
    expect(init.body.status).toBe("draft");
  });

  it("saves via PATCH with lifecycle mapped to status and client_name/type included", async () => {
    const get = vi.fn(async () => ({ data: PROJECT }));
    const patch = vi.fn(async () => ({ data: {} }));
    renderWithQuery(
      <ProjectSettingsContainer
        projectId="p1"
        client={fakeClient({ get, patch })}
      />,
    );
    await screen.findByLabelText(/プロジェクト名/);
    fireEvent.change(screen.getByLabelText(/クライアント名/), {
      target: { value: "顧客Y" },
    });
    fireEvent.click(screen.getByRole("button", { name: "保存" }));
    await waitFor(() => expect(patch).toHaveBeenCalledTimes(1));
    const [path, init] = patch.mock.calls[0]! as unknown as [
      string,
      {
        params: { path: { project_id: string } };
        body: {
          name: string;
          client_name: string;
          type: string;
          status: string;
        };
      },
    ];
    expect(path).toBe("/projects/{project_id}");
    expect(init.params.path.project_id).toBe("p1");
    expect(init.body.status).toBe("paused");
    expect(init.body.name).toBe("受託案件A");
    expect(init.body.client_name).toBe("顧客Y");
    expect(init.body.type).toBe("client_project");
  });

  it("deletes only after the 2-step confirmation and calls onDeleted", async () => {
    const get = vi.fn(async () => ({ data: PROJECT }));
    const del = vi.fn(async () => undefined);
    const onDeleted = vi.fn();
    renderWithQuery(
      <ProjectSettingsContainer
        projectId="p1"
        client={fakeClient({ get, delete: del })}
        onDeleted={onDeleted}
      />,
    );
    await screen.findByLabelText(/プロジェクト名/);
    fireEvent.click(screen.getByRole("button", { name: "プロジェクトを削除" }));
    // 1 クリック目では削除しない (2 段階確認)
    expect(del).not.toHaveBeenCalled();
    expect(screen.getByText("本当に削除しますか？")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "削除を確定" }));
    await waitFor(() => expect(del).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(onDeleted).toHaveBeenCalledTimes(1));
  });

  it("cancel aborts the delete confirmation without calling DELETE", async () => {
    const get = vi.fn(async () => ({ data: PROJECT }));
    const del = vi.fn(async () => undefined);
    renderWithQuery(
      <ProjectSettingsContainer
        projectId="p1"
        client={fakeClient({ get, delete: del })}
      />,
    );
    await screen.findByLabelText(/プロジェクト名/);
    fireEvent.click(screen.getByRole("button", { name: "プロジェクトを削除" }));
    fireEvent.click(screen.getByRole("button", { name: "キャンセル" }));
    expect(del).not.toHaveBeenCalled();
    expect(
      screen.getByRole("button", { name: "プロジェクトを削除" }),
    ).toBeInTheDocument();
  });

  it("initialises the AI learning toggle from GET ai_learning_opt_out=false (opt-in)", async () => {
    const get = vi.fn(async () => ({
      data: { ...PROJECT, ai_learning_opt_out: false },
    }));
    renderWithQuery(
      <ProjectSettingsContainer projectId="p1" client={fakeClient({ get })} />,
    );
    await screen.findByLabelText(/プロジェクト名/);
    // v2 実バグ修正: 常に OFF 表示だった → GET の実値 (opt_out=false → 許可 ON) を反映
    await waitFor(() =>
      expect(
        screen.getByLabelText("AI 学習への利用を許可") as HTMLInputElement,
      ).toBeChecked(),
    );
  });

  it("toggles AI learning via POST /projects/{id}/ai-learning (opt_out inverse)", async () => {
    const get = vi.fn(async () => ({ data: PROJECT }));
    const post = vi.fn(async () => ({ data: {} }));
    renderWithQuery(
      <ProjectSettingsContainer
        projectId="p1"
        client={fakeClient({ get, post })}
      />,
    );
    await screen.findByLabelText(/プロジェクト名/);
    // 既定は opt-out(学習しない)。トグル ON = 利用を許可 → opt_out:false を送る。
    fireEvent.click(screen.getByLabelText("AI 学習への利用を許可"));
    await waitFor(() => expect(post).toHaveBeenCalledTimes(1));
    const [path, init] = post.mock.calls[0]! as unknown as [
      string,
      { params: { path: { project_id: string } }; body: { opt_out: boolean } },
    ];
    expect(path).toBe("/projects/{project_id}/ai-learning");
    expect(init.params.path.project_id).toBe("p1");
    expect(init.body.opt_out).toBe(false);
  });

  it("exports a stage via /outputs → content-url → openUrl", async () => {
    const get = vi.fn(async (path: string) => {
      if (path === "/projects/{project_id}") return { data: PROJECT };
      if (path === "/outputs") return { data: [{ id: "o1", stage: "hearing" }] };
      if (path === "/outputs/{output_id}/content-url")
        return { data: { url: "https://signed.example/o1.html" } };
      return { data: {} };
    });
    const openUrl = vi.fn();
    renderWithQuery(
      <ProjectSettingsContainer
        projectId="p1"
        client={fakeClient({ get })}
        openUrl={openUrl}
      />,
    );
    await screen.findByLabelText(/プロジェクト名/);
    fireEvent.click(screen.getByRole("button", { name: "ヒアリング" }));
    await waitFor(() =>
      expect(openUrl).toHaveBeenCalledWith("https://signed.example/o1.html"),
    );
    expect(
      await screen.findByText("「ヒアリング」の成果物を開きました。"),
    ).toBeInTheDocument();
    // /outputs に project_id + stage で問い合わせている
    const outputsCall = get.mock.calls.find((c) => c[0] === "/outputs")! as
      | unknown[]
      | undefined;
    expect(
      (outputsCall?.[1] as { params: { query: Record<string, string> } }).params
        .query,
    ).toEqual({ project_id: "p1", stage: "hearing" });
  });

  it("shows an explicit message when a stage has no outputs yet", async () => {
    const get = vi.fn(async (path: string) => {
      if (path === "/projects/{project_id}") return { data: PROJECT };
      if (path === "/outputs") return { data: [] };
      return { data: {} };
    });
    const openUrl = vi.fn();
    renderWithQuery(
      <ProjectSettingsContainer
        projectId="p1"
        client={fakeClient({ get })}
        openUrl={openUrl}
      />,
    );
    await screen.findByLabelText(/プロジェクト名/);
    fireEvent.click(screen.getByRole("button", { name: "要件定義" }));
    expect(
      await screen.findByText("「要件定義」の成果物はまだありません。"),
    ).toBeInTheDocument();
    expect(openUrl).not.toHaveBeenCalled();
  });

  it("surfaces storage-unconfigured (503) as an explicit export error", async () => {
    const get = vi.fn(async (path: string) => {
      if (path === "/projects/{project_id}") return { data: PROJECT };
      if (path === "/outputs") return { data: [{ id: "o1", stage: "design" }] };
      if (path === "/outputs/{output_id}/content-url") throw apiError(503);
      return { data: {} };
    });
    renderWithQuery(
      <ProjectSettingsContainer projectId="p1" client={fakeClient({ get })} />,
    );
    await screen.findByLabelText(/プロジェクト名/);
    fireEvent.click(screen.getByRole("button", { name: "デザイン" }));
    expect(
      await screen.findByText(/storage が未設定です/),
    ).toBeInTheDocument();
  });

  it("shows a forbidden message on 403", async () => {
    const get = vi.fn(async () => {
      throw apiError(403);
    });
    renderWithQuery(
      <ProjectSettingsContainer projectId="p1" client={fakeClient({ get })} />,
    );
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "権限がありません",
    );
  });
});
