/**
 * Atelier Bridge — チャットのローカル実行リレー (GAP-114 / GAP-134)
 *
 * サーバー (chat_relay_jobs) から queued job を pick し、この PC の
 * Claude ログイン (= 本人の月額プラン) で `claude -p` を実行、text delta を
 * chunks として逐次返送する。S-E01 チャットの SSE がそれを中継する。
 *
 * GAP-134 (PC 操作 — すり合わせ確定「全ユーザーが自分の PC + 自分のプランで」):
 *   - tools_mode=auto: Claude Code 同等ツールを確認なしで実行 (bypassPermissions)
 *   - tools_mode=approve: CLI の許可要求 (control_request can_use_tool) を
 *     サーバーの承認キューへ積み、ユーザーが画面で 許可/拒否 するまで待って
 *     CLI へ control_response を返す (Claude Code の permission prompt と同じ体験)
 *   - 作業フォルダ: ~/AtelierChatWork (ATELIER_BRIDGE_CHAT_WORKSPACE で変更可)
 *
 * 課金安全: 子プロセス env から ANTHROPIC_API_KEY / ANTHROPIC_AUTH_TOKEN /
 * CLAUDE_CODE_API_KEY を必ず除去する (残っていると OAuth より優先されて
 * 黙って API 従量課金に流れる — scripts/ccstart.sh:113 と同じ理由)。
 */

import { spawn } from 'node:child_process';
import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, relative, sep } from 'node:path';

import type {
  ChatRelayApprovalDecision,
  ChatRelayChunkKind,
  ChatRelayPicked,
  ChatRelayRateLimitObservation,
} from './api-client.js';

export const CHAT_RELAY_ENABLED_ENV = 'ATELIER_BRIDGE_CHAT_RELAY';
export const CHAT_WORKSPACE_ENV = 'ATELIER_BRIDGE_CHAT_WORKSPACE';

export type ChatToolsMode = 'off' | 'approve' | 'auto';

/** GAP-134: PC 操作で使える Claude Code ツール (サーバー側 _AUTO_TOOLS と同一)。 */
export const ALLOWED_TOOLS = ['Read', 'Write', 'Edit', 'Bash', 'Glob', 'Grep'] as const;

/** chat relay が有効か (既定 ON。'0' で明示 OFF)。 */
export function chatRelayEnabled(env: Readonly<Record<string, string | undefined>>): boolean {
  return env[CHAT_RELAY_ENABLED_ENV] !== '0';
}

/** GAP-134: PC 操作の作業フォルダ (本人 PC 上の成果物置き場)。 */
export function chatWorkspaceDir(env: Readonly<Record<string, string | undefined>>): string {
  const configured = (env[CHAT_WORKSPACE_ENV] ?? '').trim();
  return configured !== '' ? configured : join(homedir(), 'AtelierChatWork');
}

/** 子プロセスへ渡す env。

 * - API キー系 3 変数を除去 — サブスク課金を保証 (GAP-114)
 * - CLAUDE_* / CLAUDECODE 系を除去 (GAP-143 で実測した実バグ):
 *   Bridge 自体が Claude Code セッション内で動いている場合 (開発コンテナ等)、
 *   CLAUDE_CODE_SESSION_ID などが子 CLI に漏れて親セッションと同一セッションを
 *   取り合い、間欠的に exit 1 で死ぬ。実ユーザー PC には存在しない変数なので
 *   落として常にクリーンなセッションで実行する。
 */
export function sanitizedChildEnv(
  env: Readonly<Record<string, string | undefined>>,
): Record<string, string> {
  const drop = new Set(['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_API_KEY']);
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined || drop.has(k)) continue;
    if (k === 'CLAUDECODE' || k.startsWith('CLAUDE_')) continue;
    out[k] = v;
  }
  return out;
}

/**
 * claude の引数を tools_mode ごとに組み立てる。
 * - off: ツールなし・1 往復 (従来)。prompt は stdin テキスト
 * - auto: Claude Code 同等ツールを確認なしで実行 (bypassPermissions)
 * - approve: 許可要求を stdio control protocol で受ける
 *   (--permission-prompt-tool stdio + --input-format stream-json。
 *    prompt は stream-json の user メッセージで送り、承認往復のため
 *    stdin を result まで開いたままにする — GAP-130 で実証した実プロトコル)
 */
