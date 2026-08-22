/**
 * GAP-168 — Bridge (本人の PC) が要る操作が「未接続」で止まったときに、
 * **その場で接続フローまで出す**ための共通表示。
 *
 * 従来はチャット画面にしか接続フローが無く、他の画面 (デザインテンプレ生成・
 * モック改訂・成果物ファイルの AI 編集) では 503 の文言が出るだけで、
 * どうすれば繋がるのかが分からなかった (経営者指摘の実装漏れ)。
 */

"use client";

import * as React from "react";
import { useState } from "react";
import { PlugZap } from "lucide-react";

import { ApiError } from "@atelier/api-client";

import { cn } from "../../lib/cn";
import { BridgeConnectFlow } from "./BridgeConnectFlow";

/**
 * 「Bridge 未接続が原因か」の判定。
 *
 * GAP-206 まではここが **503 かどうか**だけを見ていた。だが 503 は
 * 「保存先が未設定」「LLM 経路が未設定」でも返る。そのため設定漏れなのに
 * 「パソコンを繋いでください」と案内していた (利用者は永遠に直せない)。
 * 今は **サーバーが `X-Atelier-Reason` で申告したときだけ**未接続とみなす。
 */
export function isBridgeOffline(error: unknown): boolean {
  return error instanceof ApiError && error.reason === "bridge_offline";
}

export interface BridgeOfflineNoticeProps {
  /** 何をしようとして止まったか (例: 「テンプレの作成」)。 */
  readonly action?: string;
  /** 既定で接続手順を開いておく (未接続が確定している場面)。 */
  readonly defaultOpen?: boolean;
  readonly className?: string;
}

export function BridgeOfflineNotice({
  action,
  defaultOpen = true,
  className,
}: BridgeOfflineNoticeProps) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div
      role="alert"
      className={cn(
        "rounded-md border-l-[3px] border-error bg-error/10 px-2.5 py-2 text-[11.5px] text-on-surface",
        className,
      )}
    >
      <p className="flex items-center gap-1.5 font-semibold">
        <PlugZap className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
        お使いのパソコン (Bridge) が未接続のため{action ? `${action}を` : ""}実行できません
      </p>
      <p className="mt-0.5 text-on-surface-variant">
        この処理はあなたの PC の Claude で動きます。Bridge アプリを起動すると実行できます。
      </p>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="mt-1.5 rounded-sm border border-border bg-white px-2 py-0.5 text-[11px] font-semibold text-on-surface hover:bg-surface-variant"
      >
        {open ? "接続手順を閉じる" : "接続する"}
      </button>
      {open ? (
        <div className="mt-1.5">
          <BridgeConnectFlow />
        </div>
      ) : null}
    </div>
  );
}
