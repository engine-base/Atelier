/**
 * S-H01 モックビューア — T-UC-13 / モック忠実再構築 (design-audit v2)
 *
 * 06_mockups/mock/S-H01-viewer.html の viewer-layout を忠実に再現する:
 *   - viewer-main : 見出し(バージョンピル + 修正依頼) → ツールバー(デバイス切替 +
 *     寸法 + 新規タブ/HTML DL) → プレビュー frame(iframe)
 *   - version-panel : バージョン履歴 (実 /mocks/{id}/versions) + コメント
 *     (実 /comments target_type=mock: 一覧/追加/解決)
 * 320 / 768 / 1024 / 1440 のレスポンシブ切替 (web/testing.md)。
 * storage 未設定 (content-url 503) 時は iframe 領域に honest メッセージを出しつつ
 * バージョン/コメントパネルは生かす (メタ系 API は dev でも動作するため)。
 * 「編集」= ワンダ (AI デザイナー) への修正依頼 (GAP-024 / Open Design パターン:
 * 自然言語指示 → LLM が HTML を改訂 → 新バージョン)。POST /mocks/{id}/revise。
 * バージョン操作 (複製 / 破棄) はモックの「…」メニュー相当。破棄は 2 段階確認 +
 * 唯一の生存バージョンは API が 409 で拒否。実 API 配線は MockViewerContainer が担う。
 */

"use client";

import * as React from "react";
import { useEffect, useState } from "react";
import Link from "next/link";

import { cn } from "../../../../lib/cn";

/** GAP-142: プレビュー内クリックで選択された要素 (postMessage の実値)。 */
export interface SelectedElement {
  readonly selector: string;
  readonly label: string;
  readonly html: string;
}

/** 選択要素を添えた修正指示の合成 (純関数 — テスト対象)。 */
export function composeInstruction(
  text: string,
  selected: SelectedElement | null,
): string {
  if (selected === null) return text;
  return (
    `対象要素 (CSS: ${selected.selector} / ${selected.label}) について: ${text}\n\n` +
    `対象要素の現在の HTML:\n${selected.html}`
  );
}

export type ViewportPreset = "320" | "768" | "1024" | "1440";

const VIEWPORT_W: Record<ViewportPreset, number> = {
  "320": 320,
  "768": 768,
  "1024": 1024,
  "1440": 1440,
};

const VIEWPORT_H = 600;

/** device-toggle 表示順 (モック Desktop → Tablet → Mobile の大→小に準拠)。 */
const PRESET_ORDER: readonly ViewportPreset[] = ["1440", "1024", "768", "320"];

const VIEWPORT_LABEL: Record<ViewportPreset, string> = {
  "1440": "ワイド",
  "1024": "デスクトップ",
  "768": "タブレット",
  "320": "モバイル",
};

type DeviceIconKind = "wide" | "desktop" | "tablet" | "mobile";

const PRESET_ICON: Record<ViewportPreset, DeviceIconKind> = {
  "1440": "wide",
  "1024": "desktop",
  "768": "tablet",
  "320": "mobile",
};

function DeviceIcon({ kind }: { readonly kind: DeviceIconKind }) {
  const common = {
    width: 13,
    height: 13,
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 2,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
    "aria-hidden": true,
  };
  if (kind === "mobile") {
    return (
      <svg {...common}>
        <rect x="7" y="3" width="10" height="18" rx="2" />
        <line x1="11" y1="18" x2="13" y2="18" />
      </svg>
    );
  }
  if (kind === "tablet") {
    return (
      <svg {...common}>
        <rect x="5" y="3" width="14" height="18" rx="2" />
        <line x1="11" y1="18" x2="13" y2="18" />
      </svg>
    );
  }
  // wide / desktop は共通のモニターアイコン
  return (
    <svg {...common}>
      <rect x="2" y="4" width="20" height="13" rx="2" />
      <line x1="8" y1="21" x2="16" y2="21" />
      <line x1="12" y1="17" x2="12" y2="21" />
    </svg>
  );
}