export function buildChatArgs(systemPrompt: string, toolsMode: ChatToolsMode = 'off'): string[] {
  const base = [
    '-p',
    '--append-system-prompt',
    systemPrompt,
    '--output-format',
    'stream-json',
    '--include-partial-messages',
    '--verbose',
  ];
  if (toolsMode === 'auto') {
    return [
      ...base,
      '--max-turns',
      '25',
      '--allowedTools',
      ALLOWED_TOOLS.join(','),
      '--permission-mode',
      'bypassPermissions',
    ];
  }
  if (toolsMode === 'approve') {
    return [
      ...base,
      '--max-turns',
      '25',
      '--permission-mode',
      'default',
      '--permission-prompt-tool',
      'stdio',
      '--input-format',
      'stream-json',
    ];
  }
  // off = 純テキスト応答。GAP-143 で実測した実バグ対策として **ツールを完全
  // 無効化**する: 既定ではツールが有効なため、長い HTML を含むプロンプト等で
  // モデルが気まぐれに Read/Write を試み、--max-turns 1 と衝突して
  // stop_reason: tool_use → exit 1 で間欠的に死ぬ (サンプリング依存)。
  return [...base, '--max-turns', '1', '--tools', ''];
}

/** GAP-134: 承認カードに出すツール入力の 1 行要約 (サーバー側と同一ロジック)。 */
export function summarizeToolInput(tool: string, input: Record<string, unknown>): string {
  let primary: unknown;
  if (tool === 'Bash') primary = input.command;
  else if (tool === 'Read' || tool === 'Write' || tool === 'Edit') primary = input.file_path;
  else if (tool === 'Glob' || tool === 'Grep') primary = input.pattern;
  let text = typeof primary === 'string' && primary !== '' ? primary : '';
  if (text === '') {
    const keys = Object.keys(input).sort().join(', ');
    text = keys !== '' ? keys : '(入力なし)';
  }
  return text.length > 200 ? `${text.slice(0, 199)}…` : text;
}

/* ------------------------------------------------------------------ */
/* GAP-137: PC 操作の成果物 (HTML) 検出 — モック自動反映のデータ源       */
/* ------------------------------------------------------------------ */

export const MAX_ARTIFACTS_PER_JOB = 10;
export const MAX_ARTIFACT_BYTES = 512 * 1024;
// GAP-145: バイナリ成果物 (画像 / PPTX / PDF / Excel / 動画 等)。
// 対応拡張子はサーバ (services/mocks/artifacts.py FILE_TYPES) と対で保守する。
export const MAX_BINARY_ARTIFACT_BYTES = 8 * 1024 * 1024;
export const BINARY_ARTIFACT_RE =
  /\.(png|jpe?g|gif|webp|svg|pdf|pptx?|xlsx?|docx?|csv|mp4|webm|mov)$/i;
const ARTIFACT_SKIP_DIRS = new Set(['.git', 'node_modules', '__pycache__', '.venv']);
const ARTIFACT_MAX_DEPTH = 3;

/** 作業フォルダ内の成果物候補 (*.html/.htm + 対応バイナリ) の mtime を記録する (深さ 3 まで)。 */
export function snapshotArtifactFiles(root: string): Map<string, number> {
  const out = new Map<string, number>();
  const walk = (dir: string, depth: number): void => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (
          depth < ARTIFACT_MAX_DEPTH &&
          !ARTIFACT_SKIP_DIRS.has(entry.name) &&
          !entry.name.startsWith('.')
        ) {
          walk(full, depth + 1);
        }
      } else if (/\.html?$/i.test(entry.name) || BINARY_ARTIFACT_RE.test(entry.name)) {
        try {
          out.set(full, statSync(full).mtimeMs);
        } catch {
          /* 消えた直後など — 記録しない */
        }
      }
    }
  };
  walk(root, 0);
  return out;
}

