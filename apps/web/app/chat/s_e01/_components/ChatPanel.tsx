/**
 * S-E01 チャットパネル — T-UC-08 (assistant-ui + SSE + tool-ui)
 *
 * モック 06_mockups/chat/S-E01-thread.html の中央チャットペイン (メッセージスレッド +
 * コンポーザ) に忠実な presentational:
 *   - user: 右寄せ primary バブル + 「あなた + 時刻」メタ
 *   - assistant: AI 社員アバター + 名前 + 時刻 + 本文
 *   - tool: モックの .tool-card (monospace ツール名 + 本文)
 *   - composer: 「<社員名>にメッセージ…」placeholder / Enter 送信 / Shift+Enter 改行 /
 *     添付 (GAP-001 — 署名付き URL 2 段階アップロード) / /コマンド (GAP-002 —
 *     /要約=SSE 依頼・/決定・/タスク化=サーバー実行) / @メンション / ナレッジ参照
 * データ配線・props・a11y 契約 (log role / aria-live / メッセージを入力 label) は不変。
 */

"use client";

import { colors } from "@atelier/design-tokens";
import * as React from "react";
import { useEffect, useRef, useState } from "react";
import {
  AtSign,
  Brain,
  Check,
  CircleAlert,
  Copy,
  GitBranch,
  Paperclip,
  SendHorizontal,
  ShieldCheck,
  Square,
  Terminal,
  Upload,
  X,
  Zap,
} from "lucide-react";

import { fmtTime } from "../../../../lib/format";
import { MessageContent } from "./MessageContent";

export type ChatRole = "user" | "assistant" | "system" | "tool";

export interface ChatMessageAttachment {
  readonly file_name: string;
  readonly mime_type: string;
  readonly file_size_bytes: number;
}

export interface ChatMessage {
  readonly id: string;
  readonly role: ChatRole;
  readonly content: string;
  readonly created_at?: string;
  /** 添付 (GAP-001 — chat_messages.attachments)。 */
  readonly attachments?: readonly ChatMessageAttachment[];
  /**
   * サーバーに永続化済み (= id が実 ID)。フィードバック等の per-message API は
   * 実 ID が必要なため、true のときだけアクション行を描画する
   * (ストリーミング中の楽観行はローカル ID なので対象外)。
   */
  readonly persisted?: boolean;
}

export interface ChatEmployeeInfo {
  readonly name: string;
  readonly color: string;
}

export interface MentionCandidate {
  readonly id: string;
  readonly name: string;
  readonly color?: string;
}

export interface KnowledgeCandidate {
  readonly id: string;
  readonly title: string;
}

/** GAP-148: ツール実行 1 件 (Claude Code 風の行 — 実入力の要約つき)。 */
export interface ToolRunItem {
  readonly tool: string;
  /** 実入力の要約 (Bash はコマンド、Edit/Write はファイルパス等)。 */
  readonly summary?: string;
}

