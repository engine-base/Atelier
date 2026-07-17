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
  impl: Partial<Record<"get" | "patch", unknown>>,
): ApiClient {
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
      (screen.getByLabelText(/口調プリセット/) as HTMLSelectElement).value,
    ).toBe("coaching");
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