export interface ChatArtifact {
  readonly fileName: string;
  /** HTML 成果物 (どちらか一方が必ず入る)。 */
  readonly html?: string;
  /** GAP-145: バイナリ成果物の base64。 */
  readonly contentB64?: string;
}

/** スナップショット比較で新規/更新の成果物を集める (新しい順・上限つき)。 */
export function collectNewArtifacts(
  root: string,
  before: ReadonlyMap<string, number>,
): ChatArtifact[] {
  const after = snapshotArtifactFiles(root);
  const changed = [...after.entries()]
    .filter(([path, mtime]) => {
      const prev = before.get(path);
      return prev === undefined || mtime > prev;
    })
    .sort((a, b) => b[1] - a[1])
    .slice(0, MAX_ARTIFACTS_PER_JOB);
  const out: ChatArtifact[] = [];
  for (const [path] of changed) {
    let raw;
    try {
      raw = readFileSync(path);
    } catch {
      continue;
    }
    const fileName = relative(root, path).split(sep).join('/');
    if (/\.html?$/i.test(path)) {
      if (raw.byteLength > MAX_ARTIFACT_BYTES) continue;
      out.push({ fileName, html: raw.toString('utf8') });
    } else {
      if (raw.byteLength > MAX_BINARY_ARTIFACT_BYTES) continue;
      out.push({ fileName, contentB64: raw.toString('base64') });
    }
  }
  return out;
}

export type ChatStreamItem =
  | { readonly kind: 'delta'; readonly text: string }
  | { readonly kind: 'assistant_text'; readonly text: string }
  | { readonly kind: 'tool_start'; readonly tool: string }
  | { readonly kind: 'tool_detail'; readonly tool: string; readonly summary: string }
  | {
      readonly kind: 'permission_request';
      readonly requestId: string;
      readonly tool: string;
      readonly input: Record<string, unknown>;
    }
  | { readonly kind: 'result'; readonly ok: boolean; readonly detail?: string }
  | { readonly kind: 'rate_limit'; readonly observation: ChatRelayRateLimitObservation };

/**
 * GAP-148: assistant 完成メッセージから tool_use の実入力を要約して取り出す。
 *
 * Claude Code 風の「Bash(npm test)」「Edit(src/index.html)」行の材料。
 * content_block_start は名前しか持たない (input は json_delta で後から届く)
 * ため、完全な input を持つ assistant メッセージから拾う — CLI はツールを
 * 実行する**前**に assistant メッセージを完成させるので実況として間に合う。
 */
export function extractToolDetails(
  line: string,
): { readonly tool: string; readonly summary: string }[] {
  const trimmed = line.trim();
  if (!trimmed.startsWith('{')) return [];
  let json: unknown;
  try {
    json = JSON.parse(trimmed);
  } catch {
    return [];
  }
  if (typeof json !== 'object' || json === null) return [];
  const obj = json as Record<string, unknown>;
  if (obj.type !== 'assistant') return [];
  const message = obj.message as Record<string, unknown> | undefined;
  const content = Array.isArray(message?.content) ? message.content : [];
  const out: { tool: string; summary: string }[] = [];
  for (const block of content) {
    const b = block as Record<string, unknown>;
    if (b.type !== 'tool_use' || typeof b.name !== 'string' || b.name === '') continue;
    const input =
      typeof b.input === 'object' && b.input !== null
        ? (b.input as Record<string, unknown>)
        : {};
    out.push({ tool: b.name, summary: summarizeToolInput(b.name, input) });
  }
  return out;
}

/**
 * stream-json の 1 行を解釈する。対象外の行 (init/その他) は null。
 * - stream_event / content_block_delta / text_delta → delta
 * - stream_event / content_block_start / tool_use → tool_start (GAP-134 実況)
 * - control_request / can_use_tool → permission_request (GAP-134 承認)
 * - assistant (完成 message) → assistant_text (partial 不達時の代替)
 * - result → ok (subtype === 'success')
 * - rate_limit_event → rate_limit (GAP-119: 本人プラン枠の実観測値)
 */
