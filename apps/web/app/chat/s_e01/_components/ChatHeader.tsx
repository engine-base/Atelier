/**
 * S-E01 チャットヘッダー — モック .chat-header 準拠
 *
 * - 工程文脈バー: 「現在の工程：◯◯ · Stage n/9 · 進行中」+ 工程画面リンク
 * - AI 社員行: アバター + 名前 + 肩書きバッジ + ステータス行 (応答中は pulse)
 * - ペイン開閉トグル (スレッド一覧 / コンテキストパネル)
 */

"use client";

import * as React from "react";
import Link from "next/link";
import {
  ArrowLeft,
  ArrowRight,
  PanelLeft,
  PanelRight,
  Workflow,
} from "lucide-react";

import { cn } from "../../../../lib/cn";
import {
  employeeColor,
  employeeName,
  employeeTitle,
  type EmployeeLike,
} from "../../../../lib/aiEmployees";

export interface ChatHeaderProps {
  readonly projectId?: string | null;
  readonly phaseLabel?: string;
  readonly phaseIndex?: number; // 0-based
  readonly phaseTotal?: number;
  readonly employee?: EmployeeLike;
  /** AI 応答ストリーミング中 */
  readonly busy?: boolean;
  readonly leftOpen: boolean;
  readonly rightOpen: boolean;
  readonly onToggleLeft: () => void;
  readonly onToggleRight: () => void;
  /** モバイル: スレッド一覧へ戻る */
  readonly onBack?: () => void;
}

export function ChatHeader({
  projectId,
  phaseLabel,
  phaseIndex,
  phaseTotal,
  employee,
  busy = false,
  leftOpen,
  rightOpen,
  onToggleLeft,
  onToggleRight,
  onBack,
}: ChatHeaderProps) {
  const name = employeeName(employee) ?? "AI 社員";
  const title = employeeTitle(employee);

  return (
    <div className="flex shrink-0 flex-col gap-2 border-b border-border bg-surface/95 px-md pb-3 pt-[10px] backdrop-blur sm:px-[24px]">
      {/* 工程文脈バー */}
      {phaseLabel ? (
        <Link
          href={projectId ? `/workflow?project=${projectId}` : "/workflow"}
          className="flex items-center gap-2 rounded-md bg-primary-container px-3 py-[6px] text-[11.5px] text-on-primary-container transition-opacity hover:opacity-90"
        >
          <Workflow size={12} aria-hidden="true" className="shrink-0" />
          <strong>現在の工程：{phaseLabel}</strong>
          {typeof phaseIndex === "number" && phaseTotal ? (
            <span className="opacity-75 tabular-nums">
              · Stage {phaseIndex + 1} / {phaseTotal} · 進行中
            </span>
          ) : null}
          <span className="ml-auto hidden items-center gap-1 font-semibold sm:flex">
            工程画面で全体を見る
            <ArrowRight size={11} aria-hidden="true" />
          </span>
        </Link>
      ) : null}

      {/* AI 社員 + ステータス + ペイントグル */}
      <div className="flex items-center gap-3">
        {onBack ? (
          <button
            type="button"
            aria-label="スレッド一覧に戻る"
            onClick={onBack}
            className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-on-surface-variant hover:bg-surface-variant lg:hidden"
          >
            <ArrowLeft size={16} aria-hidden="true" />
          </button>
        ) : null}
        <span
          aria-hidden="true"
          className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full text-[15px] font-bold text-white"
          style={{ backgroundColor: employeeColor(employee) }}
        >
          {name.charAt(0)}
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <strong className="truncate text-[14.5px] text-on-surface">{name}</strong>
            {title ? (
              <span className="hidden rounded-full bg-primary-container px-2 py-[1px] text-[10.5px] font-bold text-on-primary-container sm:inline-flex">
                {title}
              </span>
            ) : null}
          </div>
          <div className="mt-[2px] flex items-center gap-[6px] text-[11px] text-on-surface-variant">
            <span
              aria-hidden="true"
              className={cn(
                "h-[6px] w-[6px] rounded-full bg-tertiary",
                busy && "animate-pulse",
              )}
            />
            {busy
              ? "応答を生成中… · F-CTX01 文脈を参照しています"
              : "稼働中 · F-CTX01 文脈を参照して応答します"}
          </div>
        </div>
        <button
          type="button"
          aria-label="スレッド一覧を開閉"
          aria-pressed={!leftOpen}
          onClick={onToggleLeft}
          className={cn(
            "hidden h-8 w-8 items-center justify-center rounded-md text-on-surface-variant hover:bg-surface-variant lg:inline-flex",
            !leftOpen && "bg-primary-container text-on-primary-container",
          )}
        >
          <PanelLeft size={15} aria-hidden="true" />
        </button>
        <button
          type="button"
          aria-label="コンテキストパネルを開閉"
          aria-pressed={!rightOpen}
          onClick={onToggleRight}
          className={cn(
            "inline-flex h-8 w-8 items-center justify-center rounded-md text-on-surface-variant hover:bg-surface-variant",
            !rightOpen && "bg-primary-container text-on-primary-container",
          )}
        >
          <PanelRight size={15} aria-hidden="true" />
        </button>
      </div>
    </div>
  );
}