function ExternalLinkIcon() {
  return (
    <svg
      width={13}
      height={13}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
      <polyline points="15 3 21 3 21 9" />
      <line x1="10" y1="14" x2="21" y2="3" />
    </svg>
  );
}

function DownloadIcon() {
  return (
    <svg
      width={13}
      height={13}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
      <polyline points="7 10 12 15 17 10" />
      <line x1="12" y1="15" x2="12" y2="3" />
    </svg>
  );
}

function MessageIcon() {
  return (
    <svg
      width={13}
      height={13}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
    </svg>
  );
}


/** バージョン履歴カード 1 件分 (実 /mocks/{id}/versions の 1 行)。 */
export interface MockVersionItem {
  readonly id: string;
  readonly version: number;
  /** YYYY-MM-DD HH:mm 済みの表示文字列 */
  readonly createdAt: string;
  /** meta_tags.note (変更概要)。無ければ非表示。 */
  readonly note?: string;
  /** 作成主体の表示名 (meta_tags.author=wanda → 「ワンダ（更新）」)。 */
  readonly author?: string;
  /** ワンダへの修正指示文 (meta_tags.revision_instruction)。 */
  readonly instruction?: string;
  /** このバージョンを表示する URL (/mocks?mock={id}) */
  readonly href: string;
  /** いま表示中のバージョンか */
  readonly current: boolean;
}

export interface MockCommentItem {
  readonly id: string;
  readonly author: string;
  readonly content: string;
  readonly createdAt: string;
  readonly resolved?: boolean;
  readonly isReply?: boolean;
}

function authorInitial(author: string): string {
  const trimmed = author.trim();
  return trimmed ? Array.from(trimmed)[0]! : "?";
}

export interface MockViewerProps {
  /** 署名付き閲覧 URL。null なら frame 領域に srcError を表示する。 */
  readonly src: string | null;
  readonly title: string;
  readonly initialPreset?: ViewportPreset;
  /** src=null 時に frame 領域へ出すメッセージ。 */
  readonly srcError?: string;
  /** ヘッダーのバージョンピル (例: "v3 · 最新")。 */
  readonly versionLabel?: string;
  /** 修正依頼 (プロジェクトチャットへの導線)。未指定なら出さない。 */
  readonly chatHref?: string;
  /** バージョン履歴。未指定 (undefined) ならパネル自体を出さない。 */
  readonly versions?: readonly MockVersionItem[];
  /** コメント一覧。未指定 (undefined) ならセクション自体を出さない。 */
  readonly comments?: readonly MockCommentItem[];
  /** コメント追加。未指定なら追加フォームを出さない。 */
  readonly onAddComment?: (content: string) => void;
  /** コメントを解決済みにする (PATCH status=resolved)。 */
  readonly onResolve?: (id: string) => void;
  /** 「編集」= ワンダ (AI) への修正依頼。未指定ならボタンを出さない。 */
  readonly onRevise?: (instruction: string) => void;
  /** 修正依頼の実行中 (ワンダが改訂中)。 */
  readonly revising?: boolean;
  /** バージョン複製 (「…」メニュー相当)。未指定なら出さない。 */
  readonly onDuplicate?: (versionId: string) => void;
  /** バージョン破棄 (2 段階確認)。未指定なら出さない。 */
  readonly onDiscard?: (versionId: string) => void;
  /** 直近のバージョン操作の結果通知 (成功)。 */
  readonly actionNotice?: string;
  /** 直近のバージョン操作の結果通知 (失敗)。 */
  readonly actionError?: string;
}