export function parseStreamLine(line: string): ChatStreamItem | null {
  const trimmed = line.trim();
  if (!trimmed.startsWith('{')) return null;
  let json: unknown;
  try {
    json = JSON.parse(trimmed);
  } catch {
    return null;
  }
  if (typeof json !== 'object' || json === null) return null;
  const obj = json as Record<string, unknown>;
  if (obj.type === 'stream_event') {
    const event = obj.event as Record<string, unknown> | undefined;
    if (event?.type === 'content_block_start') {
      // GAP-134: ツール実行開始の実況 (UI の「ツール実行中: Bash」)
      const block = event.content_block as Record<string, unknown> | undefined;
      if (block?.type === 'tool_use' && typeof block.name === 'string' && block.name !== '') {
        return { kind: 'tool_start', tool: block.name };
      }
      return null;
    }
    if (event?.type !== 'content_block_delta') return null;
    const delta = event.delta as Record<string, unknown> | undefined;
    if (delta?.type !== 'text_delta' || typeof delta.text !== 'string' || delta.text === '')
      return null;
    return { kind: 'delta', text: delta.text };
  }
  if (obj.type === 'control_request') {
    // GAP-134: CLI の許可要求 (--permission-prompt-tool stdio)。
    // 実プロトコル (GAP-130 で raw 検証済): request.subtype === 'can_use_tool'
    const request = obj.request as Record<string, unknown> | undefined;
    if (request?.subtype !== 'can_use_tool') return null;
    const requestId = obj.request_id;
    const toolName = request.tool_name;
    if (typeof requestId !== 'string' || typeof toolName !== 'string') return null;
    const input =
      typeof request.input === 'object' && request.input !== null
        ? (request.input as Record<string, unknown>)
        : {};
    return { kind: 'permission_request', requestId, tool: toolName, input };
  }
  if (obj.type === 'assistant') {
    const message = obj.message as Record<string, unknown> | undefined;
    const content = Array.isArray(message?.content) ? message.content : [];
    const texts: string[] = [];
    for (const block of content) {
      const b = block as Record<string, unknown>;
      if (b.type === 'text' && typeof b.text === 'string' && b.text !== '') texts.push(b.text);
    }
    if (texts.length === 0) return null;
    return { kind: 'assistant_text', text: texts.join('') };
  }
  if (obj.type === 'result') {
    return {
      kind: 'result',
      ok: obj.subtype === 'success',
      // GAP-127: 失敗原因の分類材料 (例: "Invalid API key · Please run /login")
      ...(typeof obj.result === 'string' && obj.result !== ''
        ? { detail: obj.result }
        : {}),
    };
  }
  if (obj.type === 'rate_limit_event') {
    // claude CLI がプラン枠の状態変化時に発行する実値 (推測なし)。
    // GAP-128: 実 CLI の実測でフィールドは camelCase (rateLimitType/resetsAt)
    // だった。snake_case のみ読んでいて全 null になっていた実バグの是正 —
    // 将来の表記揺れに備えて両方受ける。
    const info = obj.rate_limit_info as Record<string, unknown> | undefined;
    const status = info?.status;
    if (status !== 'allowed' && status !== 'allowed_warning' && status !== 'rejected')
      return null;
    const rateLimitType = info?.rate_limit_type ?? info?.rateLimitType;
    const resetsAt = info?.resets_at ?? info?.resetsAt;
    return {
      kind: 'rate_limit',
      observation: {
        status,
        rate_limit_type: typeof rateLimitType === 'string' ? rateLimitType : null,
        utilization: typeof info?.utilization === 'number' ? info.utilization : null,
        resets_at: typeof resetsAt === 'number' ? resetsAt : null,
      },
    };
  }
  return null;
}

/** GAP-134: CLI へ返す control_response 行を組み立てる (実プロトコル準拠)。 */
export function buildControlResponse(
  requestId: string,
  decision: 'allow' | 'deny',
  input: Record<string, unknown>,
): string {
  const inner =
    decision === 'allow'
      ? { behavior: 'allow', updatedInput: input }
      : { behavior: 'deny', message: 'ユーザーがこのツール実行を拒否しました' };
  return `${JSON.stringify({
    type: 'control_response',
    response: { subtype: 'success', request_id: requestId, response: inner },
  })}\n`;
}

