/**
 * 楽観更新＋ロールバック テスト（fix: EVENT-DRIVEN AC「optimistically reflect + rollback on failure」）
 *
 *   - 承認: 決裁で即座にインボックスから消え、失敗時に戻る
 *   - cron: トグルで即座に enabled 反映、失敗時に戻る
 */

// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";

import * as React from "react";
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";
import { ApiError, type ApiClient } from "@atelier/api-client";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createQueryClient } from "../../lib/query-client";
import { clearToasts } from "../../lib/toast/store";
import { ApprovalsContainer } from "../../app/approvals/s_j01/_components/ApprovalsContainer";
import { CronScheduleContainer } from "../../app/cron/s_o01/_components/CronScheduleContainer";

/** 4xx ApiError（retry されないので onError=ロールバックが即時発火する）。 */
function clientError(): ApiError {
  return new ApiError({
    status: 422,
    statusText: "x",
    payload: undefined,
    path: "/x",
    method: "post",
  });
}

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

/** 手動で解決/拒否できる Promise を返すモック。 */
function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

afterEach(() => {
  vi.clearAllMocks();
  clearToasts();
});

describe("S-J01 承認: 楽観除外 + ロールバック", () => {
  const INBOX = [
    {
      id: "a1",
      type: "task",
      title: "決裁A",
      payload: {},
      created_at: "2026-06-20T00:00:00Z",
    },
  ];

  it("removes the item immediately and restores it on failure", async () => {
    const get = vi.fn(async () => ({ data: INBOX }));
    const d = deferred<unknown>();
    const post = vi.fn(() => d.promise);
    renderWithQuery(<ApprovalsContainer client={fakeClient({ get, post })} />);

    fireEvent.click(
      await screen.findByRole("button", { name: "決裁A を承認" }),
    );
    // 楽観: post 解決前に消える
    await waitFor(() => expect(screen.queryByText("決裁A")).toBeNull());
    // 失敗 → ロールバックで戻る
    await act(async () => {
      d.reject(clientError());
      await Promise.resolve();
    });
    expect(await screen.findByText("決裁A")).toBeInTheDocument();
  });
});

describe("S-O01 cron: 楽観トグル + ロールバック", () => {
  const JOBS = [
    {
      id: "j1",
      name: "JobA",
      cron_expression: "0 9 * * *",
      enabled: true,
      next_run_at: null,
    },
  ];

  it("flips enabled immediately and restores it on failure", async () => {
    const get = vi.fn(async () => ({ data: JOBS }));
    const d = deferred<unknown>();
    const patch = vi.fn(() => d.promise);
    renderWithQuery(
      <CronScheduleContainer
        projectId="p1"
        client={fakeClient({ get, patch })}
      />,
    );

    // enabled=true → ラベルは「無効 化」（無効にするボタン）
    fireEvent.click(await screen.findByLabelText(/JobA を 無効 化/));
    // 楽観: 即座に enabled=false → ラベルが「有効 化」に
    expect(await screen.findByLabelText(/JobA を 有効 化/)).toBeInTheDocument();
    // 失敗 → ロールバックで enabled=true（ラベル「無効 化」）へ
    await act(async () => {
      d.reject(clientError());
      await Promise.resolve();
    });
    expect(await screen.findByLabelText(/JobA を 無効 化/)).toBeInTheDocument();
  });
});
