/**
 * グローバルエラー toast テスト（fix: AC「4xx/5xx で inline error + toast」の toast 部分）
 *
 *   - reportQueryError が ApiError 4xx/5xx で toast を push、401 は push しない
 *   - ToastViewport が store の toast を描画し dismiss できる
 */

// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";

import * as React from "react";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { ApiError } from "@atelier/api-client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { reportQueryError } from "../../lib/query-client";
import {
  clearToasts,
  getToastsSnapshot,
  pushToast,
} from "../../lib/toast/store";
import { ToastViewport } from "../../components/ui/ToastViewport";

function apiError(status: number): ApiError {
  return new ApiError({
    status,
    statusText: "x",
    payload: undefined,
    path: "/x",
    method: "get",
  });
}

beforeEach(() => clearToasts());
afterEach(() => clearToasts());

describe("global error toast", () => {
  it("pushes a toast for 4xx/5xx ApiError", () => {
    reportQueryError(apiError(403));
    reportQueryError(apiError(500));
    expect(getToastsSnapshot()).toHaveLength(2);
    expect(getToastsSnapshot()[0]!.message).toContain("権限がありません");
    expect(getToastsSnapshot()[1]!.message).toContain("サーバー");
  });

  it("does not toast on 401 (middleware refresh territory)", () => {
    reportQueryError(apiError(401));
    expect(getToastsSnapshot()).toHaveLength(0);
  });

  it("toasts a generic message for non-ApiError", () => {
    reportQueryError(new Error("boom"));
    expect(getToastsSnapshot()[0]!.message).toContain("通信エラー");
  });

  it("ToastViewport renders pushed toasts and dismisses them", () => {
    render(<ToastViewport />);
    expect(screen.queryByRole("region", { name: "通知" })).toBeNull();
    act(() => {
      pushToast("保存に失敗しました", "error");
    });
    expect(screen.getByText("保存に失敗しました")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /閉じる|dismiss|×/ }));
    expect(screen.queryByText("保存に失敗しました")).toBeNull();
  });
});
