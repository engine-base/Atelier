/**
 * GAP-119 — S-E01 Claude 接続状態チップ + 詳細パネルのテスト
 *
 * GET /chat/connection-status をモックし:
 *   - relay + Bridge online → 「自分のプランで実行」+ worker 一覧
 *   - relay + offline → 「Bridge 未接続」+ 接続フロー (コマンドコピー)
 *   - プラン枠バー (5h/7日 の % とリセット時刻) — 観測値のみ描画
 *   - 未観測時は誠実な案内 (バーを出さない)
 *   - api モードは従量課金の明示
 */

// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";

import * as React from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import * as api from "../../lib/auth/connector";
import {
  ConnectionStatusChip,
  type ConnectionStatus,
} from "../../app/chat/s_e01/_components/ConnectionStatus";

afterEach(() => vi.restoreAllMocks());

function renderChip(status: ConnectionStatus) {
  vi.spyOn(api, "getJson").mockResolvedValue({ data: status } as never);
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <ConnectionStatusChip />
    </QueryClientProvider>,
  );
}

const RELAY_ONLINE: ConnectionStatus = {
  mode: "relay",
  bridge_online: true,
  workers: [
    { host_label: "my-mac", version: "1.2.0", last_seen_at: "2026-08-17T09:00:00Z" },
  ],
  last_job: {
    status: "done",
    error: null,
    created_at: "2026-08-17T08:59:00Z",
    finished_at: "2026-08-17T08:59:10Z",
  },
  plan: {
    status: "allowed_warning",
    five_hour_utilization: 0.42,
    five_hour_resets_at: "2026-08-17T12:00:00Z",
    seven_day_utilization: 0.1,
    seven_day_resets_at: "2026-08-20T00:00:00Z",
    observed_at: "2026-08-17T08:59:10Z",
  },
};

describe("S-E01 ConnectionStatusChip (GAP-119)", () => {
  it("relay + online: chip shows own-plan label and panel lists workers", async () => {
    renderChip(RELAY_ONLINE);
    await waitFor(() =>
      expect(screen.getByText("自分のプランで実行")).toBeInTheDocument(),
    );
    fireEvent.click(screen.getByRole("button", { name: "Claude 接続状態を確認" }));
    expect(await screen.findByRole("dialog", { name: "Claude 接続状態" })).toBeVisible();
    expect(screen.getByText("Bridge 接続中")).toBeInTheDocument();
    expect(screen.getByText(/my-mac · v1\.2\.0/)).toBeInTheDocument();
  });

  it("renders plan bars with % and reset time from observed values only", async () => {
    renderChip(RELAY_ONLINE);
    fireEvent.click(screen.getByRole("button", { name: "Claude 接続状態を確認" }));
    await screen.findByText("プラン枠の使用状況");
    expect(
      screen.getByRole("progressbar", { name: "5 時間枠の使用率" }),
    ).toHaveAttribute("aria-valuenow", "42");
    expect(
      screen.getByRole("progressbar", { name: "7 日間枠の使用率" }),
    ).toHaveAttribute("aria-valuenow", "10");
    expect(screen.getAllByText(/リセット/).length).toBeGreaterThan(0);
    // 観測時点の明示 (誠実設計)
    expect(screen.getByText(/実行時点の観測値/)).toBeInTheDocument();
    // 直近実行
    expect(screen.getByText(/直近の実行: 成功/)).toBeInTheDocument();
  });

  it("relay + offline: connect flow issues a token then offers one-click app link (GAP-122)", async () => {
    const writeText = vi.fn((_text: string) => Promise.resolve());
    Object.assign(navigator, { clipboard: { writeText } });
    // sendJson は data を unwrap して返す (connector 仕様)
    vi.spyOn(api, "sendJson").mockResolvedValue({
      token: "raw-user-token-xyz",
    } as never);
    renderChip({
      mode: "relay",
      bridge_online: false,
      workers: [],
      last_job: null,
      plan: null,
    });
    await waitFor(() =>
      expect(screen.getByText("Bridge 未接続")).toBeInTheDocument(),
    );
    fireEvent.click(screen.getByRole("button", { name: "Claude 接続状態を確認" }));
    expect(await screen.findByText("接続の手順")).toBeInTheDocument();
    // プラン未計測の誠実案内
    expect(screen.getByText(/まだ計測がありません/)).toBeInTheDocument();
    // ダウンロード導線 (全デスクトップ OS)
    expect(
      screen.getByRole("link", { name: /Mac \/ Windows \/ Linux/ }),
    ).toHaveAttribute("href", expect.stringContaining("/releases"));
    // トークン発行 → アプリで接続 (atelier-bridge:// ディープリンク)
    fireEvent.click(screen.getByRole("button", { name: "接続トークンを発行" }));
    const connectLink = await screen.findByRole("link", { name: "アプリで接続" });
    expect(connectLink.getAttribute("href")).toContain("atelier-bridge://connect?");
    expect(connectLink.getAttribute("href")).toContain(
      encodeURIComponent("raw-user-token-xyz"),
    );
    expect(api.sendJson).toHaveBeenCalledWith("POST", "/bridge-tokens", {
      label: "Bridge",
    });
    // fallback コマンドにも実トークンが入る
    fireEvent.click(screen.getByRole("button", { name: "起動コマンドをコピー" }));
    const copiedArg: unknown = writeText.mock.calls[0]?.[0];
    expect(String(copiedArg)).toContain("headless.js --loop");
    expect(String(copiedArg)).toContain("raw-user-token-xyz");
  });

  it("api mode is labeled as metered billing honestly", async () => {
    renderChip({
      mode: "api",
      bridge_online: false,
      workers: [],
      last_job: null,
      plan: null,
    });
    await waitFor(() =>
      expect(screen.getByText("API キーで実行 (従量課金)")).toBeInTheDocument(),
    );
    fireEvent.click(screen.getByRole("button", { name: "Claude 接続状態を確認" }));
    expect(
      await screen.findByText(/Anthropic API 従量課金/),
    ).toBeInTheDocument();
    // relay 以外では接続フローもプラン未計測案内も出さない
    expect(screen.queryByText("接続の手順")).toBeNull();
    expect(screen.queryByText(/まだ計測がありません/)).toBeNull();
  });

  it("shows overall status text when windows are unobserved but status exists", async () => {
    renderChip({
      mode: "relay",
      bridge_online: true,
      workers: [
        { host_label: "pc", version: "1.0.0", last_seen_at: "2026-08-17T09:00:00Z" },
      ],
      last_job: null,
      plan: {
        status: "rejected",
        five_hour_utilization: null,
        five_hour_resets_at: null,
        seven_day_utilization: null,
        seven_day_resets_at: null,
        observed_at: "2026-08-17T08:00:00Z",
      },
    });
    fireEvent.click(screen.getByRole("button", { name: "Claude 接続状態を確認" }));
    expect(await screen.findByText(/上限到達/)).toBeInTheDocument();
    expect(screen.queryByRole("progressbar")).toBeNull();
  });
});