export interface ChatPanelProps {
  readonly messages: readonly ChatMessage[];
  readonly onSend: (text: string) => void;
  readonly disabled?: boolean;
  /** 対話相手の AI 社員 (アバター/名前/placeholder 用)。 */
  readonly employee?: ChatEmployeeInfo;
  /** 送信エラー (コンポーザ直上に 1 箇所だけ表示、閉じるで消える)。 */
  readonly errorNotice?: string | null;
  readonly onDismissError?: () => void;
  /** @メンション候補 (他の AI 社員)。 */
  readonly mentionCandidates?: readonly MentionCandidate[];
  /** ナレッジ参照候補 (プロジェクトの実ナレッジ)。 */
  readonly knowledgeCandidates?: readonly KnowledgeCandidate[];
  /**
   * 「役立った」フィードバック (persisted な assistant メッセージのみ描画)。
   * 未指定なら feedback ボタン自体を出さない (Rule 10)。
   */
  readonly onFeedback?: (messageId: string) => void;
  /** フィードバック送信済みメッセージ ID (ボタンを「済」表示にする)。 */
  readonly feedbackDoneIds?: ReadonlySet<string>;
  /**
   * 分岐 (GAP-031① — POST /chat/messages/{id}/branch)。このメッセージ時点で
   * 新スレッドへ履歴コピーして分岐する。未指定ならボタンを出さない (Rule 10)。
   */
  readonly onBranch?: (messageId: string) => void;
  readonly branching?: boolean;
  /**
   * ツール実行の承認待ち (GAP-031① — approval_inbox type=tool_execution)。
   * pending がある時のみ承認カード (モック .approval-card 準拠) を描画する。
   */
  readonly toolApprovals?: readonly ToolApprovalInfo[];
  readonly onApproveTool?: (approvalId: string) => void;
  readonly onRejectTool?: (approvalId: string) => void;
  readonly toolActing?: boolean;
  /**
   * 添付 (GAP-001)。onPickAttachments 未指定なら添付ボタン自体を出さない (Rule 10)。
   * pendingAttachments は送信前の選択済ファイル (チップ表示 + 個別削除)。
   */
  readonly onPickAttachments?: (files: readonly File[]) => void;
  readonly pendingAttachments?: readonly { name: string; size: number }[];
  readonly onRemoveAttachment?: (index: number) => void;
  readonly attachmentError?: string | null;
  /** GAP-128: 生成中の assistant メッセージ ID (TypingIndicator/カーソルの対象)。 */
  readonly pendingAssistantId?: string | null;
  /** GAP-128: 生成の段階 (context=文脈構築中 / answer=最初の応答待ち / streaming=本文受信中)。 */
  readonly pendingStage?: "context" | "answer" | "streaming" | null;
  /**
   * GAP-189: 実行の制御 — 中断 / 実行中の追い足し。
   *
   * 経営者指摘「中断とか入ってないけど、これ Claude だとできるけど」。
   * これまでは生成中に入力欄が塞がり、止めることも割り込むこともできなかった。
   *
   * onStop 未指定なら停止ボタンを出さない (死にボタン禁止 — Rule 10)。
   */
  readonly onStop?: () => void;
  readonly stopping?: boolean;
  /** 生成中か (入力は塞がず、送信が「あとで送る」に変わる)。 */
  readonly running?: boolean;
  /** GAP-189: まだ流していない追い足し指示 (受領時点で保存済み = 消えない)。 */
  readonly queuedMessages?: readonly { id: string; content: string }[];
  readonly onDropQueued?: (id: string) => void;
  /**
   * GAP-129: PC 操作 (Claude Code 同等ツール)。onToolsModeChange 未指定なら
   * トグル自体を出さない (agent_sdk モード以外 — 死にボタン禁止)。
   */
  readonly toolsMode?: "off" | "approve" | "auto";
  readonly onToolsModeChange?: (mode: "off" | "approve" | "auto") => void;
  /** GAP-129: 実行中ツールの実況 (SSE tool chunk の実値)。 */
  readonly toolActivity?: readonly ToolRunItem[];
  /** GAP-136: 最初のツール開始時刻 (epoch ms)。経過秒の表示に使う。 */
  readonly toolStartedAt?: number | null;
  /** GAP-136: 直前応答の PC 操作サマリ (完了後も痕跡を残す。次送信でクリア)。 */
  readonly toolRunSummary?: {
    count: number;
    seconds: number;
    commands: number;
    edits: number;
  } | null;
  /** GAP-137/139: 成果物の取り込み結果 (SSE artifact chunk の実値)。
      container が種類 (モック/提案書/見積書…) 別のラベルとリンク先を組む。 */
  readonly savedArtifacts?: readonly {
    id: string;
    kindLabel: string;
    name: string;
    version: number;
    href: string;
    openLabel: string;
  }[];
  /**
   * GAP-130: approve モードの承認待ちカード (SSE pc_approval の実値)。
   * onPcApprovalDecision 未指定ならカードを出さない (Rule 10)。
   */
  readonly pcApprovals?: readonly PcApprovalInfo[];
  readonly onPcApprovalDecision?: (
    approvalId: string,
    decision: "allow" | "deny",
  ) => void;
  readonly uploadingAttachments?: boolean;
  /** 永続化済みメッセージの添付を開く (署名付き URL 解決)。 */
  readonly onOpenAttachment?: (messageId: string, index: number) => void;
  /**
   * /コマンド (GAP-002)。true でパレットボタンを描画。実行は container が
   * 送信時に本文の先頭コマンドを解釈して行う (パレットは挿入補助)。
   */
  readonly commandsEnabled?: boolean;
}

/** /コマンド パレットの定義 (GAP-002 — 挿入する原文 + 説明)。 */
const COMMAND_PALETTE = [
  {
    insert: "/要約",
    usage: "/要約",
    description: "会話の要点整理を AI に依頼するメッセージを送ります",
  },
  {
    insert: "/決定 ",
    usage: "/決定 <内容>",
    description: "内容を確定事項 (decisions) として記録します",
  },
  {
    insert: "/タスク化 ",
    usage: "/タスク化 <タイトル>",
    description: "タイトルでタスクを起票します (triage・見積は後で見直し)",
  },
] as const;

/** バイト数の短い表示 (チップ用)。 */
function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

export interface ToolApprovalInfo {
  readonly id: string;
  readonly title: string;
  readonly tool: string;
  readonly tool_input: Record<string, unknown>;
}

/** GAP-130: PC 操作 (approve モード) の承認待ち 1 件。 */
export interface PcApprovalInfo {
  readonly id: string;
  readonly tool: string;
  readonly summary: string;
}

/** GAP-129/130: PC 操作トグルの表示順 (クリックで循環)。 */
const TOOLS_MODE_CYCLE = ["off", "approve", "auto"] as const;
const TOOLS_MODE_LABEL: Record<"off" | "approve" | "auto", string> = {
  off: "なし",
  approve: "承認して実行",
  auto: "自動",
};

/** tool メッセージの content からツール名を推定する (JSON {tool|name} or 先頭行)。 */
function toolNameOf(content: string): string {
  try {
    const obj = JSON.parse(content) as { tool?: string; name?: string };
    if (typeof obj.tool === "string") return obj.tool;
    if (typeof obj.name === "string") return obj.name;
  } catch {
    /* content はプレーンテキスト */
  }
  const firstLine = content.split("\n")[0] ?? "";
  return firstLine.length > 0 && firstLine.length <= 40 ? firstLine : "tool";
}

