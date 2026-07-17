/**
 * S-H01 モックビューア — T-UC-13 / モック忠実再構築
 *
 * 06_mockups/mock/S-H01-viewer.html の viewer-main を忠実に再現する。
 * 構成: ページ見出し → ツールバー(デバイス切替 + 寸法 + アクション) → プレビュー frame(iframe)。
 * 320 / 768 / 1024 / 1440 のレスポンシブ切替 (web/testing.md)。データは props(src/title)にバインド。
 */

"use client";

import * as React from "react";
import { useState } from "react";

import { cn } from "../../../../lib/cn";

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

export interface MockViewerProps {
  readonly src: string;
  readonly title: string;
  readonly initialPreset?: ViewportPreset;
}

export function MockViewer({
  src,
  title,
  initialPreset = "1024",
}: MockViewerProps) {
  const [preset, setPreset] = useState<ViewportPreset>(initialPreset);
  const width = VIEWPORT_W[preset];

  return (
    <section
      aria-label="モックビューア"
      className="flex flex-col overflow-hidden rounded-lg border border-border bg-surface"
    >
      {/* 見出し (モック topbar breadcrumb の末尾 = screen_name) */}
      <header className="border-b border-border bg-surface px-md py-md">
        <p className="text-label-sm font-bold uppercase tracking-[0.14em] text-on-surface-variant">
          モック
        </p>
        <h1 className="mt-1 text-headline-md font-bold tracking-tight text-on-surface">
          {title}
        </h1>
      </header>

      {/* ツールバー: デバイス切替 + 寸法 + アクション */}
      <div className="flex flex-wrap items-center gap-sm border-b border-border bg-surface px-md py-sm">
        <div
          role="group"
          aria-label="ビューポート切替"
          className="inline-flex gap-1 rounded-md bg-surface-variant p-1"
        >
          {PRESET_ORDER.map((p) => (
            <button
              key={p}
              type="button"
              onClick={() => setPreset(p)}
              aria-pressed={preset === p}
              aria-label={`${VIEWPORT_LABEL[p]} ${VIEWPORT_W[p]}px`}
              className={cn(
                "inline-flex items-center gap-1.5 rounded-sm px-sm py-1 text-label-sm font-semibold transition-colors",
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

        <div className="ml-auto flex items-center gap-xs">
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
        </div>
      </div>

      {/* プレビュー frame (device-frame) */}
      <div className="flex justify-center overflow-auto bg-surface-variant/40 p-lg">
        <div
          className="overflow-hidden rounded-lg bg-surface shadow-md transition-[width] duration-300 ease-out-expo"
          style={{ width }}
        >
          <iframe
            title={title}
            src={src}
            width={width}
            height={VIEWPORT_H}
            className="block w-full border-0 bg-surface"
          />
        </div>
      </div>
    </section>
  );
}
