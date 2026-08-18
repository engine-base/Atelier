/**
 * S-E01 チャットコンテナ — T-UC-08 (SSE + F-CTX01 配線)
 *
 * ChatPanel(presentational) を実 SSE に配線する。送信時にユーザ発話を楽観追加し、
 * POST /chat/threads/{threadId}/stream の delta を assistant メッセージに逐次反映する。
 * 'context' chunk で F-CTX01 文脈サマリ (履歴件数 / RAG hit 数) を表示し、'error' chunk や
 * 例外では inline error + toast を出す。
 *
 * threadId は親 (スレッド選択) から prop で受ける。streamFn は注入可能 (テスト用)。
 */

"use client";

import * as React from "react";
import { useCallback, useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";

import { Brain } from "lucide-react";

import * as api from "../../../../lib/auth/connector";

import {
  ChatPanel,
  type ChatEmployeeInfo,
  type ChatMessage,
  type KnowledgeCandidate,
  type MentionCandidate,
  type PcApprovalInfo,
  type ToolApprovalInfo,
} from "./ChatPanel";
import {
  branchThreadAtMessage,
  executeToolApproval,
  fetchChatAttachmentUrl,
  fetchThreadMessages,
  fetchToolApprovals,
  postMessageFeedback,
  rejectToolApproval,
  resolvePcApproval,
  runChatCommand,
  streamChatThread,
  uploadChatAttachment,
  type ChatAttachmentMeta,
  type ChatStreamChunk,
  type StreamChatArgs,
} from "./stream";

/** /要約 が SSE に送る実依頼文 (GAP-002 — パレットの説明と一致させる)。 */
export const SUMMARY_COMMAND_PROMPT =
  "この会話のここまでの要点を、決定事項・未解決の論点・次のアクションに分けて簡潔に要約してください。";

type ParsedCommand =
  | { kind: "summary" }
  | { kind: "server"; command: "decision" | "task"; args: string }
  | { kind: "empty-args"; usage: string }
  | { kind: "unknown"; name: string }
  | null;

/** 本文先頭の /コマンド を解釈する (コマンドでなければ null)。 */
function parseCommand(text: string): ParsedCommand {
  if (!text.startsWith("/")) return null;
  const [head = "", ...rest] = text.split(/\s+/);
  const args = rest.join(" ").trim();
  if (head === "/要約" || head === "/summary") return { kind: "summary" };
  if (head === "/決定" || head === "/decision")
    return args
      ? { kind: "server", command: "decision", args }
      : { kind: "empty-args", usage: "/決定 <内容>" };
  if (head === "/タスク化" || head === "/task")
    return args
      ? { kind: "server", command: "task", args }
      : { kind: "empty-args", usage: "/タスク化 <タイトル>" };
  return { kind: "unknown", name: head };
}

/** 添付の client 側事前検証 (API と同じ制約 — 415/413 往復を避け即時表示)。 */
const ATTACH_ALLOWED_MIME = new Set([
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif",
  "application/pdf",
  "text/plain",
  "text/markdown",
  "text/csv",
  "application/zip",
]);
const ATTACH_MAX_BYTES = 10 * 1024 * 1024;
const ATTACH_MAX_COUNT = 10;

type StreamFn = (args: StreamChatArgs) => Promise<void>;

export interface ChatContextSummary {
  readonly historyCount: number;
  readonly ragHitCount: number;
}

export interface ChatContainerProps {
  readonly threadId: string;
  readonly ragAccountId?: string;
  /** 注入用 (省略時は実 SSE)。 */
  readonly streamFn?: StreamFn;
  /** 履歴ロードの注入用 (省略時は実 GET。テストでは stub を渡し実 fetch を避ける)。 */
  readonly fetchMessagesFn?: typeof fetchThreadMessages;
  readonly initialMessages?: readonly ChatMessage[];
  /** 対話相手の AI 社員 (バブルの名前/アバター/placeholder)。 */
  readonly employee?: ChatEmployeeInfo;
  /** ストリーミング状態の変化 (ヘッダーのステータス行用)。 */
  readonly onBusyChange?: (busy: boolean) => void;
  /** F-CTX01 実測値の変化 (右ペインのコンテキストタブ用)。 */
  readonly onContext?: (ctx: ChatContextSummary) => void;
  /** メッセージ件数の変化 (右ペイン用)。 */
  readonly onMessageCount?: (count: number) => void;
  readonly mentionCandidates?: readonly MentionCandidate[];
  readonly knowledgeCandidates?: readonly KnowledgeCandidate[];
  /** フィードバック送信の注入用 (省略時は実 POST)。 */
  readonly feedbackFn?: typeof postMessageFeedback;
  /** 分岐 (GAP-031①) の注入用 (省略時は実 POST /branch)。 */
  readonly branchFn?: typeof branchThreadAtMessage;
  /** 分岐成功時の遷移 (分岐先スレッド ID)。未指定なら分岐ボタンを出さない。 */
  readonly onBranched?: (threadId: string) => void;
  /** ツール承認 (GAP-031①) の注入用 (省略時は実 API)。 */
  readonly approvalsFn?: typeof fetchToolApprovals;
  readonly executeApprovalFn?: typeof executeToolApproval;
  readonly rejectApprovalFn?: typeof rejectToolApproval;
  /** 添付 (GAP-001) の注入用 (省略時は実 API)。 */
  readonly uploadAttachmentFn?: typeof uploadChatAttachment;
  readonly attachmentUrlFn?: typeof fetchChatAttachmentUrl;
  /** 添付を開くときの window.open 相当 (テスト注入用)。 */
  readonly openUrlFn?: (url: string) => void;
  /** /コマンド (GAP-002) の注入用 (省略時は実 API)。 */
  readonly commandFn?: typeof runChatCommand;
  /** GAP-130: PC 操作の承認決定 (approve モード) の注入用 (省略時は実 POST)。 */
  readonly resolvePcApprovalFn?: typeof resolvePcApproval;
}

let _seq = 0;
function nextId(prefix: string): string {
  _seq += 1;
  return `${prefix}-${_seq}`;
}

function readContextSummary(
  meta: Record<string, unknown> | null | undefined,
): ChatContextSummary {
  const historyCount =
    typeof meta?.history_count === "number" ? meta.history_count : 0;
  const hits = meta?.rag_hit_ids;
  const ragHitCount = Array.isArray(hits) ? hits.length : 0;
  return { historyCount, ragHitCount };
}

export function ChatContainer({
  threadId,
  ragAccountId,
  streamFn = streamChatThread,
  fetchMessagesFn = fetchThreadMessages,
  initialMessages = [],
  employee,
  onBusyChange,
  onContext,
  onMessageCount,
  mentionCandidates,
  knowledgeCandidates,
  feedbackFn = postMessageFeedback,
  branchFn = branchThreadAtMessage,
  onBranched,
  approvalsFn = fetchToolApprovals,
  executeApprovalFn = executeToolApproval,
  rejectApprovalFn = rejectToolApproval,
  uploadAttachmentFn = uploadChatAttachment,
  attachmentUrlFn = fetchChatAttachmentUrl,
  openUrlFn,
  commandFn = runChatCommand,
  resolvePcApprovalFn = resolvePcApproval,
}: ChatContainerProps) {
  const [messages, setMessages] =
    useState<readonly ChatMessage[]>(initialMessages);
  const [sending, setSending] = useState(false);
  const [context, setContext] = useState<ChatContextSummary | null>(null);
  // GAP-128: 生成中インジケータ (実イベント連動 — context chunk 前/後/delta 受信中)
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [pendingStage, setPendingStage] = useState<
    "context" | "answer" | "streaming" | null
  >(null);
  // GAP-129: PC 操作 (Claude Code 同等ツール)。agent_sdk モードのときだけ
  // トグルを出す (死にボタン禁止)。既定は off — ユーザーが明示的に有効化する。
  const [toolsMode, setToolsMode] = useState<"off" | "approve" | "auto">("off");
  const [toolActivity, setToolActivity] = useState<readonly string[]>([]);
  // GAP-136: PC 操作の経過時間 (最初のツール開始時刻) と完了サマリ。
  // 長時間のツール実行で「止まって見える」UX を解消する — 実イベント由来の
  // 値のみ表示し、進捗の推測 (%) はしない。
  const [toolStartedAt, setToolStartedAt] = useState<number | null>(null);
  const [toolRunSummary, setToolRunSummary] = useState<{
    count: number;
    seconds: number;
  } | null>(null);
  const toolLogRef = useRef<string[]>([]);
  const toolStartRef = useRef<number | null>(null);
  // GAP-130: approve モードの承認待ちカード (SSE pc_approval chunk の実値)
  const [pcApprovals, setPcApprovals] = useState<readonly PcApprovalInfo[]>([]);
  // GAP-137: 成果物のモック取り込み結果 (SSE artifact chunk の実値)。
  // 応答完了後も残す — ユーザーがリンクから S-H01 を開けるように (次送信でクリア)。
  const [savedArtifacts, setSavedArtifacts] = useState<
    readonly { mockId: string; screenName: string; version: number }[]
  >([]);
  const connQuery = useQuery({
    queryKey: ["chat-connection-status"],
    queryFn: async () =>
      (await api.getJson<{ mode: string }>("/chat/connection-status")).data,
    retry: false,
    refetchInterval: 30_000,
  });
  // GAP-134: PC 操作は「本人の Claude プランで実行できる経路」で可能 —
  // relay (本人 PC の Bridge が実行。全ユーザーの標準構成) / agent_sdk
  // (サーバー内サブスク実行 — オーナー個人インスタンスの特殊形)。
  const toolsAvailable =
    connQuery.data?.mode === "agent_sdk" || connQuery.data?.mode === "relay";
  const [error, setError] = useState<string | null>(null);
  const [feedbackDoneIds, setFeedbackDoneIds] = useState<ReadonlySet<string>>(
    new Set(),
  );
  // 添付 (GAP-001): 送信前の選択済みファイルと inline error
  const [pendingFiles, setPendingFiles] = useState<readonly File[]>([]);
  const [attachmentError, setAttachmentError] = useState<string | null>(null);
  const [uploadingAttachments, setUploadingAttachments] = useState(false);

  useEffect(() => {
    onBusyChange?.(sending);
  }, [sending, onBusyChange]);
  useEffect(() => {
    if (context) onContext?.(context);
  }, [context, onContext]);
  useEffect(() => {
    onMessageCount?.(messages.length);
  }, [messages.length, onMessageCount]);

  // バグ #23 対応: 既存スレッドの履歴をマウント時にロードする
  // (これが無いとリロードで会話が消え、cron ダイジェスト等の既存メッセージが不可視)。
  useEffect(() => {
    let cancelled = false;
    setMessages([]);
    setError(null);
    fetchMessagesFn(threadId)
      .then((history) => {
        if (cancelled || history.length === 0) return;
        // 履歴は先頭に置く。stream 中 (送信中) の楽観行は維持する。
        // 履歴行はサーバー実 ID を持つので persisted (フィードバック可能)。
        setMessages((prev) => {
          const existing = new Set(prev.map((m) => m.id));
          const fresh = history
            .filter((m) => !existing.has(m.id))
            .map((m) => ({ ...m, persisted: true }));
          return [...fresh, ...prev];
        });
      })
      .catch(() => {
        if (!cancelled) {
          setError("過去のメッセージの取得に失敗しました。");
        }
      });
    return () => {
      cancelled = true;
    };
  }, [threadId, fetchMessagesFn]);

  // GAP-031①: ツール実行の承認待ち (pending)。スレッド切替・stream 完了・
  // 承認/差戻の後に再取得する。
  const [toolApprovals, setToolApprovals] = useState<readonly ToolApprovalInfo[]>([]);
  const [toolActing, setToolActing] = useState(false);
  const refreshApprovals = useCallback(() => {
    approvalsFn(threadId)
      .then((rows) => setToolApprovals(rows.filter((r) => r.status === "pending")))
      .catch(() => {
        /* 取得失敗は致命ではない (カード非描画のまま) */
      });
  }, [approvalsFn, threadId]);
  useEffect(() => {
    refreshApprovals();
  }, [refreshApprovals]);

  const handlePickAttachments = useCallback((files: readonly File[]) => {
    setAttachmentError(null);
    for (const f of files) {
      if (!ATTACH_ALLOWED_MIME.has(f.type)) {
        setAttachmentError(
          "対応していないファイル形式です (画像 / PDF / テキスト / CSV / ZIP のみ)。",
        );
        return;
      }
      if (f.size > ATTACH_MAX_BYTES) {
        setAttachmentError("添付は 1 ファイル 10MB 以下にしてください。");
        return;
      }
    }
    setPendingFiles((prev) => {
      const next = [...prev, ...files];
      if (next.length > ATTACH_MAX_COUNT) {
        setAttachmentError("添付は 1 メッセージ 10 件までです。");
        return prev;
      }
      return next;
    });
  }, []);

  const handleRemoveAttachment = useCallback((index: number) => {
    setPendingFiles((prev) => prev.filter((_, i) => i !== index));
  }, []);

  const handleOpenAttachment = useCallback(
    (messageId: string, index: number) => {
      attachmentUrlFn(messageId, index)
        .then((url) => {
          if (openUrlFn) openUrlFn(url);
          else window.open(url, "_blank", "noopener");
        })
        .catch(() => {
          setError("添付の取得に失敗しました。時間をおいて再試行してください。");
        });
    },
    [attachmentUrlFn, openUrlFn],
  );

  const reloadMessages = useCallback(async () => {
    try {
      const history = await fetchMessagesFn(threadId);
      if (history.length > 0) {
        setMessages(history.map((m) => ({ ...m, persisted: true })));
      }
    } catch {
      /* 再取得失敗は表示済みを維持 */
    }
  }, [fetchMessagesFn, threadId]);

  const handleSend = useCallback(
    async (text: string) => {
      // GAP-002: 先頭 /コマンド の解釈 (/決定・/タスク化 はサーバー実行、
      // /要約 は実依頼文に置換して SSE へ)
      const parsed = parseCommand(text);
      if (parsed) {
        if (parsed.kind === "unknown") {
          setError(
            `未対応のコマンドです: ${parsed.name} (/要約 ・ /決定 ・ /タスク化 が使えます)`,
          );
          return;
        }
        if (parsed.kind === "empty-args") {
          setError(`コマンドの内容を入力してください (${parsed.usage})`);
          return;
        }
        if (parsed.kind === "server") {
          setSending(true);
          setError(null);
          try {
            await commandFn(threadId, parsed.command, parsed.args);
            // コマンド原文 (user) + 実行結果 (system) はサーバーが永続済み
            await reloadMessages();
          } catch {
            setError(
              "コマンドの実行に失敗しました。時間をおいて再試行してください。",
            );
          } finally {
            setSending(false);
          }
          return;
        }
        // summary → 実依頼文に置換して通常の SSE 送信へ
        text = SUMMARY_COMMAND_PROMPT;
      }
      // GAP-001: 選択済み添付を先に署名付き URL へ実 PUT (失敗時は送信中止 —
      // 「添付されている体」で本文だけ送らない)
      let attachments: ChatAttachmentMeta[] = [];
      if (pendingFiles.length > 0) {
        setUploadingAttachments(true);
        setAttachmentError(null);
        try {
          attachments = [];
          for (const f of pendingFiles) {
            attachments.push(await uploadAttachmentFn(threadId, f));
          }
        } catch {
          setAttachmentError(
            "添付のアップロードに失敗しました。時間をおいて再試行してください。",
          );
          setUploadingAttachments(false);
          return;
        }
        setUploadingAttachments(false);
      }
      const userMsg: ChatMessage = {
        id: nextId("u"),
        role: "user",
        content: text,
        ...(attachments.length > 0 ? { attachments } : {}),
      };
      const assistantId = nextId("a");
      setMessages((prev) => [
        ...prev,
        userMsg,
        { id: assistantId, role: "assistant", content: "" },
      ]);
      setPendingFiles([]);
      setSending(true);
      setError(null);
      setPendingId(assistantId);
      setPendingStage("context");
      setToolActivity([]);
      setToolRunSummary(null);
      setToolStartedAt(null);
      setSavedArtifacts([]);
      toolLogRef.current = [];
      toolStartRef.current = null;

      const onChunk = (chunk: ChatStreamChunk): void => {
        if (chunk.type === "context") {
          setContext(readContextSummary(chunk.metadata));
          // 文脈構築が終わった = ここから Claude の応答待ち
          setPendingStage((s) => (s === "context" ? "answer" : s));
        } else if (chunk.type === "delta" && chunk.content) {
          const piece = chunk.content;
          setPendingStage("streaming");
          setMessages((prev) =>
            prev.map((m) =>
              m.id === assistantId ? { ...m, content: m.content + piece } : m,
            ),
          );
        } else if (chunk.type === "tool" && chunk.content) {
          // GAP-129/136: ツール実行の実況 — タイムライン表示用に積む
          const name = chunk.content;
          if (toolStartRef.current === null) {
            toolStartRef.current = Date.now();
            setToolStartedAt(toolStartRef.current);
          }
          toolLogRef.current = [...toolLogRef.current.slice(-29), name];
          setToolActivity(toolLogRef.current);
        } else if (chunk.type === "pc_approval") {
          // GAP-130: 承認カードの表示要求 (approve モード)
          const meta = chunk.metadata ?? {};
          const id = typeof meta.id === "string" ? meta.id : "";
          if (id) {
            setPcApprovals((prev) => [
              ...prev,
              {
                id,
                tool: typeof meta.tool === "string" ? meta.tool : "",
                summary: typeof meta.summary === "string" ? meta.summary : "",
              },
            ]);
          }
        } else if (chunk.type === "artifact") {
          // GAP-137: 作業フォルダの成果物がモックとして取り込まれた実値
          const meta = chunk.metadata ?? {};
          const mockId = typeof meta.mock_id === "string" ? meta.mock_id : "";
          if (mockId) {
            setSavedArtifacts((prev) => [
              ...prev,
              {
                mockId,
                screenName:
                  typeof meta.screen_name === "string" ? meta.screen_name : "",
                version: typeof meta.version === "number" ? meta.version : 1,
              },
            ]);
          }
        } else if (chunk.type === "pc_approval_resolved") {
          // タイムアウト等サーバー側で解決したカードを掃除する
          const meta = chunk.metadata ?? {};
          const id = typeof meta.id === "string" ? meta.id : "";
          if (id) setPcApprovals((prev) => prev.filter((a) => a.id !== id));
        } else if (chunk.type === "error") {
          setError(chunk.content ?? "ストリーミング中にエラーが発生しました");
        }
      };

      try {
        await streamFn({
          threadId,
          userMessage: text,
          ragAccountId,
          onChunk,
          ...(attachments.length > 0 ? { attachments } : {}),
          ...(toolsMode !== "off" ? { toolsMode } : {}),
        });
        // stream 完了後に履歴を再取得し、楽観行 (ローカル ID) をサーバー実 ID の
        // 行に載せ替える (フィードバック等 per-message API は実 ID が必要)。
        try {
          const history = await fetchMessagesFn(threadId);
          if (history.length > 0) {
            setMessages(history.map((m) => ({ ...m, persisted: true })));
          }
        } catch {
          // 再取得失敗は致命ではない (表示済みの楽観行を維持)。
        }
        // ツールが承認待ちに登録された場合に承認カードを即時表示する
        refreshApprovals();
      } catch {
        setError(
          "AI 応答の取得に失敗しました。時間をおいて再試行してください。",
        );
        // 失敗した空の assistant placeholder は取り除く。
        setMessages((prev) =>
          prev.filter((m) => !(m.id === assistantId && m.content === "")),
        );
      } finally {
        setSending(false);
        setPendingId(null);
        setPendingStage(null);
        // GAP-136: ツールを実行した応答は「完了: N ツール (M 秒)」を残す
        // (実況が消えて何も痕跡が無い、を解消。次の送信でクリア)
        if (toolLogRef.current.length > 0) {
          setToolRunSummary({
            count: toolLogRef.current.length,
            seconds:
              toolStartRef.current !== null
                ? Math.max(1, Math.round((Date.now() - toolStartRef.current) / 1000))
                : 0,
          });
        }
        setToolActivity([]);
        setToolStartedAt(null);
        setPcApprovals([]);
      }
    },
    [
      toolsMode,
      threadId,
      ragAccountId,
      streamFn,
      fetchMessagesFn,
      refreshApprovals,
      pendingFiles,
      uploadAttachmentFn,
      commandFn,
      reloadMessages,
    ],
  );

  // GAP-130: 承認カードの許可/拒否。成功時は即カードを消す (サーバーの
  // resolved chunk でも消えるが、体感を待たせない)。失敗は inline error。
  const handlePcApprovalDecision = useCallback(
    (approvalId: string, decision: "allow" | "deny") => {
      resolvePcApprovalFn(approvalId, decision)
        .then(() => {
          setPcApprovals((prev) => prev.filter((a) => a.id !== approvalId));
        })
        .catch(() => {
          setError(
            "承認の送信に失敗しました (期限切れの可能性があります)。再送してください。",
          );
        });
    },
    [resolvePcApprovalFn],
  );

  const handleFeedback = useCallback(
    (messageId: string) => {
      feedbackFn(messageId, "up")
        .then(() => {
          setFeedbackDoneIds((prev) => new Set([...prev, messageId]));
        })
        .catch(() => {
          setError("フィードバックの送信に失敗しました。");
        });
    },
    [feedbackFn],
  );

  const handleApproveTool = useCallback(
    (approvalId: string) => {
      setToolActing(true);
      executeApprovalFn(approvalId)
        .then(async () => {
          await reloadMessages(); // 実行結果の tool メッセージを実表示
          refreshApprovals();
        })
        .catch(() => {
          setError("ツールの実行に失敗しました。時間をおいて再試行してください。");
        })
        .finally(() => setToolActing(false));
    },
    [executeApprovalFn, refreshApprovals, reloadMessages],
  );

  const handleRejectTool = useCallback(
    (approvalId: string) => {
      setToolActing(true);
      rejectApprovalFn(approvalId)
        .then(async () => {
          await reloadMessages(); // 差戻の system メッセージを実表示
          refreshApprovals();
        })
        .catch(() => {
          setError("差戻に失敗しました。時間をおいて再試行してください。");
        })
        .finally(() => setToolActing(false));
    },
    [rejectApprovalFn, refreshApprovals, reloadMessages],
  );

  // GAP-031①: このメッセージ時点までを新スレッドへコピーして分岐 → 遷移。
  const [branching, setBranching] = useState(false);
  const handleBranch = useCallback(
    (messageId: string) => {
      setBranching(true);
      branchFn(messageId)
        .then((newThreadId) => {
          onBranched?.(newThreadId);
        })
        .catch(() => {
          setError("分岐に失敗しました。時間をおいて再試行してください。");
        })
        .finally(() => setBranching(false));
    },
    [branchFn, onBranched],
  );

  return (
    <div className="flex h-full flex-col gap-sm">
      {context ? (
        // GAP-128: 上端・左端に密着していた余白を是正 (メッセージ列の px に合わせる)
        <div
          className="mx-md mt-sm inline-flex w-fit items-center gap-2 rounded-full bg-tertiary-container px-3 py-1 text-[11.5px] font-semibold text-on-tertiary-container sm:mx-[32px]"
          aria-label="F-CTX01 文脈サマリ"
        >
          <Brain size={12} aria-hidden="true" />
          <span>F-CTX01 コンテキスト構築</span>
          <span aria-hidden="true" className="opacity-60">
            ·
          </span>
          <span>
            参照履歴{" "}
            <strong className="tabular-nums">{context.historyCount}</strong> 件
          </span>
          <span aria-hidden="true" className="opacity-60">
            ·
          </span>
          <span>
            ナレッジ参照{" "}
            <strong className="tabular-nums">{context.ragHitCount}</strong> 件
          </span>
        </div>
      ) : null}

      <div className="min-h-0 flex-1">
        <ChatPanel
          messages={messages}
          onSend={(t) => void handleSend(t)}
          disabled={sending}
          employee={employee}
          errorNotice={error}
          onDismissError={() => setError(null)}
          mentionCandidates={mentionCandidates}
          knowledgeCandidates={knowledgeCandidates}
          onFeedback={handleFeedback}
          feedbackDoneIds={feedbackDoneIds}
          {...(onBranched
            ? { onBranch: handleBranch, branching }
            : {})}
          toolApprovals={toolApprovals}
          onApproveTool={handleApproveTool}
          onRejectTool={handleRejectTool}
          toolActing={toolActing}
          onPickAttachments={handlePickAttachments}
          pendingAttachments={pendingFiles.map((f) => ({
            name: f.name,
            size: f.size,
          }))}
          onRemoveAttachment={handleRemoveAttachment}
          attachmentError={attachmentError}
          uploadingAttachments={uploadingAttachments}
          onOpenAttachment={handleOpenAttachment}
          commandsEnabled
          pendingAssistantId={pendingId}
          pendingStage={pendingStage}
          toolActivity={toolActivity}
          toolStartedAt={toolStartedAt}
          toolRunSummary={toolRunSummary}
          savedArtifacts={savedArtifacts}
          pcApprovals={pcApprovals}
          onPcApprovalDecision={handlePcApprovalDecision}
          {...(toolsAvailable
            ? { toolsMode, onToolsModeChange: setToolsMode }
            : {})}
        />
      </div>
    </div>
  );
}