function AttachmentChips({
  message,
  onOpenAttachment,
  align,
}: {
  readonly message: ChatMessage;
  readonly onOpenAttachment?: (messageId: string, index: number) => void;
  readonly align: "start" | "end";
}) {
  const attachments = message.attachments ?? [];
  if (attachments.length === 0) return null;
  const canOpen = Boolean(onOpenAttachment && message.persisted);
  return (
    <div
      className={`mt-1.5 flex flex-wrap gap-1.5 ${align === "end" ? "justify-end" : ""}`}
    >
      {attachments.map((att, i) => {
        const label = `${att.file_name} (${fmtBytes(att.file_size_bytes)})`;
        return canOpen ? (
          <button
            key={`${att.file_name}-${i}`}
            type="button"
            onClick={() => onOpenAttachment?.(message.id, i)}
            aria-label={`添付を開く: ${att.file_name}`}
            className="inline-flex items-center gap-1 rounded-md border border-border bg-white px-2 py-1 text-[11px] text-on-surface transition-colors hover:border-primary hover:text-primary"
          >
            <Paperclip size={11} aria-hidden="true" />
            {label}
          </button>
        ) : (
          <span
            key={`${att.file_name}-${i}`}
            className="inline-flex items-center gap-1 rounded-md border border-border bg-white px-2 py-1 text-[11px] text-on-surface"
          >
            <Paperclip size={11} aria-hidden="true" />
            {label}
          </span>
        );
      })}
    </div>
  );
}

/**
 * GAP-128: 生成中インジケータ (経営者指示「推論的な UI/UX・ランタイム状態」)。
 * 段階は SSE の実イベントに連動する (推測で演出しない):
 *   context (文脈構築中: context chunk 到着前) → answer (最初の delta 待ち)。
 * delta が届き始めたら本文のストリーミング描画 + 末尾カーソルに切り替わる。
 */
function TypingIndicator({
  stage,
  name,
}: {
  readonly stage: "context" | "answer";
  readonly name: string;
}) {
  return (
    <div
      role="status"
      aria-live="polite"
      className="flex w-fit items-center gap-2.5 rounded-lg rounded-tl-sm border border-border bg-white px-4 py-3"
    >
      <span aria-hidden="true" className="flex items-center gap-1">
        {[0, 1, 2].map((i) => (
          <span
            key={i}
            className="h-1.5 w-1.5 animate-bounce rounded-full bg-on-surface-variant/70"
            style={{ animationDelay: `${i * 150}ms`, animationDuration: "900ms" }}
          />
        ))}
      </span>
      <span className="text-[12px] text-on-surface-variant">
        {stage === "context"
          ? "文脈を集めています (会話履歴とナレッジを検索中)…"
          : `${name}が考えています…`}
      </span>
    </div>
  );
}

/** GAP-129: PC 操作トグルの見た目 (自動 ON はコンテナ色で明示)。 */
function cnToggle(active: boolean): string {
  return active
    ? "inline-flex items-center gap-1 rounded-sm bg-primary-container px-2 py-1 text-[11.5px] font-semibold text-on-primary-container"
    : "inline-flex items-center gap-1 rounded-sm px-2 py-1 text-[11.5px] text-on-surface-variant hover:bg-surface-variant hover:text-on-surface";
}

/** GAP-128: ストリーミング中の本文末尾に出す点滅カーソル。 */
function StreamingCursor() {
  return (
    <span
      aria-hidden="true"
      className="ml-0.5 inline-block h-[14px] w-[7px] animate-pulse rounded-[2px] bg-primary/70 align-text-bottom"
    />
  );
}