export interface ChatRelayConfig {
  readonly workerId: string;
  readonly command: string; // 既定 'claude'
  /** GAP-135: claude 引数の前に挿入する引数 (npm-shim 解決時の cli.js パス)。 */
  readonly prependArgs?: readonly string[];
  readonly timeoutMs: number;
  readonly env: Readonly<Record<string, string | undefined>>;
  /** chunk 送信のバッチ間隔 (ms)。テストでは 0 にできる。 */
  readonly flushIntervalMs: number;
  /** GAP-134: 承認待ちのポーリング間隔 / 上限 (テストで短縮可)。 */
  readonly approvalPollMs?: number;
  readonly approvalTimeoutMs?: number;
}

export interface ChatRelaySender {
  chatRelayPick(workerId: string): Promise<ChatRelayPicked | null>;
  chatRelayChunks(
    jobId: string,
    seqStart: number,
    texts: readonly string[],
    kinds?: readonly ChatRelayChunkKind[],
  ): Promise<void>;
  chatRelayCreateApproval(jobId: string, tool: string, summary: string): Promise<string>;
  chatRelayApprovalDecision(jobId: string, approvalId: string): Promise<ChatRelayApprovalDecision>;
  /** GAP-137: 成果物 (HTML) を送る — complete の前に呼ぶ契約。 */
  chatRelayUploadArtifacts(jobId: string, artifacts: readonly ChatArtifact[]): Promise<void>;
  /** GAP-141: ツールジョブ開始前に作業場へ展開する「正本」一式。 */
  chatRelayWorkspaceSeed(jobId: string): Promise<readonly ChatArtifact[]>;
  chatRelayComplete(
    jobId: string,
    ok: boolean,
    error?: string,
    rateLimits?: readonly ChatRelayRateLimitObservation[],
  ): Promise<void>;
}

export type ChatRelayOutcome = 'no-job' | 'completed' | 'failed';

/* ------------------------------------------------------------------ */
/* GAP-127: claude CLI 失敗の原因分類                                   */
/* ------------------------------------------------------------------ */

/** UI (接続パネル) が復旧手順を出すための安定タグ。error 文字列の先頭に付く。 */
export const ERROR_TAG_CLAUDE_NOT_FOUND = '[claude-not-found]';
export const ERROR_TAG_CLAUDE_NOT_LOGGED_IN = '[claude-not-logged-in]';

/** 未ログイン/認証切れを示す既知の CLI 出力パターン。 */
const NOT_LOGGED_IN_PATTERN =
  /please run \/login|invalid api key|not logged in|authentication[_ ]error|oauth token|invalid bearer token|credential/i;

/**
 * claude 実行失敗を分類してタグ付き error 文字列にする。
 * 判定材料は result 行の本文 + stderr 末尾 (推測はせず、根拠断片を残す)。
 */
export function classifyRunFailure(run: {
  readonly exitCode: number | null;
  readonly spawnFailed: boolean;
  readonly stderrTail: string;
  readonly resultDetail: string;
}): string {
  if (run.spawnFailed) {
    return `${ERROR_TAG_CLAUDE_NOT_FOUND} claude コマンドを起動できません (未インストールか PATH 不通)`;
  }
  const evidence = `${run.resultDetail}\n${run.stderrTail}`.trim();
  if (NOT_LOGGED_IN_PATTERN.test(evidence)) {
    return `${ERROR_TAG_CLAUDE_NOT_LOGGED_IN} Claude が未ログインです: ${evidence.slice(0, 300)}`;
  }
  return evidence !== ''
    ? `claude 実行失敗 (exit=${run.exitCode}): ${evidence.slice(0, 300)}`
    : `claude 実行失敗 (exit=${run.exitCode})`;
}

interface PendingChunk {
  readonly text: string;
  readonly chunkKind: ChatRelayChunkKind;
}

/**
 * 1 job を pick → 実行 → 返送する。job が無ければ 'no-job'。
 *
 * chunks 送信は flushIntervalMs ごとのバッチ (delta 1 個ずつ POST すると
 * 応答長に比例して往復が増えるため)。送信失敗はリトライせず job を error で
 * 確定する (SSE 側はタイムアウトかエラーで誠実に終わる)。
 */
