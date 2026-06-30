/**
 * T-UC-05 — S-B03 プロジェクト設定 配線テスト
 *
 * fake client を注入し real API を叩かずに検証する:
 *   - GET /projects/{id} で初期値を読み込みフォームに反映 (status→lifecycle)
 *   - 保存で PATCH /projects/{id} (lifecycle→status マップ)
 *   - 削除で DELETE /projects/{id} + onDeleted 呼び出し
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
  impl: Partial<Record<"get" | "patch" | "delete", unknown>>,
): ApiClient {
  const noop = vi.fn(async () => ({ data: {} }));
  return {
    get: impl.get ?? noop,
    patch: impl.patch ?? noop,
    delete: impl.delete ?? noop,
    post: noop,
    put: noop,
    request: noop,
  } as unknown as ApiClient;
}

const PROJECT = {
  name: "受託案件A",
  client_name: "顧客X",
  description: "説明",
  status: "paused",
};

afterEach(() => vi.clearAllMocks());

describe("S-B03 ProjectSettingsContainer (T-UC-05)", () => {
  it("loads the project into the form (status → lifecycle)", async () => {
    const get = vi.fn(async () => ({ data: PROJECT }));
    renderWithQuery(
      <ProjectSettingsContainer projectId="p1" client={fakeClient({ get })} />,
    );
    const name = (await screen.findByLabelText(
      /プロジェクト名/,
    )) as HTMLInputElement;
    expect(name.value).toBe("受託案件A");
    expect(
      (screen.getByLabelText(/ライフサイクル/) as HTMLSelectElement).value,
    ).toBe("paused");
  });

  it("saves via PATCH with lifecycle mapped to status", async () => {
    const get = vi.fn(async () => ({ data: PROJECT }));
    const patch = vi.fn(async () => ({ data: {} }));
    renderWithQuery(
      <ProjectSettingsContainer
        projectId="p1"
        client={fakeClient({ get, patch })}
      />,
    );
    await screen.findByLabelText(/プロジェクト名/);
    fireEvent.click(screen.getByRole("button", { name: "保存" }));
    await waitFor(() => expect(patch).toHaveBeenCalledTimes(1));
    const [path, init] = patch.mock.calls[0]! as unknown as [
      string,
      {
        params: { path: { project_id: string } };
        body: { name: string; status: string };
      },
    ];
    expect(path).toBe("/projects/{project_id}");
    expect(init.params.path.project_id).toBe("p1");
    expect(init.body.status).toBe("paused");
    expect(init.body.name).toBe("受託案件A");
  });

  it("deletes via DELETE and calls onDeleted", async () => {
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
    await waitFor(() => expect(del).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(onDeleted).toHaveBeenCalledTimes(1));
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
