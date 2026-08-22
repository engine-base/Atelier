/**
 * GAP-158 — 出力デザインテンプレのスタジオ (Open Design 方式)。
 *
 * 3 ペイン: 種類リスト (左) / 大プレビュー (中央・A4 実寸を縮小表示) /
 * ワンダへの指示 + 版履歴 (右)。
 *   - 指示 → ワンダが HTML テンプレを作成/改訂 (本人サブスクの LLM チェーン) → 新版
 *   - 版履歴クリックで過去版をプレビュー (履歴は消さない)
 *   - これは「見た目の型」— 内容 (構成・文言) はスキルが担う旨を画面に明示
 */

"use client";

import * as React from "react";
import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { ApiError, type ApiClient } from "@atelier/api-client";

import { createAuthedApiClient } from "../../../lib/auth/connector";
import { readCurrentWorkspace } from "../../../lib/currentWorkspace";
import { Loading } from "../../../components/Loading";
import { BridgeOfflineNotice } from "../../../components/bridge/BridgeOfflineNotice";
import {
  ReferenceFilePicker,
  type ReferenceFileRef,
} from "../../../components/ReferenceFilePicker";
import { cn } from "../../../lib/cn";

/** 種類 = 成果物の stage 体系 (API の STAGE_LABELS と同一)。 */
export const TEMPLATE_KINDS: readonly { key: string; label: string }[] = [
  { key: "estimate", label: "見積書" },
  { key: "proposal", label: "提案書" },
  { key: "invoice", label: "請求書" },
  { key: "contract", label: "契約書" },
  { key: "nda", label: "NDA" },
  { key: "requirements", label: "要件定義書" },
  { key: "architecture", label: "アーキ設計書" },
  { key: "design", label: "デザイン仕様書" },
  { key: "verification", label: "テスト仕様書" },
  { key: "delivery", label: "納品書・完了報告" },
];

interface ApiTemplate {
  id: string;
  stage: string;
  stage_label: string;
  version: number;
  note: string;
  /** GAP-159: "platform" = 運営既定を継承中 / "workspace" = この WS の版 */
  source?: "workspace" | "platform";
  created_at?: string;
}

/** ISO → "YYYY-MM-DD HH:mm" (鉄則: 生 ISO を画面に出さない)。 */
function dateLabel(iso: string | undefined): string {
  return iso ? iso.slice(0, 16).replace("T", " ") : "";
}

// A4 相当のプレビュー幅 (CSS px) — 実寸で描いて枠に合わせて縮小する
const A4_W = 794;
const A4_H = 1123;

export interface DesignTemplateStudioProps {
  readonly client?: ApiClient;
  readonly workspaceId?: string;
  /**
   * GAP-159: "workspace" = 各社のデザイン (運営既定を継承・上書き・既定に戻す)、
   * "platform" = 運営 admin が全社の既定デザインそのものを作る。
   * UI と操作は同一 (経営者指示「管理側でも全く同じように更新や追加変更できる状態」)。
   */
  readonly mode?: "workspace" | "platform";
}