export class ChatRelayWorker {
  constructor(
    private readonly api: ChatRelaySender,
    private readonly config: ChatRelayConfig,
  ) {}

  async runOnce(): Promise<ChatRelayOutcome> {
    const picked = await this.api.chatRelayPick(this.config.workerId);
    if (picked === null) return 'no-job';
    const { jobId, systemPrompt, prompt, toolsMode } = picked;

    let seq = 0;
    let pending: PendingChunk[] = [];
    let sendError: unknown = null;
    let sendChain: Promise<void> = Promise.resolve();

    const flush = (): void => {
      if (pending.length === 0 || sendError !== null) return;
      const batch = pending;
      const seqStart = seq;
      seq += batch.length;
      pending = [];
      // 順序保証のため直列チェーンで送る (並行 POST は seq 順を壊しうる)
      sendChain = sendChain.then(async () => {
        if (sendError !== null) return;
        try {
          await this.api.chatRelayChunks(
            jobId,
            seqStart,
            batch.map((c) => c.text),
            batch.map((c) => c.chunkKind),
          );
        } catch (err: unknown) {
          sendError = err;
        }
      });
    };

    // GAP-134: 承認往復 — CLI の許可要求をサーバーへ積み、決定を待って返す。
    // 許可対象外ツール (WebSearch 等) はカードを出さず即拒否 (サーバー側と同一)。
    const allowed = new Set<string>(ALLOWED_TOOLS);
    const decideApproval = async (
      tool: string,
      input: Record<string, unknown>,
    ): Promise<'allow' | 'deny'> => {
      if (!allowed.has(tool)) return 'deny';
      const approvalId = await this.api.chatRelayCreateApproval(
        jobId,
        tool,
        summarizeToolInput(tool, input),
      );
      const pollMs = this.config.approvalPollMs ?? 700;
      const deadline = Date.now() + (this.config.approvalTimeoutMs ?? 300_000);
      for (;;) {
        const decision = await this.api.chatRelayApprovalDecision(jobId, approvalId);
        if (decision === 'allow') return 'allow';
        if (decision === 'deny' || decision === 'timeout') return 'deny';
        if (Date.now() > deadline) return 'deny'; // 無応答は拒否に倒す (勝手に実行しない)
        await new Promise((r) => setTimeout(r, pollMs));
      }
    };

    // GAP-119: 実行中に観測した rate_limit_event を window 別に最新値で保持
    const rateLimits = new Map<string, ChatRelayRateLimitObservation>();

    // GAP-141: ツールジョブは開始前に「正本」(プロジェクト最新版) を作業場へ
    // 展開する — ローカルに残った古いファイルを土台に編集させない。
    // 展開後にスナップショットするので、未編集の seed は再取り込みされない。
    const workspace = toolsMode !== 'off' ? chatWorkspaceDir(this.config.env) : null;
    if (workspace !== null) {
      try {
        mkdirSync(workspace, { recursive: true });
        const seed = await this.api.chatRelayWorkspaceSeed(jobId);
        for (const f of seed) {
          if (f.html === undefined) continue; // seed は HTML 正本のみ (GAP-141)
          const safe = f.fileName.replaceAll('\\', '/').split('/').pop() ?? '';
          if (safe === '' || safe === '.' || safe === '..') continue;
          const target = join(workspace, safe);
          try {
            writeFileSync(target, f.html);
          } catch {
            /* 個別の書込失敗は seed 全体を止めない */
          }
        }
      } catch (err: unknown) {
        // seed 取得失敗は実行を止めない (作業場が空のまま = 従来動作)
        console.error('[bridge:chat-relay] workspace seed 失敗 (続行):', err);
      }
    }
    // GAP-137: PC 操作の成果物検出 — 実行前スナップショット (seed 展開後)
    const wsBefore = workspace !== null ? snapshotArtifactFiles(workspace) : null;

    // 実行中に flush を回す — delta は claude の実行と並行して逐次返送される
    const timer = setInterval(flush, Math.max(this.config.flushIntervalMs, 1));
    let run;
    try {
      run = await this.runChild(systemPrompt, prompt, toolsMode, decideApproval, (item) => {
        if (item.kind === 'delta') pending.push({ text: item.text, chunkKind: 'delta' });
        else if (item.kind === 'tool_start')
          pending.push({ text: item.tool, chunkKind: 'tool' });
        else if (item.kind === 'tool_detail')
          // GAP-148: 実入力の要約 (JSON) — UI が名前だけの行を実値行へ格上げする
          pending.push({
            text: JSON.stringify({ tool: item.tool, summary: item.summary }),
            chunkKind: 'tool',
          });
        else if (item.kind === 'rate_limit')
          rateLimits.set(item.observation.rate_limit_type ?? 'overall', item.observation);
      });
    } finally {
      clearInterval(timer);
    }
    // partial が 1 つも取れなかった場合は完成 assistant text で代替
    if (seq === 0 && pending.length === 0 && run.assistantText !== '') {
      pending.push({ text: run.assistantText, chunkKind: 'delta' });
    }
    flush();
    await sendChain;

    // GAP-137/145: 成功時のみ、作業フォルダの新規/更新成果物 (HTML + 画像/PPTX/PDF 等) を
    // ツール内へ反映する (complete 前に送る — SSE が同一ストリームで
    // 「モック保存」カードを配れる)。送信失敗は応答自体を壊さない。
    if (run.ok && sendError === null && workspace !== null && wsBefore !== null) {
      const artifacts = collectNewArtifacts(workspace, wsBefore);
      if (artifacts.length > 0) {
        try {
          await this.api.chatRelayUploadArtifacts(jobId, artifacts);
        } catch (err: unknown) {
          console.error('[bridge:chat-relay] 成果物送信失敗 (応答は継続):', err);
        }
      }
    }

    const ok = run.ok && sendError === null;
    const error = ok
      ? undefined
      : (sendError !== null
          ? `chunk 送信失敗: ${String(sendError)}`
          : run.timedOut
            ? `claude 実行タイムアウト (${this.jobTimeoutMs(toolsMode)}ms)`
            : classifyRunFailure(run) // GAP-127: 未ログイン/未インストールをタグ付け
        ).slice(0, 2000);
    try {
      await this.api.chatRelayComplete(jobId, ok, error, [...rateLimits.values()]);
    } catch (err: unknown) {
      console.error('[bridge:chat-relay] complete 送信失敗:', err);
      return 'failed';
    }
    return ok ? 'completed' : 'failed';
  }