function MessageRow({
  message,
  employee,
  onFeedback,
  feedbackDone,
  onBranch,
  branching,
  onOpenAttachment,
  pendingStage,
}: {
  readonly message: ChatMessage;
  readonly employee?: ChatEmployeeInfo;
  readonly onFeedback?: (messageId: string) => void;
  readonly feedbackDone?: boolean;
  readonly onBranch?: (messageId: string) => void;
  readonly branching?: boolean;
  readonly onOpenAttachment?: (messageId: string, index: number) => void;
  /** GAP-128: このメッセージが生成中のとき、その段階 (null = 生成中でない)。 */
  readonly pendingStage?: "context" | "answer" | "streaming" | null;
}) {
  const time = fmtTime(message.created_at);
  const [copied, setCopied] = useState(false);

  const copyContent = () => {
    void navigator.clipboard?.writeText(message.content).then(() => {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    });
  };

  if (message.role === "user") {
    return (
      <li className="ml-auto flex w-full max-w-[760px] flex-col items-end">
        <div className="mb-1 flex items-center gap-2 pr-1 text-on-surface-variant">
          <span className="text-[12.5px] font-bold">あなた</span>
          {time ? <span className="text-[11px] tabular-nums">{time}</span> : null}
        </div>
        <div className="max-w-[580px] whitespace-pre-wrap rounded-lg rounded-br-sm bg-primary px-4 py-3 text-[14px] leading-relaxed text-on-primary">
          {message.content}
        </div>
        <AttachmentChips
          message={message}
          onOpenAttachment={onOpenAttachment}
          align="end"
        />
      </li>
    );
  }

  if (message.role === "system") {
    return (
      <li className="mx-auto max-w-[580px] rounded-md bg-secondary-container px-md py-sm text-center text-label-md text-on-secondary-container">
        {message.content}
      </li>
    );
  }

  if (message.role === "tool") {
    return (
      <li className="flex w-full max-w-[760px] gap-3 pl-11">
        <div className="min-w-0 flex-1 overflow-hidden rounded-md border border-border bg-white">
          <div className="flex items-center gap-2 border-b border-border bg-surface-variant px-3 py-2 text-[11.5px] font-semibold">
            <span className="flex h-[22px] w-[22px] items-center justify-center rounded-sm bg-primary-container text-on-primary-container">
              <Terminal size={12} aria-hidden="true" />
            </span>
            <span className="font-mono text-[11.5px] text-primary">
              {toolNameOf(message.content)}
            </span>
            {time ? (
              <span className="ml-auto text-[10.5px] tabular-nums text-on-surface-variant">
                {time}
              </span>
            ) : null}
          </div>
          <div className="max-h-[220px] overflow-auto px-[14px] py-3">
            <pre className="whitespace-pre-wrap font-mono text-[11.5px] leading-[1.65] text-on-surface">
              {message.content}
            </pre>
          </div>
        </div>
      </li>
    );
  }

  const name = employee?.name ?? "AI 社員";
  return (
    <li className="flex w-full max-w-[760px] gap-3">
      <span
        aria-hidden="true"
        className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-[13px] font-bold text-white"
        style={{ backgroundColor: employee?.color ?? colors.primary }}
      >
        {name.charAt(0)}
      </span>
      <div className="min-w-0 flex-1">
        <div className="mb-1 flex items-center gap-2">
          <span className="text-[12.5px] font-bold text-on-surface">{name}</span>
          {time ? (
            <span className="text-[11px] tabular-nums text-on-surface-variant">
              {time}
            </span>
          ) : null}
        </div>
        {message.content === "" && pendingStage ? (
          <TypingIndicator
            stage={pendingStage === "streaming" ? "answer" : pendingStage}
            name={name}
          />
        ) : (
          <>
            <MessageContent content={message.content} />
            {pendingStage === "streaming" ? <StreamingCursor /> : null}
          </>
        )}
        {message.persisted ? (
          // モック .msg-action-row 準拠 (役立った / コピー / 分岐 — GAP-031① 解消:
          // 分岐は履歴コピー + parent_message_id 連鎖で新スレッドへ)。
          <div className="mt-1.5 flex items-center gap-1">
            {onFeedback ? (
              <button
                type="button"
                disabled={feedbackDone}
                onClick={() => onFeedback(message.id)}
                aria-label={`このメッセージにフィードバック: 役立った`}
                className="inline-flex items-center gap-1 rounded-sm px-2 py-[3px] text-[11px] text-on-surface-variant transition-colors hover:bg-surface-variant hover:text-on-surface disabled:text-primary disabled:hover:bg-transparent"
              >
                <Check size={11} aria-hidden="true" />
                {feedbackDone ? "役立った ✓" : "役立った"}
              </button>
            ) : null}
            <button
              type="button"
              onClick={copyContent}
              aria-label="メッセージをコピー"
              className="inline-flex items-center gap-1 rounded-sm px-2 py-[3px] text-[11px] text-on-surface-variant transition-colors hover:bg-surface-variant hover:text-on-surface"
            >
              <Copy size={11} aria-hidden="true" />
              {copied ? "コピーしました" : "コピー"}
            </button>
            {onBranch ? (
              <button
                type="button"
                disabled={branching}
                onClick={() => onBranch(message.id)}
                aria-label="このメッセージから分岐"
                title="このメッセージ時点までの履歴をコピーした新スレッドを作ります"
                className="inline-flex items-center gap-1 rounded-sm px-2 py-[3px] text-[11px] text-on-surface-variant transition-colors hover:bg-surface-variant hover:text-on-surface disabled:opacity-50"
              >
                <GitBranch size={11} aria-hidden="true" />
                {branching ? "分岐中…" : "分岐"}
              </button>
            ) : null}
          </div>
        ) : null}
      </div>
    </li>
  );
}