export function DesignTemplateStudio({
  client: injected,
  workspaceId: forcedWs,
  mode = "workspace",
}: DesignTemplateStudioProps) {
  const isPlatform = mode === "platform";
  const client = useMemo(() => injected ?? createAuthedApiClient(), [injected]);
  const queryClient = useQueryClient();
  const [kind, setKind] = useState<string>("estimate");
  const [instruction, setInstruction] = useState("");
  // GAP-161: 「この請求書に寄せて」等、参考資料を渡して作らせる
  const [refs, setRefs] = useState<readonly ReferenceFileRef[]>([]);
  const [viewVersionId, setViewVersionId] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ kind: "ok" | "error"; text: string } | null>(
    null,
  );
  // GAP-168: Bridge 未接続で止まったら、その場に接続フローを出す
  const [bridgeOffline, setBridgeOffline] = useState(false);
  const [elapsedS, setElapsedS] = useState(0);
  // プレビュー枠の実測 → A4 実寸を fit 縮小
  const canvasRef = useRef<HTMLDivElement | null>(null);
  const [availW, setAvailW] = useState(0);
  useEffect(() => {
    const el = canvasRef.current;
    if (!el) return;
    const update = () => setAvailW(el.clientWidth);
    update();
    const ro = typeof ResizeObserver !== "undefined" ? new ResizeObserver(update) : null;
    ro?.observe(el);
    return () => ro?.disconnect();
  }, []);

  // workspace 解決: 明示指定 → localStorage → /workspaces 先頭
  // (運営既定モードは workspace に紐づかないので解決自体を行わない)
  const wsQuery = useQuery({
    queryKey: ["workspaces", "for-templates"],
    enabled: !forcedWs && !isPlatform,
    queryFn: async () => {
      const res = await client.get("/workspaces", {});
      return ((res as { data?: { id: string }[] }).data ?? []) as { id: string }[];
    },
    retry: false,
  });
  const wsId = isPlatform
    ? "platform"
    : (forcedWs ??
      (typeof window !== "undefined" ? readCurrentWorkspace() : undefined) ??
      wsQuery.data?.[0]?.id);

  const versions = useQuery({
    queryKey: ["design-templates", wsId, kind, "versions"],
    enabled: Boolean(wsId),
    queryFn: async () => {
      const res = isPlatform
        ? await client.get("/admin/design-templates/{stage}/versions", {
            params: { path: { stage: kind } },
          })
        : await client.get(
            "/workspaces/{workspace_id}/design-templates/{stage}/versions",
            { params: { path: { workspace_id: wsId ?? "", stage: kind } } },
          );
      const d = (res as { data?: unknown }).data;
      return Array.isArray(d) ? (d as ApiTemplate[]) : [];
    },
    retry: false,
  });
  const latest = versions.data?.[0] ?? null;

  // 全種類の設定済みバッジ用
  const allLatest = useQuery({
    queryKey: ["design-templates", wsId, "latest"],
    enabled: Boolean(wsId),
    queryFn: async () => {
      const res = isPlatform
        ? await client.get("/admin/design-templates", {})
        : await client.get("/workspaces/{workspace_id}/design-templates", {
            params: { path: { workspace_id: wsId ?? "" } },
          });
      const d = (res as { data?: unknown }).data;
      return Array.isArray(d) ? (d as ApiTemplate[]) : [];
    },
    retry: false,
  });
  const configured = new Set((allLatest.data ?? []).map((t) => t.stage));
  // GAP-159: この WS 自前の版がある種類 (継承中との区別)
  const ownStages = new Set(
    (allLatest.data ?? []).filter((t) => t.source !== "platform").map((t) => t.stage),
  );
  // 「継承中」= 自前の版履歴が空で、かつ運営既定が実在してそれが効いている状態
  const inheritedLatest =
    !isPlatform && (versions.data ?? []).length === 0
      ? ((allLatest.data ?? []).find(
          (t) => t.stage === kind && t.source === "platform",
        ) ?? null)
      : null;
  const inheritingDefault = inheritedLatest !== null;

  const viewing =
    (viewVersionId
      ? (versions.data ?? []).find((v) => v.id === viewVersionId)
      : null) ??
    latest ??
    inheritedLatest;

  const contentUrl = useQuery({
    queryKey: ["design-templates", "content-url", viewing?.id],
    enabled: Boolean(viewing?.id),
    queryFn: async () => {
      const res = await client.get("/design-templates/{template_id}/content-url", {
        params: { path: { template_id: viewing?.id ?? "" } },
      });
      return (res as { data?: { url: string } }).data?.url ?? null;
    },
    retry: false,
  });

  const create = useMutation({
    retry: false,
    mutationFn: async () => {
      const res = isPlatform
        ? await client.post("/admin/design-templates/{stage}", {
            params: { path: { stage: kind } },
            body: { instruction: instruction.trim(), reference_files: [...refs] },
          })
        : await client.post("/workspaces/{workspace_id}/design-templates/{stage}", {
            params: { path: { workspace_id: wsId ?? "", stage: kind } },
            body: { instruction: instruction.trim(), reference_files: [...refs] },
          });
      return (res as { data?: ApiTemplate }).data ?? null;
    },
    onSuccess: (created) => {
      void queryClient.invalidateQueries({ queryKey: ["design-templates", wsId] });
      setBridgeOffline(false);
      setInstruction("");
      setRefs([]);
      setViewVersionId(null);
      setNotice({
        kind: "ok",
        text: created
          ? `ワンダが v${created.version} を作成しました${created.note ? ` — ${created.note}` : ""}`
          : "作成しました。",
      });
    },
    onError: (e) => {
      // GAP-206: 「503 なら未接続」ではない。サーバーが申告したときだけ接続導線を出し、
      // それ以外の 503 (LLM 経路の未設定等) は理由をそのまま見せる。
      if (e instanceof ApiError && e.reason === "bridge_offline") {
        setBridgeOffline(true);
        setNotice(null);
        return;
      }
      setBridgeOffline(false);
      const detail =
        e instanceof ApiError
          ? (e.payload as { detail?: unknown } | undefined)?.detail
          : undefined;
      setNotice({
        kind: "error",
        text:
          e instanceof ApiError && e.status === 503 && typeof detail === "string"
            ? detail
            : "テンプレの作成に失敗しました。時間をおいて再度お試しください。",
      });
    },
  });

  // GAP-159: このワークスペースの変更を捨てて運営既定に戻す (削除ではなく新版)
  const reset = useMutation({
    retry: false,
    mutationFn: async () => {
      const res = await client.post(
        "/workspaces/{workspace_id}/design-templates/{stage}/reset-to-default",
        { params: { path: { workspace_id: wsId ?? "", stage: kind } } },
      );
      return (res as { data?: ApiTemplate }).data ?? null;
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["design-templates", wsId] });
      setViewVersionId(null);
      setNotice({ kind: "ok", text: "運営の既定デザインに戻しました。" });
    },
    onError: (e) =>
      setNotice({
        kind: "error",
        text:
          e instanceof ApiError && e.status === 409
            ? "すでに運営の既定デザインを継承しています。"
            : e instanceof ApiError && e.status === 404
              ? "この種類の運営既定デザインはまだ設定されていません。"
              : "既定に戻せませんでした。時間をおいて再度お試しください。",
      }),
  });

  useEffect(() => {
    if (!create.isPending) {
      setElapsedS(0);
      return;
    }
    const start = Date.now();
    const t = setInterval(() => setElapsedS(Math.floor((Date.now() - start) / 1000)), 1000);
    return () => clearInterval(t);
  }, [create.isPending]);

  if (!forcedWs && wsQuery.isLoading) return <Loading className="py-md" />;
  if (!wsId) {
    return (
      <p role="alert" className="p-lg text-body-md text-on-surface-variant">
        ワークスペースが見つかりません。
      </p>
    );
  }

  const scale = availW > 48 ? Math.min(1, (availW - 48) / A4_W) : 1;
  const kindLabel = TEMPLATE_KINDS.find((k) => k.key === kind)?.label ?? kind;

  return (
    <section
      aria-label="出力デザインテンプレート"
      className="flex min-h-[calc(100dvh-3.5rem)] flex-col lg:flex-row"
    >
      {/* ── 種類リスト ── */}
      <aside
        aria-label="テンプレートの種類"
        className="w-full shrink-0 border-b border-border bg-surface p-sm lg:w-[240px] lg:border-b-0 lg:border-r"
      >
        <h1 className="px-2 py-1.5 text-[13px] font-bold text-on-surface">
          {isPlatform ? "既定デザインテンプレート（運営）" : "出力デザインテンプレート"}
        </h1>
        <p className="px-2 pb-2 text-[11px] leading-relaxed text-on-surface-variant">
          {isPlatform ? (
            <>
              全ワークスペースが<strong>初期状態で継承</strong>するデザイン。
              各社はこれを上書きでき、いつでも既定に戻せます。
            </>
          ) : (
            <>
              クライアントに見せる最終 HTML/PDF の<strong>見た目の型</strong>。
              内容の構成・文言はスキルが整えます — ここはデザインだけ。
            </>
          )}
        </p>
        <ul role="list" className="flex flex-row flex-wrap gap-1 lg:flex-col">
          {TEMPLATE_KINDS.map((k) => (
            <li key={k.key}>
              <button
                type="button"
                aria-pressed={kind === k.key}
                onClick={() => {
                  setKind(k.key);
                  setViewVersionId(null);
                  setNotice(null);
                }}
                className={cn(
                  "flex w-full items-center gap-1.5 rounded-md px-2.5 py-1.5 text-left text-[12.5px]",
                  kind === k.key
                    ? "bg-primary-container font-semibold text-on-primary-container"
                    : "text-on-surface-variant hover:bg-surface-variant hover:text-on-surface",
                )}
              >
                <span className="truncate">{k.label}</span>
                {configured.has(k.key) ? (
                  <span
                    className={cn(
                      "ml-auto h-1.5 w-1.5 shrink-0 rounded-full",
                      ownStages.has(k.key) ? "bg-tertiary" : "bg-on-surface-variant/40",
                    )}
                    title={ownStages.has(k.key) ? "このワークスペースで設定済み" : "運営既定を継承中"}
                  />
                ) : null}
              </button>
            </li>
          ))}
        </ul>
      </aside>

      {/* ── プレビュー (A4 実寸を fit 縮小) ── */}
      <div
        ref={canvasRef}
        className="flex min-h-[420px] flex-1 items-start justify-center overflow-auto bg-surface-variant/40 p-6"
      >
        {versions.isLoading ? (
          <Loading className="py-xl" />
        ) : viewing && contentUrl.data ? (
          <div
            style={{ width: A4_W * scale, height: A4_H * scale }}
            className="shrink-0"
          >
            <iframe
              title={`${kindLabel} デザインテンプレ ${
                inheritingDefault ? "運営既定" : `v${viewing.version}`
              }`}
              src={contentUrl.data}
              sandbox=""
              style={{
                width: A4_W,
                height: A4_H,
                transform: `scale(${scale})`,
                transformOrigin: "top left",
              }}
              className="rounded-sm border border-border bg-white shadow-md"
            />
          </div>
        ) : (
          <div className="mt-16 max-w-[420px] rounded-lg border border-dashed border-border bg-surface p-lg text-center">
            <p className="text-[14px] font-bold text-on-surface">
              「{kindLabel}」のテンプレはまだありません
            </p>
            <p className="mt-1 text-[12px] text-on-surface-variant">
              {isPlatform
                ? "右のボックスからワンダに指示すると、全ワークスペースが継承する既定デザインを作成します。"
                : "右のボックスからワンダに指示すると、A4/PDF 前提のデザインテンプレを作成します。以後この種類の成果物はこのデザインで出力されます。"}
            </p>
          </div>
        )}
      </div>

      {/* ── ワンダへの指示 + 版履歴 ── */}
      <aside
        aria-label="ワンダとデザインテンプレ"
        className="w-full shrink-0 border-t border-border bg-surface lg:w-[320px] lg:border-l lg:border-t-0"
      >
        <div className="border-b border-border px-md py-3">
          <h2 className="text-[13px] font-bold text-on-surface">
            {kindLabel}
            {viewing ? (
              <span className="ml-1.5 text-[11px] font-semibold text-on-surface-variant">
                {inheritingDefault ? (
                  "運営既定を継承中"
                ) : (
                  <>
                    v{viewing.version}
                    {viewing.id === latest?.id ? " · 最新" : "（過去版を表示中）"}
                  </>
                )}
              </span>
            ) : null}
          </h2>
          {!isPlatform && !inheritingDefault && latest ? (
            <button
              type="button"
              disabled={reset.isPending}
              onClick={() => {
                setNotice(null);
                reset.mutate();
              }}
              className="mt-1.5 rounded-md border border-border px-2 py-1 text-[11px] font-semibold text-on-surface-variant hover:bg-surface-variant hover:text-on-surface disabled:opacity-50"
            >
              {reset.isPending ? "戻しています…" : "運営の既定デザインに戻す"}
            </button>
          ) : null}
        </div>

        <form
          className="border-b border-border p-md"
          onSubmit={(e) => {
            e.preventDefault();
            if (instruction.trim() === "" || create.isPending) return;
            setNotice(null);
            create.mutate();
          }}
        >
          <label className="block">
            <span className="text-[11.5px] font-semibold text-on-surface-variant">
              ワンダへの指示（デザインの要望）
            </span>
            <textarea
              value={instruction}
              onChange={(e) => setInstruction(e.target.value)}
              rows={4}
              maxLength={4000}
              disabled={create.isPending}
              placeholder={
                latest
                  ? "例: ヘッダーを紺色の帯にして、明細表の罫線を細く"
                  : "例: 白基調でロゴ位置は右上、明細は罫線ありの表、判子欄つき"
              }
              className="mt-1 w-full resize-y rounded-md border border-border bg-surface px-sm py-2 text-[12.5px] text-on-surface outline-none placeholder:text-on-surface-variant focus-visible:border-primary disabled:opacity-60"
            />
          </label>
          {bridgeOffline ? (
            <BridgeOfflineNotice
              action={
                !inheritingDefault && latest ? "テンプレの改訂" : "テンプレの作成"
              }
              className="mt-2"
            />
          ) : null}
          <ReferenceFilePicker
            client={client}
            files={refs}
            onChange={setRefs}
            disabled={create.isPending}
            className="mt-2"
          />
          {notice ? (
            <p
              role={notice.kind === "error" ? "alert" : "status"}
              className={cn(
                "mt-2 rounded-md px-2.5 py-1.5 text-[11.5px]",
                notice.kind === "error"
                  ? "bg-error/10 text-error"
                  : "bg-tertiary-container text-tertiary-container-fg",
              )}
            >
              {notice.text}
            </p>
          ) : null}
          <div className="mt-2 flex items-center justify-end gap-2">
            {create.isPending ? (
              <span role="status" className="mr-auto text-[11.5px] text-on-surface-variant">
                ワンダが{latest ? "改訂" : "作成"}中… {elapsedS}s
              </span>
            ) : null}
            <button
              type="submit"
              disabled={instruction.trim() === "" || create.isPending}
              className="rounded-md bg-primary px-4 py-1.5 text-[12.5px] font-semibold text-on-primary hover:bg-primary-hover disabled:opacity-50"
            >
              {inheritingDefault
                ? "既定を元に変更する"
                : latest
                  ? "改訂を依頼"
                  : "テンプレを作成"}
            </button>
          </div>
        </form>

        <div className="p-sm">
          <h3 className="px-2 py-1 text-[11.5px] font-bold uppercase tracking-[0.1em] text-on-surface-variant">
            版履歴（{versions.data?.length ?? 0}）
          </h3>
          {(versions.data ?? []).length === 0 ? (
            <p className="px-2 py-2 text-[12px] text-on-surface-variant">
              まだ版はありません。
            </p>
          ) : (
            <ul role="list" aria-label="版一覧" className="flex flex-col gap-1">
              {(versions.data ?? []).map((v) => (
                <li key={v.id}>
                  <button
                    type="button"
                    onClick={() => setViewVersionId(v.id)}
                    aria-current={viewing?.id === v.id}
                    className={cn(
                      "w-full rounded-md px-2.5 py-2 text-left",
                      viewing?.id === v.id
                        ? "bg-primary-container text-on-primary-container"
                        : "text-on-surface hover:bg-surface-variant",
                    )}
                  >
                    <span className="flex items-center gap-2 text-[12.5px] font-bold">
                      v{v.version}
                      <span className="ml-auto text-[10.5px] font-normal tabular-nums opacity-80">
                        {dateLabel(v.created_at)}
                      </span>
                    </span>
                    {v.note ? (
                      <span className="mt-0.5 block text-[11px] opacity-90">{v.note}</span>
                    ) : null}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </aside>
    </section>
  );
}