  /** GAP-134: ツールありは複数ターン + 承認待ちを含むためタイムアウトを引き上げる。 */
  private jobTimeoutMs(toolsMode: ChatToolsMode): number {
    return toolsMode === 'off'
      ? this.config.timeoutMs
      : Math.max(this.config.timeoutMs, 600_000);
  }

  private runChild(
    systemPrompt: string,
    prompt: string,
    toolsMode: ChatToolsMode,
    decideApproval: (
      tool: string,
      input: Record<string, unknown>,
    ) => Promise<'allow' | 'deny'>,
    onItem: (item: ChatStreamItem) => void,
  ): Promise<{
    ok: boolean;
    exitCode: number | null;
    timedOut: boolean;
    assistantText: string;
    spawnFailed: boolean;
    stderrTail: string;
    resultDetail: string;
  }> {
    return new Promise((resolve) => {
      // GAP-134/138: 常に本人 PC の作業フォルダをカレントにして実行する。
      // off モードでも cwd を固定しないと、Bridge の起動場所がたまたま
      // 開発リポジトリ等だった場合にそこの .claude (hooks / CLAUDE.md) を
      // 拾ってチャット応答が汚染・失敗する (e2e で実測した実バグ)。
      const spawnOpts: { stdio: ['pipe', 'pipe', 'pipe']; env: Record<string, string>; cwd: string } =
        {
          stdio: ['pipe', 'pipe', 'pipe'],
          env: sanitizedChildEnv(this.config.env),
          cwd: chatWorkspaceDir(this.config.env),
        };
      try {
        mkdirSync(spawnOpts.cwd, { recursive: true });
      } catch {
        /* 既存 or 権限 — CLI 側のエラーに任せる */
      }
      const child = spawn(
        this.config.command,
        [...(this.config.prependArgs ?? []), ...buildChatArgs(systemPrompt, toolsMode)],
        spawnOpts,
      );
      if (toolsMode === 'approve') {
        // stream-json 入力: user メッセージ 1 件を送り、承認往復のため
        // stdin は result まで開いたままにする (閉じると CLI の許可要求が
        // "Stream closed" で全滅する — GAP-130 の SDK バグと同根)
        child.stdin.write(
          `${JSON.stringify({
            type: 'user',
            session_id: '',
            message: { role: 'user', content: prompt },
            parent_tool_use_id: null,
          })}\n`,
        );
      } else {
        child.stdin.write(prompt);
        child.stdin.end();
      }

      let timedOut = false;
      let sawDelta = false;
      let assistantText = '';
      let resultOk: boolean | null = null;
      let resultDetail = '';
      let stderrTail = '';
      let buffer = '';
      const handleLine = (line: string): void => {
        // GAP-148: tool_use の実入力要約 (assistant 完成メッセージ由来) —
        // UI が「Bash(npm test)」のような Claude Code 風の行を出す材料
        for (const d of extractToolDetails(line)) {
          onItem({ kind: 'tool_detail', tool: d.tool, summary: d.summary });
        }
        const item = parseStreamLine(line);
        if (item === null) return;
        if (item.kind === 'delta') {
          sawDelta = true;
          onItem(item);
        } else if (item.kind === 'tool_start' || item.kind === 'rate_limit') {
          onItem(item);
        } else if (item.kind === 'permission_request') {
          // GAP-134: 承認往復は stdout 読み取りを止めない (非同期で決定を書き戻す)
          void decideApproval(item.tool, item.input)
            .catch(() => 'deny' as const)
            .then((decision) => {
              if (!child.stdin.destroyed) {
                child.stdin.write(buildControlResponse(item.requestId, decision, item.input));
              }
            });
        } else if (item.kind === 'assistant_text') {
          assistantText += item.text;
        } else if (item.kind === 'tool_detail') {
          onItem(item); // parseStreamLine は返さない (extractToolDetails 経由) — 型網羅
        } else {
          resultOk = item.ok;
          // GAP-127: 失敗時の result 本文は原因分類の材料 (成功時は不要)
          if (!item.ok && item.detail) resultDetail = item.detail;
          if (toolsMode === 'approve' && !child.stdin.destroyed) {
            // result を受けたら入力を閉じて CLI を終了させる
            child.stdin.end();
          }
        }
      };
      child.stdout.on('data', (chunk: Buffer) => {
        buffer += chunk.toString();
        for (;;) {
          const nl = buffer.indexOf('\n');
          if (nl < 0) break;
          handleLine(buffer.slice(0, nl));
          buffer = buffer.slice(nl + 1);
        }
      });
      child.stderr.on('data', (chunk: Buffer) => {
        // GAP-127: 失敗原因の分類材料として末尾だけ保持 (成功時は捨てる)
        stderrTail = (stderrTail + chunk.toString()).slice(-2000);
      });
      const timer = setTimeout(() => {
        timedOut = true;
        child.kill('SIGKILL');
      }, this.jobTimeoutMs(toolsMode));
      child.on('close', (code) => {
        clearTimeout(timer);
        if (buffer !== '') handleLine(buffer);
        resolve({
          ok: !timedOut && code === 0 && resultOk !== false,
          exitCode: code,
          timedOut,
          // partial を受けた場合は assistantText を使わない (二重返送防止)
          assistantText: sawDelta ? '' : assistantText,
          spawnFailed: false,
          stderrTail,
          resultDetail,
        });
      });
      child.on('error', () => {
        clearTimeout(timer);
        resolve({
          ok: false,
          exitCode: 127,
          timedOut: false,
          assistantText: '',
          // GAP-127: spawn 自体の失敗 = claude コマンド不在 (ENOENT 等)
          spawnFailed: true,
          stderrTail,
          resultDetail,
        });
      });
    });
  }
}