export function MockViewer({
  src,
  title,
  initialPreset = "1024",
  srcError,
  versionLabel,
  chatHref,
  versions,
  comments,
  onAddComment,
  onResolve,
  onRevise,
  revising = false,
  onDuplicate,
  onDiscard,
  actionNotice,
  actionError,
}: MockViewerProps) {
  const [preset, setPreset] = useState<ViewportPreset>(initialPreset);
  const [draft, setDraft] = useState("");
  const [instructionDraft, setInstructionDraft] = useState("");
  // 破棄の 2 段階確認: 対象バージョン id (null = 確認中なし)
  const [discardTarget, setDiscardTarget] = useState<string | null>(null);
  // GAP-142 (Open Design / Studio 型): 要素選択モード + 選択中要素
  const [selecting, setSelecting] = useState(false);
  const [selected, setSelected] = useState<SelectedElement | null>(null);
  useEffect(() => {
    const onMessage = (ev: MessageEvent) => {
      const d = ev.data as
        | { type?: string; selector?: string; label?: string; html?: string }
        | null;
      if (
        d &&
        d.type === "atelier-element-selected" &&
        typeof d.selector === "string" &&
        typeof d.label === "string"
      ) {
        setSelected({
          selector: d.selector,
          label: d.label,
          html: typeof d.html === "string" ? d.html : "",
        });
      }
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, []);
  const width = VIEWPORT_W[preset];
  const openCount = (comments ?? []).filter((c) => !c.resolved).length;
  const hasSidePanel = versions !== undefined || comments !== undefined;
  // 選択モード中は配信 HTML に選択スクリプトを注入した URL を使う (mockdb のみ有効)
  const frameSrc = src === null ? null : selecting ? `${src}&sel=1` : src;
  // 会話パネル: バージョン履歴を「指示 → ワンダの応答」の会話として古い順に描く
  const conversation = [...(versions ?? [])].sort((a, b) => a.version - b.version);

  return (
    <section
      aria-label="モックビューア"
      className="flex flex-col overflow-hidden rounded-lg border border-border bg-surface"
    >
      {/* 見出し (モック topbar: breadcrumb 末尾 + version-pill + 修正依頼) */}
      <header className="flex flex-wrap items-end justify-between gap-sm border-b border-border bg-surface px-md py-md">
        <div>
          <p className="text-label-sm font-bold uppercase tracking-[0.14em] text-on-surface-variant">
            モック
          </p>
          <h1 className="mt-1 text-headline-md font-bold tracking-tight text-on-surface">
            {title}
          </h1>
        </div>
        <div className="flex items-center gap-sm">
          {versionLabel ? (
            <span className="inline-flex items-center rounded-full bg-tertiary-container px-2.5 py-1 text-[11px] font-semibold text-tertiary-container-fg">
              {versionLabel}
            </span>
          ) : null}
          {chatHref ? (
            <Link
              href={chatHref}
              className="inline-flex items-center gap-1.5 rounded-md border border-primary px-sm py-1.5 text-label-sm font-semibold text-primary transition-colors hover:bg-primary-container focus-visible:outline-2 focus-visible:outline-primary"
            >
              <MessageIcon />
              修正依頼
            </Link>
          ) : null}
        </div>
      </header>

      <div
        className={cn(
          "grid grid-cols-1",
          onRevise && hasSidePanel
            ? "lg:grid-cols-[300px_1fr] xl:grid-cols-[300px_1fr_320px]"
            : onRevise
              ? "lg:grid-cols-[300px_1fr]"
              : hasSidePanel && "lg:grid-cols-[1fr_320px]",
        )}
      >
        {/* ── GAP-142: ワンダのスタジオパネル (Open Design / Studio 型) ──
            会話 (バージョン履歴) + 指示入力 + 要素クリック選択をプレビューの
            隣に常設する。 */}
        {onRevise ? (
          <aside
            aria-label="ワンダとデザイン"
            className="flex min-h-0 flex-col border-b border-border bg-surface lg:max-h-[720px] lg:border-b-0 lg:border-r"
          >
            <div className="border-b border-border px-md py-3.5">
              <h2 className="text-[13px] font-bold text-on-surface">
                ワンダとデザイン
              </h2>
              <p className="mt-0.5 text-[11px] text-on-surface-variant">
                指示するたびに新しいバージョンが作られます
              </p>
            </div>
            <div
              role="log"
              aria-label="デザインの会話履歴"
              className="min-h-0 flex-1 overflow-y-auto px-md py-sm"
            >
              <ul className="space-y-2">
              {conversation.length === 0 ? (
                <li className="text-[12px] text-on-surface-variant">
                  まだ履歴がありません。下の入力からワンダに指示してください。
                </li>
              ) : null}
              {conversation.map((v) => (
                <li key={v.id} className="space-y-1.5">
                  {v.instruction ? (
                    <p className="ml-6 rounded-lg rounded-br-sm bg-primary-container px-2.5 py-1.5 text-[12px] leading-relaxed text-primary-container-fg">
                      {v.instruction}
                    </p>
                  ) : null}
                  <p className="mr-6 rounded-lg rounded-bl-sm bg-surface-variant px-2.5 py-1.5 text-[12px] leading-relaxed text-on-surface">
                    <span className="font-semibold">ワンダ:</span> v{v.version}{" "}
                    を作成しました
                    {v.note ? ` — ${v.note}` : ""}
                    {v.current ? (
                      <span className="ml-1 text-[10.5px] text-primary">
                        (表示中)
                      </span>
                    ) : null}
                  </p>
                </li>
              ))}
              </ul>
            </div>
            <div className="border-t border-border px-md py-sm">
              {/* 要素クリック選択 (Open Design 型): プレビュー内をクリックして対象を指定 */}
              <div className="mb-1.5 flex flex-wrap items-center gap-1.5">
                <button
                  type="button"
                  aria-pressed={selecting}
                  onClick={() => {
                    setSelecting((v) => !v);
                    if (selecting) setSelected(null);
                  }}
                  className={cn(
                    "rounded-md border px-2 py-1 text-[11px] font-semibold transition-colors",
                    selecting
                      ? "border-primary bg-primary text-on-primary"
                      : "border-border text-on-surface-variant hover:border-primary hover:text-primary",
                  )}
                >
                  {selecting ? "要素を選択中 (クリックで指定)" : "要素を選択"}
                </button>
                {selected ? (
                  <span className="inline-flex max-w-full items-center gap-1 truncate rounded-full bg-tertiary-container px-2 py-0.5 text-[11px] text-tertiary-container-fg">
                    <span className="truncate">選択中: {selected.label}</span>
                    <button
                      type="button"
                      aria-label="選択を解除"
                      onClick={() => setSelected(null)}
                      className="font-bold"
                    >
                      ×
                    </button>
                  </span>
                ) : null}
              </div>
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  const text = instructionDraft.trim();
                  if (!text || revising) return;
                  onRevise(composeInstruction(text, selected));
                  setInstructionDraft("");
                }}
              >
                <label className="block">
                  <span className="sr-only">ワンダへの指示</span>
                  <textarea
                    value={instructionDraft}
                    onChange={(e) => setInstructionDraft(e.target.value)}
                    rows={3}
                    maxLength={4000}
                    disabled={revising}
                    placeholder={
                      selected
                        ? "選択した要素をどう変えますか？ (例: 文言を「今すぐ試す」に)"
                        : "例: ヘッダーをブランドカラーに。CTA を右上に移動"
                    }
                    className="w-full resize-y rounded-md border border-border bg-surface px-sm py-2 text-[12.5px] text-on-surface outline-none placeholder:text-on-surface-variant focus-visible:border-primary disabled:opacity-60"
                  />
                </label>
                <div className="mt-1.5 flex items-center justify-between gap-xs">
                  {revising ? (
                    <span role="status" className="text-[11.5px] text-on-surface-variant">
                      ワンダが改訂中…
                    </span>
                  ) : (
                    <span className="text-[10.5px] text-on-surface-variant">
                      あなたの Claude プランで実行
                    </span>
                  )}
                  <button
                    type="submit"
                    disabled={!instructionDraft.trim() || revising}
                    className="inline-flex items-center rounded-md bg-primary px-4 py-1.5 text-[12px] font-semibold text-on-primary transition-colors hover:bg-primary-hover disabled:opacity-50"
                  >
                    送信
                  </button>
                </div>
              </form>
            </div>
          </aside>
        ) : null}

        {/* ── viewer-main ─────────────────────────────── */}
        <div className="flex min-w-0 flex-col">
          {/* ツールバー: デバイス切替 + 寸法 + アクション */}
          <div className="flex flex-wrap items-center gap-sm border-b border-border bg-surface px-md py-sm">
            <div
              role="group"
              aria-label="ビューポート切替"
              className="inline-flex max-w-full gap-1 overflow-x-auto rounded-md bg-surface-variant p-1"
            >
              {PRESET_ORDER.map((p) => (
                <button
                  key={p}
                  type="button"
                  onClick={() => setPreset(p)}
                  aria-pressed={preset === p}
                  aria-label={`${VIEWPORT_LABEL[p]} ${VIEWPORT_W[p]}px`}
                  className={cn(
                    "inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-sm px-sm py-1 text-label-sm font-semibold transition-colors",
                    preset === p
                      ? "bg-surface text-on-surface shadow-sm"
                      : "text-on-surface-variant hover:text-on-surface",
                  )}
                >
                  <DeviceIcon kind={PRESET_ICON[p]} />
                  {VIEWPORT_LABEL[p]}
                </button>
              ))}
            </div>

            <div className="flex items-center gap-1 text-body-sm tabular-nums text-on-surface-variant">
              {width} × {VIEWPORT_H}
            </div>

            {src || onRevise ? (
              <div className="ml-auto flex items-center gap-xs">
                {src ? (
                  <>
                    <a
                      href={src}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline-flex items-center gap-1.5 rounded-md px-sm py-1.5 text-label-sm font-semibold text-on-surface transition-colors hover:bg-surface-variant focus-visible:outline-2 focus-visible:outline-primary"
                    >
                      <ExternalLinkIcon />
                      新規タブ
                    </a>
                    <a
                      href={src}
                      download
                      className="inline-flex items-center gap-1.5 rounded-md border border-primary px-sm py-1.5 text-label-sm font-semibold text-primary transition-colors hover:bg-primary-container focus-visible:outline-2 focus-visible:outline-primary"
                    >
                      <DownloadIcon />
                      HTML
                    </a>
                  </>
                ) : null}
              </div>
            ) : null}
          </div>

          {/* バージョン操作の結果通知 (成功 / 失敗) */}
          {actionError ? (
            <p
              role="alert"
              className="border-b border-border bg-error/10 px-md py-2 text-[12.5px] text-error"
            >
              {actionError}
            </p>
          ) : actionNotice ? (
            <p
              role="status"
              className="border-b border-border bg-tertiary-container px-md py-2 text-[12.5px] text-tertiary-container-fg"
            >
              {actionNotice}
            </p>
          ) : null}

          {/* プレビュー frame (device-frame) */}
          <div className="flex justify-center overflow-auto bg-surface-variant/40 p-lg">
            <div
              className="overflow-hidden rounded-lg bg-surface shadow-md transition-[width] duration-300 ease-out-expo"
              style={{ width }}
            >
              {frameSrc ? (
                <iframe
                  title={title}
                  src={frameSrc}
                  width={width}
                  height={VIEWPORT_H}
                  className="block w-full border-0 bg-surface"
                />
              ) : (
                <p
                  role="alert"
                  className="flex min-h-[240px] items-center justify-center px-lg text-center text-body-md text-on-surface-variant"
                >
                  {srcError ?? "モックを表示できません。"}
                </p>
              )}
            </div>
          </div>
        </div>

        {/* ── version-panel (モック .version-panel 準拠) ── */}
        {hasSidePanel ? (
          <aside
            aria-label="バージョンとコメント"
            className="flex min-w-0 flex-col border-t border-border bg-surface lg:border-l lg:border-t-0"
          >
            {versions !== undefined ? (
              <>
                <div className="border-b border-border px-md py-3.5">
                  <h2 className="text-[13px] font-bold text-on-surface">
                    バージョン履歴（{versions.length}）
                  </h2>
                  {versions.length > 0 ? (
                    <p className="mt-0.5 text-[11.5px] text-on-surface-variant">
                      version chain · 最新が v
                      {Math.max(...versions.map((v) => v.version))}
                    </p>
                  ) : null}
                </div>
                <div className="p-xs">
                  {versions.length === 0 ? (
                    <p className="px-md py-md text-center text-body-sm text-on-surface-variant">
                      バージョン履歴はまだありません。
                    </p>
                  ) : (
                    <ul
                      role="list"
                      aria-label="バージョン一覧"
                      className="flex flex-col gap-1"
                    >
                      {versions.map((v) => {
                        const inner = (
                          <>
                            <span className="flex items-center gap-2">
                              <span className="text-[13px] font-bold">
                                v{v.version}
                              </span>
                              {v.current ? (
                                <span className="ml-auto inline-flex items-center rounded-sm bg-tertiary-container px-1.5 py-0.5 text-[10px] font-semibold text-tertiary-container-fg">
                                  表示中
                                </span>
                              ) : null}
                            </span>
                            {v.author ? (
                              <span className="mt-0.5 block text-[11px] font-semibold opacity-90">
                                {v.author}
                              </span>
                            ) : null}
                            <span className="mt-0.5 block text-[11px] tabular-nums opacity-80">
                              {v.createdAt}
                            </span>
                            {v.instruction ? (
                              <span className="mt-1.5 block rounded-md bg-secondary-container px-2.5 py-1.5 text-[11px] text-secondary-container-fg">
                                修正指示: {v.instruction}
                              </span>
                            ) : null}
                            {v.note ? (
                              <span className="mt-1.5 block rounded-md bg-secondary-container px-2.5 py-1.5 text-[11px] text-secondary-container-fg">
                                {v.note}
                              </span>
                            ) : null}
                          </>
                        );
                        const actions =
                          onDuplicate || onDiscard ? (
                            <div className="mt-1 flex items-center justify-end gap-1 px-1.5">
                              {discardTarget === v.id ? (
                                <>
                                  <span className="mr-auto text-[10.5px] text-error">
                                    v{v.version} を破棄しますか？
                                  </span>
                                  <button
                                    type="button"
                                    onClick={() => setDiscardTarget(null)}
                                    className="rounded-sm px-1.5 py-0.5 text-[10.5px] font-semibold text-on-surface-variant hover:bg-surface-variant"
                                  >
                                    戻す
                                  </button>
                                  {onDiscard ? (
                                    <button
                                      type="button"
                                      onClick={() => {
                                        setDiscardTarget(null);
                                        onDiscard(v.id);
                                      }}
                                      className="rounded-sm bg-error px-1.5 py-0.5 text-[10.5px] font-semibold text-on-error hover:opacity-90"
                                    >
                                      破棄を確定
                                    </button>
                                  ) : null}
                                </>
                              ) : (
                                <>
                                  {onDuplicate ? (
                                    <button
                                      type="button"
                                      onClick={() => onDuplicate(v.id)}
                                      aria-label={`v${v.version} を複製`}
                                      className="rounded-sm px-1.5 py-0.5 text-[10.5px] font-semibold text-on-surface-variant hover:bg-surface-variant"
                                    >
                                      複製
                                    </button>
                                  ) : null}
                                  {onDiscard ? (
                                    <button
                                      type="button"
                                      onClick={() => setDiscardTarget(v.id)}
                                      aria-label={`v${v.version} を破棄`}
                                      className="rounded-sm px-1.5 py-0.5 text-[10.5px] font-semibold text-error hover:bg-error/10"
                                    >
                                      破棄
                                    </button>
                                  ) : null}
                                </>
                              )}
                            </div>
                          ) : null;
                        return (
                          <li key={v.id}>
                            {v.current ? (
                              <div
                                aria-current="true"
                                className="rounded-md bg-primary-container px-3.5 py-3 text-on-primary-container"
                              >
                                {inner}
                              </div>
                            ) : (
                              <Link
                                href={v.href}
                                className="block rounded-md px-3.5 py-3 text-on-surface transition-colors hover:bg-surface-variant"
                              >
                                {inner}
                              </Link>
                            )}
                            {actions}
                          </li>
                        );
                      })}
                    </ul>
                  )}
                </div>
              </>
            ) : null}

            {comments !== undefined ? (
              <>
                <div className="flex items-center justify-between border-b border-t border-border px-md py-3.5">
                  <h2 className="text-[13px] font-bold text-on-surface">
                    コメント（{comments.length}）
                  </h2>
                  {openCount > 0 ? (
                    <span className="inline-flex items-center rounded-sm bg-secondary-container px-2 py-0.5 text-[10.5px] font-semibold text-secondary-container-fg">
                      未解決 {openCount}
                    </span>
                  ) : comments.length > 0 ? (
                    <span className="inline-flex items-center rounded-sm bg-tertiary-container px-2 py-0.5 text-[10.5px] font-semibold text-tertiary-container-fg">
                      すべて解決済み
                    </span>
                  ) : null}
                </div>
                <div className="flex-1 overflow-y-auto p-sm">
                  {comments.length === 0 ? (
                    <p className="px-md py-lg text-center text-body-sm text-on-surface-variant">
                      コメントはまだありません。
                    </p>
                  ) : (
                    <ul
                      role="list"
                      aria-label="コメント一覧"
                      className="flex flex-col gap-sm"
                    >
                      {comments.map((c) => (
                        <li
                          key={c.id}
                          className={cn(
                            "rounded-md p-3",
                            c.resolved
                              ? "bg-tertiary-container text-tertiary-container-fg"
                              : "bg-surface-variant",
                            c.isReply && "ml-4 border-l-2 border-border",
                          )}
                        >
                          <div className="mb-1.5 flex items-center gap-2">
                            <span
                              aria-hidden="true"
                              className="inline-flex h-6 w-6 items-center justify-center rounded-full bg-primary text-[11px] font-bold text-on-primary"
                            >
                              {authorInitial(c.author)}
                            </span>
                            <span className="text-[12.5px] font-bold">
                              {c.author}
                            </span>
                            <span className="ml-auto text-[11px] tabular-nums opacity-80">
                              {c.resolved ? "解決済み · " : ""}
                              {c.createdAt}
                            </span>
                          </div>
                          <p className="text-[13px] leading-relaxed">
                            {c.content}
                          </p>
                          {!c.resolved && onResolve ? (
                            <div className="mt-2 flex justify-end">
                              <button
                                type="button"
                                onClick={() => onResolve(c.id)}
                                className="rounded-sm px-2 py-1 text-[11px] font-semibold text-tertiary hover:bg-white/60"
                              >
                                解決にする
                              </button>
                            </div>
                          ) : null}
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
                {onAddComment ? (
                  <div className="border-t border-border p-md">
                    <form
                      className="rounded-md bg-surface-variant p-2.5"
                      onSubmit={(e) => {
                        e.preventDefault();
                        const text = draft.trim();
                        if (!text) return;
                        onAddComment(text);
                        setDraft("");
                      }}
                    >
                      <label className="block">
                        <span className="sr-only">コメントを追加</span>
                        <textarea
                          value={draft}
                          onChange={(e) => setDraft(e.target.value)}
                          rows={2}
                          placeholder="コメントを追加…"
                          className="w-full resize-none border-0 bg-transparent text-[13px] text-on-surface outline-none placeholder:text-on-surface-variant"
                        />
                      </label>
                      <div className="mt-2 flex justify-end">
                        <button
                          type="submit"
                          disabled={!draft.trim()}
                          className="inline-flex items-center rounded-md bg-primary px-4 py-1.5 text-[12px] font-semibold text-on-primary transition-colors hover:bg-primary-hover disabled:opacity-50"
                        >
                          コメント
                        </button>
                      </div>
                    </form>
                  </div>
                ) : null}
              </>
            ) : null}
          </aside>
        ) : null}
      </div>
    </section>
  );
}