export function ChatPanel({
  messages,
  onSend,
  disabled,
  employee,
  errorNotice,
  onDismissError,
  mentionCandidates = [],
  knowledgeCandidates = [],
  onFeedback,
  feedbackDoneIds,
  onBranch,
  branching,
  toolApprovals = [],
  onApproveTool,
  onRejectTool,
  toolActing,
  onPickAttachments,
  pendingAttachments = [],
  onRemoveAttachment,
  attachmentError,
  uploadingAttachments,
  onOpenAttachment,
  commandsEnabled,
  pendingAssistantId,
  pendingStage,
  onStop,
  stopping,
  running,
  queuedMessages = [],
  onDropQueued,
  toolsMode = "off",
  onToolsModeChange,
  toolActivity,
  toolStartedAt,
  toolRunSummary,
  savedArtifacts,
  pcApprovals,
  onPcApprovalDecision,
}: ChatPanelProps) {
  const [input, setInput] = useState("");
  // GAP-136: 実行中の経過秒 (1 秒刻み)。toolStartedAt が無ければ表示しない。
  const [elapsedSec, setElapsedSec] = useState(0);
  useEffect(() => {
    if (toolStartedAt == null) {
      setElapsedSec(0);
      return;
    }
    const tick = () =>
      setElapsedSec(Math.max(0, Math.round((Date.now() - toolStartedAt) / 1000)));
    tick();
    const timer = setInterval(tick, 1000);
    return () => clearInterval(timer);
  }, [toolStartedAt]);
  const [picker, setPicker] = useState<"mention" | "knowledge" | "command" | null>(
    null,
  );
  const viewportRef = useRef<HTMLUListElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const attachInputRef = useRef<HTMLInputElement>(null);

  // カーソル位置にテキストを挿入してフォーカスを戻す
  const insertAtCursor = (text: string) => {
    const ta = textareaRef.current;
    if (!ta) {
      setInput((v) => v + text);
      return;
    }
    const start = ta.selectionStart ?? input.length;
    const end = ta.selectionEnd ?? input.length;
    const next = input.slice(0, start) + text + input.slice(end);
    setInput(next);
    requestAnimationFrame(() => {
      ta.focus();
      const pos = start + text.length;
      ta.setSelectionRange(pos, pos);
    });
  };

  useEffect(() => {
    if (!picker) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setPicker(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [picker]);

  // 新着で最下部へ自動スクロール
  useEffect(() => {
    const el = viewportRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages.length]);

  const submit = () => {
    const v = input.trim();
    if (!v) return;
    onSend(v);
    setInput("");
  };

  const placeholder = employee
    ? `${employee.name}にメッセージ… · @ で他のAI社員をメンション`
    : "AI 社員にメッセージ… · @ でメンション";

  return (
    <section aria-label="チャット" className="flex h-full min-h-0 flex-col">
      <ul
        ref={viewportRef}
        role="log"
        aria-live="polite"
        className="flex min-h-0 flex-1 flex-col gap-[18px] overflow-y-auto px-md py-5 sm:px-[32px]"
      >
        {messages.map((m) => (
          <MessageRow
            key={m.id}
            message={m}
            employee={employee}
            onFeedback={m.role === "assistant" ? onFeedback : undefined}
            feedbackDone={feedbackDoneIds?.has(m.id)}
            onBranch={m.role === "assistant" ? onBranch : undefined}
            branching={branching}
            onOpenAttachment={onOpenAttachment}
            pendingStage={m.id === pendingAssistantId ? pendingStage : null}
          />
        ))}
        {/* ツール実行の承認カード (GAP-031① — モック .approval-card 準拠) */}
        {toolApprovals.map((a) => (
          <li
            key={a.id}
            className="w-full max-w-[760px] rounded-lg border border-secondary bg-secondary-container/40 px-4 py-3.5"
          >
            <div className="mb-1 flex items-center gap-2 text-[12.5px] font-bold text-on-surface">
              <ShieldCheck size={14} aria-hidden="true" className="text-secondary" />
              承認が必要：ツールの実行を進めてよいですか？
            </div>
            <p className="text-[13px] leading-relaxed text-on-surface">
              {a.title}
              {typeof a.tool_input.title === "string" ? (
                <>
                  {" — "}
                  <code className="rounded-sm bg-surface-variant px-1 py-0.5 font-mono text-[12px]">
                    {a.tool_input.title}
                  </code>
                </>
              ) : null}
            </p>
            <div className="mt-3 flex flex-wrap gap-2">
              {onApproveTool ? (
                <button
                  type="button"
                  disabled={toolActing}
                  onClick={() => onApproveTool(a.id)}
                  className="inline-flex h-8 items-center gap-1.5 rounded-md bg-primary px-3 text-[12px] font-semibold text-on-primary transition-colors hover:opacity-90 disabled:opacity-50"
                >
                  <Check size={12} aria-hidden="true" />
                  {toolActing ? "実行中…" : "承認して実行"}
                </button>
              ) : null}
              {onRejectTool ? (
                <button
                  type="button"
                  disabled={toolActing}
                  onClick={() => onRejectTool(a.id)}
                  className="inline-flex h-8 items-center rounded-md border border-border bg-white px-3 text-[12px] font-semibold text-on-surface transition-colors hover:bg-surface-variant disabled:opacity-50"
                >
                  差戻
                </button>
              ) : null}
              <a
                href="/approvals"
                className="inline-flex h-8 items-center rounded-md px-3 text-[12px] font-semibold text-on-surface-variant transition-colors hover:bg-surface-variant hover:text-on-surface"
              >
                Inbox で確認
              </a>
            </div>
          </li>
        ))}
      </ul>

      <form
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
        className="shrink-0 border-t border-border bg-surface px-md pb-4 pt-3 sm:px-[24px]"
      >
        {errorNotice ? (
          <div
            role="alert"
            className="mb-2 flex items-start gap-2 rounded-md border border-error/30 bg-error/5 px-3 py-2 text-[12px] leading-[1.5] text-error"
          >
            <CircleAlert size={14} aria-hidden="true" className="mt-[1px] shrink-0" />
            <span className="flex-1">{errorNotice}</span>
            {onDismissError ? (
              <button
                type="button"
                aria-label="エラーを閉じる"
                onClick={onDismissError}
                className="shrink-0 rounded-sm p-[2px] hover:bg-error/10"
              >
                <X size={13} aria-hidden="true" />
              </button>
            ) : null}
          </div>
        ) : null}
        <div className="rounded-lg border border-border bg-white px-[14px] py-3 transition-all focus-within:border-primary focus-within:shadow-focus-ring">
          <label htmlFor="chat-input" className="sr-only">
            メッセージを入力
          </label>
          <textarea
            ref={textareaRef}
            id="chat-input"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              // モック準拠: Enter で送信 / Shift+Enter で改行 (IME 変換中は送信しない)
              if (
                e.key === "Enter" &&
                !e.shiftKey &&
                !e.nativeEvent.isComposing
              ) {
                e.preventDefault();
                submit();
              }
            }}
            disabled={disabled}
            rows={2}
            placeholder={placeholder}
            className="max-h-[200px] min-h-[44px] w-full resize-none border-0 bg-transparent text-[14px] leading-relaxed text-on-surface outline-none placeholder:text-on-surface-variant"
          />
          {/* 送信前の添付チップ (GAP-001) */}
          {pendingAttachments.length > 0 ? (
            <div className="mt-2 flex flex-wrap gap-1.5">
              {pendingAttachments.map((f, i) => (
                <span
                  key={`${f.name}-${i}`}
                  className="inline-flex items-center gap-1 rounded-md border border-border bg-surface-variant px-2 py-1 text-[11px] text-on-surface"
                >
                  <Paperclip size={11} aria-hidden="true" />
                  {f.name} ({fmtBytes(f.size)})
                  {onRemoveAttachment ? (
                    <button
                      type="button"
                      aria-label={`添付を外す: ${f.name}`}
                      onClick={() => onRemoveAttachment(i)}
                      className="rounded-sm p-[1px] hover:bg-white"
                    >
                      <X size={11} aria-hidden="true" />
                    </button>
                  ) : null}
                </span>
              ))}
            </div>
          ) : null}
          {attachmentError ? (
            <p role="alert" className="mt-1.5 text-[11.5px] font-semibold text-error">
              {attachmentError}
            </p>
          ) : null}
          {/* GAP-189: 実行中に送った指示の待ち行列。受け取った時点でサーバーに
              保存済みなので、ここを閉じても消えない。今の実行が終わったら
              上から順に流れる。 */}
          {queuedMessages.length > 0 ? (
            <div
              role="region"
              aria-label="あとで送る指示"
              className="mt-2 rounded-md border border-border bg-surface-variant/60 px-3 py-2"
            >
              <p className="text-[11.5px] font-semibold text-on-surface-variant">
                今の実行が終わったら送ります（{queuedMessages.length} 件・保存済み）
              </p>
              <ul className="mt-1.5 flex flex-col gap-1">
                {queuedMessages.map((q) => (
                  <li
                    key={q.id}
                    className="flex items-start gap-2 text-[12px] text-on-surface"
                  >
                    <span className="min-w-0 flex-1 truncate">{q.content}</span>
                    {onDropQueued ? (
                      <button
                        type="button"
                        aria-label={`あとで送る指示を取り消す: ${q.content}`}
                        onClick={() => onDropQueued(q.id)}
                        className="shrink-0 rounded-sm p-[1px] text-on-surface-variant hover:bg-white hover:text-on-surface"
                      >
                        <X size={11} aria-hidden="true" />
                      </button>
                    ) : null}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
          {/* GAP-130: PC 操作の承認カード (approve モード — Claude Code の
              permission prompt 同等)。先頭 1 件だけ提示し、決定すると次が出る。 */}
          {onPcApprovalDecision && pcApprovals && pcApprovals.length > 0 ? (
            <div
              role="region"
              aria-label="PC 操作の承認"
              className="mt-2 rounded-md border border-primary/40 bg-primary-container/40 px-3 py-2"
            >
              <div className="flex items-center gap-2 text-[12px] font-semibold text-on-surface">
                <Terminal size={13} aria-hidden="true" className="shrink-0 text-primary" />
                <span>
                  {pcApprovals[0]?.tool} を実行してもよいですか？
                  {pcApprovals.length > 1 ? (
                    <span className="ml-1 font-normal text-on-surface-variant">
                      (他 {pcApprovals.length - 1} 件待ち)
                    </span>
                  ) : null}
                </span>
              </div>
              <p className="mt-1 break-all rounded-sm bg-surface px-2 py-1 font-mono text-[11.5px] text-on-surface-variant">
                {pcApprovals[0]?.summary}
              </p>
              <div className="mt-1.5 flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => {
                    const id = pcApprovals[0]?.id;
                    if (id) onPcApprovalDecision(id, "allow");
                  }}
                  className="rounded-sm bg-primary px-3 py-1 text-[11.5px] font-semibold text-on-primary hover:opacity-90"
                >
                  許可して実行
                </button>
                <button
                  type="button"
                  onClick={() => {
                    const id = pcApprovals[0]?.id;
                    if (id) onPcApprovalDecision(id, "deny");
                  }}
                  className="rounded-sm border border-border px-3 py-1 text-[11.5px] text-on-surface hover:bg-surface-variant"
                >
                  拒否
                </button>
                <span className="text-[11px] text-on-surface-variant">
                  拒否すると AI は実行せずに続行します
                </span>
              </div>
            </div>
          ) : null}
          {/* GAP-129/136/148: ツール実行のタイムライン (Claude Code 風 —
              「Bash(npm test)」等の実値行を時系列に。最後の行が実行中) */}
          {toolActivity && toolActivity.length > 0 ? (
            <div
              role="status"
              aria-live="polite"
              className="mt-2 rounded-md bg-surface-variant px-3 py-2 text-[11.5px] text-on-surface-variant"
            >
              <div className="flex items-center gap-2">
                <Terminal
                  size={12}
                  aria-hidden="true"
                  className="shrink-0 text-primary"
                />
                <span className="font-semibold text-on-surface">
                  PC 操作を実行中
                </span>
                <span
                  aria-hidden="true"
                  className="h-1.5 w-1.5 shrink-0 animate-pulse rounded-full bg-primary"
                />
                {toolStartedAt != null ? (
                  <span className="tabular-nums">経過 {elapsedSec} 秒</span>
                ) : null}
                <span className="ml-auto">応答はツール完了後に届きます</span>
              </div>
              <ul className="mt-1.5 flex flex-col gap-0.5 font-mono text-[11px]">
                {toolActivity.map((run, i) => {
                  const isRunning = i === toolActivity.length - 1;
                  return (
                    <li
                      key={`${i}-${run.tool}`}
                      className={
                        isRunning
                          ? "flex items-start gap-1.5 text-on-surface"
                          : "flex items-start gap-1.5 opacity-70"
                      }
                    >
                      <span
                        aria-hidden="true"
                        className={
                          isRunning
                            ? "shrink-0 animate-pulse text-primary"
                            : "shrink-0 text-[10px] text-primary"
                        }
                      >
                        {isRunning ? "⏺" : "✓"}
                      </span>
                      <span className="min-w-0 break-all">
                        <span className="font-semibold">{run.tool}</span>
                        {run.summary ? <>({run.summary})</> : null}
                      </span>
                    </li>
                  );
                })}
              </ul>
            </div>
          ) : null}
          {/* GAP-137/139: 成果物の取り込みカード (種類別にモック/成果物へリンク) */}
          {savedArtifacts && savedArtifacts.length > 0 ? (
            <div
              role="region"
              aria-label="成果物の保存"
              className="mt-2 rounded-md border border-border bg-surface px-3 py-2 text-[11.5px]"
            >
              <p className="mb-1 font-semibold text-on-surface">
                成果物を保存しました
              </p>
              <ul className="flex flex-col gap-1">
                {savedArtifacts.map((a) => (
                  <li key={a.id} className="flex items-center gap-2">
                    <span className="rounded-sm bg-surface-variant px-1.5 py-0.5 text-[10.5px] font-semibold text-on-surface">
                      {a.kindLabel}
                    </span>
                    <span className="text-on-surface-variant">
                      {a.name} (v{a.version})
                    </span>
                    <a
                      href={a.href}
                      className="font-semibold text-primary hover:underline"
                    >
                      {a.openLabel} →
                    </a>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
          {/* GAP-136: 直前応答の PC 操作サマリ (実況が消えた後も痕跡を残す) */}
          {(!toolActivity || toolActivity.length === 0) && toolRunSummary ? (
            <div
              role="status"
              className="mt-2 flex items-center gap-2 rounded-md bg-surface-variant px-3 py-1.5 text-[11.5px] text-on-surface-variant"
            >
              <Terminal size={12} aria-hidden="true" className="shrink-0 text-primary" />
              <span>
                PC 操作完了: {toolRunSummary.count} ツール実行
                {toolRunSummary.commands > 0
                  ? ` · コマンド ${toolRunSummary.commands} 件`
                  : ""}
                {toolRunSummary.edits > 0
                  ? ` · ファイル編集 ${toolRunSummary.edits} 件`
                  : ""}{" "}
                ({toolRunSummary.seconds} 秒)
              </span>
            </div>
          ) : null}
          <div className="relative mt-2 flex items-center gap-1 border-t border-border pt-2">
            {/* /コマンドは対応バックエンド未実装のためボタン自体を出さない (Rule 10 / gap 起票済)。 */}
            {onPickAttachments ? (
              <>
                <input
                  ref={attachInputRef}
                  type="file"
                  multiple
                  className="hidden"
                  aria-label="添付ファイルを選択"
                  onChange={(ev) => {
                    const files = Array.from(ev.target.files ?? []);
                    ev.target.value = "";
                    if (files.length > 0) onPickAttachments(files);
                  }}
                />
                <button
                  type="button"
                  disabled={disabled || uploadingAttachments}
                  onClick={() => attachInputRef.current?.click()}
                  className="inline-flex items-center gap-1 rounded-sm px-2 py-1 text-[11.5px] text-on-surface-variant hover:bg-surface-variant hover:text-on-surface disabled:opacity-50"
                >
                  <Upload size={12} aria-hidden="true" />
                  <span className="hidden sm:inline">添付</span>
                </button>
              </>
            ) : null}
            {commandsEnabled ? (
              <button
                type="button"
                aria-expanded={picker === "command"}
                onClick={() =>
                  setPicker((v) => (v === "command" ? null : "command"))
                }
                className="inline-flex items-center gap-1 rounded-sm px-2 py-1 text-[11.5px] text-on-surface-variant hover:bg-surface-variant hover:text-on-surface"
              >
                <Zap size={12} aria-hidden="true" />
                <span className="hidden sm:inline">/コマンド</span>
              </button>
            ) : null}
            <button
              type="button"
              aria-expanded={picker === "mention"}
              onClick={() => setPicker((v) => (v === "mention" ? null : "mention"))}
              className="inline-flex items-center gap-1 rounded-sm px-2 py-1 text-[11.5px] text-on-surface-variant hover:bg-surface-variant hover:text-on-surface"
            >
              <AtSign size={12} aria-hidden="true" />
              <span className="hidden sm:inline">@メンション</span>
            </button>
            {/* GAP-129/130: PC 操作トグル (agent_sdk/relay モードのときだけ親が props を渡す)。
                クリックで なし → 承認して実行 → 自動 → なし を循環する。
                GAP-136: 実行中は変更不可 — 走行中の CLI は起動時のモードで固定されて
                おり途中変更は反映されない (次の送信から適用)。誤解を生む操作を塞ぐ。 */}
            {onToolsModeChange ? (
              <button
                type="button"
                disabled={disabled}
                aria-pressed={toolsMode !== "off"}
                aria-label={`PC 操作を切り替える (現在: ${TOOLS_MODE_LABEL[toolsMode]})`}
                title={
                  disabled
                    ? "実行中は変更できません (次の送信から変更できます)"
                    : undefined
                }
                onClick={() => {
                  const i = TOOLS_MODE_CYCLE.indexOf(toolsMode);
                  onToolsModeChange(
                    TOOLS_MODE_CYCLE[(i + 1) % TOOLS_MODE_CYCLE.length] ?? "off",
                  );
                }}
                className={`${cnToggle(toolsMode !== "off")} disabled:cursor-not-allowed disabled:opacity-50`}
              >
                <Terminal size={12} aria-hidden="true" />
                <span className="hidden sm:inline">
                  PC 操作: {TOOLS_MODE_LABEL[toolsMode]}
                </span>
              </button>
            ) : null}
            <button
              type="button"
              aria-expanded={picker === "knowledge"}
              onClick={() => setPicker((v) => (v === "knowledge" ? null : "knowledge"))}
              className="inline-flex items-center gap-1 rounded-sm px-2 py-1 text-[11.5px] text-on-surface-variant hover:bg-surface-variant hover:text-on-surface"
            >
              <Brain size={12} aria-hidden="true" />
              <span className="hidden sm:inline">ナレッジ参照</span>
            </button>

            {picker ? (
              <div
                role="listbox"
                aria-label={
                  picker === "mention"
                    ? "メンションする AI 社員"
                    : picker === "command"
                      ? "実行するコマンド"
                      : "参照するナレッジ"
                }
                className="absolute bottom-[calc(100%+6px)] left-0 z-10 max-h-[220px] w-[300px] overflow-y-auto rounded-md border border-border bg-white py-1 shadow-lg"
              >
                {picker === "command" ? (
                  COMMAND_PALETTE.map((c) => (
                    <button
                      key={c.usage}
                      type="button"
                      role="option"
                      aria-selected="false"
                      onClick={() => {
                        setInput((v) => c.insert + v);
                        setPicker(null);
                        textareaRef.current?.focus();
                      }}
                      className="flex w-full flex-col gap-0.5 px-3 py-[6px] text-left hover:bg-surface-variant"
                    >
                      <span className="font-mono text-[12px] font-semibold text-primary">
                        {c.usage}
                      </span>
                      <span className="text-[11.5px] text-on-surface-variant">
                        {c.description}
                      </span>
                    </button>
                  ))
                ) : picker === "mention" ? (
                  mentionCandidates.length === 0 ? (
                    <p className="px-3 py-2 text-[12px] text-on-surface-variant">
                      メンションできる AI 社員がいません。
                    </p>
                  ) : (
                    mentionCandidates.map((c) => (
                      <button
                        key={c.id}
                        type="button"
                        role="option"
                        aria-selected="false"
                        onClick={() => {
                          insertAtCursor(`@${c.name} `);
                          setPicker(null);
                        }}
                        className="flex w-full items-center gap-2 px-3 py-[6px] text-left text-[12.5px] text-on-surface hover:bg-surface-variant"
                      >
                        <span
                          aria-hidden="true"
                          className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-[10px] font-bold text-white"
                          style={{ backgroundColor: c.color ?? colors.primary }}
                        >
                          {c.name.charAt(0)}
                        </span>
                        {c.name}
                      </button>
                    ))
                  )
                ) : knowledgeCandidates.length === 0 ? (
                  <p className="px-3 py-2 text-[12px] text-on-surface-variant">
                    このプロジェクトのナレッジはまだありません。送信時の自動 RAG
                    検索は常時有効です。
                  </p>
                ) : (
                  knowledgeCandidates.map((c) => (
                    <button
                      key={c.id}
                      type="button"
                      role="option"
                      aria-selected="false"
                      onClick={() => {
                        insertAtCursor(`[ナレッジ: ${c.title}] `);
                        setPicker(null);
                      }}
                      className="flex w-full items-center gap-2 px-3 py-[6px] text-left text-[12.5px] text-on-surface hover:bg-surface-variant"
                    >
                      <Brain size={12} aria-hidden="true" className="shrink-0 text-primary" />
                      <span className="truncate">{c.title}</span>
                    </button>
                  ))
                )}
              </div>
            ) : null}
            {/* GAP-189: 生成中は「停止」を出す。押すと本人の PC で走っている
                claude まで実際に止まる (クラウドの状態だけ落とす嘘の中断にしない)。 */}
            {running && onStop ? (
              <button
                type="button"
                onClick={onStop}
                disabled={stopping}
                title="実行を止めます。ここまでの内容はスレッドに残ります。"
                className="ml-auto inline-flex items-center gap-1.5 rounded-md border border-border bg-white px-3 py-[7px] text-[12.5px] font-semibold text-on-surface transition-colors hover:bg-surface-variant disabled:opacity-50"
              >
                <Square size={11} aria-hidden="true" />
                {stopping ? "停止中…" : "停止"}
              </button>
            ) : null}
            <button
              type="submit"
              disabled={disabled || !input.trim()}
              className={`${running && onStop ? "" : "ml-auto "}inline-flex items-center gap-1.5 rounded-md bg-primary px-4 py-[7px] text-[12.5px] font-semibold text-on-primary transition-opacity hover:opacity-90 disabled:opacity-50`}
              title={
                running
                  ? "実行中でも送れます。今の実行が終わったら続けて実行します。"
                  : undefined
              }
            >
              {running ? "あとで送る" : "送信"}
              <SendHorizontal size={12} aria-hidden="true" />
            </button>
          </div>
        </div>

        <div className="mt-2 flex items-center gap-3 px-1 text-[11px] text-on-surface-variant">
          {/* GAP-164: 「学習に使われません」は外部のモデル学習の話。社内ナレッジには
              貯まる (会話から一般化できるノウハウだけ自動で拾う) — 混同させない。 */}
          <span
            className="inline-flex items-center gap-1"
            title="会話を外部の AI モデルの学習には渡しません。ただし、他の案件でも使える形に一般化できるノウハウは、このワークスペースのナレッジに自動で残ります (ナレッジ画面で確認・削除できます)。"
          >
            <ShieldCheck size={11} aria-hidden="true" />
            外部の学習には使いません · 社内ナレッジには残ります
          </span>
          <span className="ml-auto tabular-nums">
            Enter で送信 · Shift + Enter で改行
          </span>
        </div>
      </form>
    </section>
  );
}
