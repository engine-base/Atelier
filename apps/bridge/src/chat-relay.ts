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
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { join, relative, sep } from 'node:path';

import type {
  ChatRelayApprovalDecision,
  ChatRelayChunkKind,
  ChatRelayPicked,
  ChatRelayRateLimitObservation,
} from './api-client.js';
// GAP-191: スレッドごとに claude を常駐させ、実行中でも指示を流し込む。
import {
  PersistentSession,
  PersistentSessionPool,
  idleTimeoutMs,
  persistentEnabled,
  sessionKey,
} from './persistent-session.js';
// GAP-199: クラウド由来の値をそのまま信じない (上限は PC 側が決める)。
import {
  appendAudit,
  isValidSessionId,
  normalizeToolsMode,
  resolvesInsideWorkspace,
} from './security.js';

export const CHAT_RELAY_ENABLED_ENV = 'ATELIER_BRIDGE_CHAT_RELAY';
export const CHAT_WORKSPACE_ENV = 'ATELIER_BRIDGE_CHAT_WORKSPACE';

export type ChatToolsMode = 'off' | 'approve' | 'auto';

/**
 * GAP-191: 実行中のターンへ届いた追い足しを、画面にもそれと分かる形で残す。
 * 黙って会話に混ぜると「言ったのに反映されていない」に見える。
 */
export const FOLLOW_UP_MARK = (text: string): string =>
  `\n\n---\n（実行中に追加で伝えました）${text}\n---\n`;

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

/* ------------------------------------------------------------------ */
/* GAP-190: スレッドごとに「同じ Claude セッション」で走らせる           */
/* ------------------------------------------------------------------ */

/**
 * claude が会話を保存する transcript のパスを求める。
 *
 * 実測 (2026-08-20): `~/.claude/projects/<cwd の / を - に置換>/<session-id>.jsonl`。
 * 例) cwd=/tmp/g190work, id=abc → ~/.claude/projects/-tmp-g190work/abc.jsonl
 *
 * このパスが**決定的に求まる**ので、Bridge は「この PC でそのセッションを
 * 再開できるか」を推測せずに判定できる。
 */
export function sessionTranscriptPath(
  cwd: string,
  sessionId: string,
  env: Readonly<Record<string, string | undefined>> = process.env,
): string {
  const home = env.HOME ?? env.USERPROFILE ?? homedir();
  // Windows のドライブレターや区切りも同じ規則に寄せる
  const encoded = cwd.replaceAll('\\', '/').replaceAll('/', '-');
  return join(home, '.claude', 'projects', encoded, `${sessionId}.jsonl`);
}

/** この PC でそのセッションを再開できるか (実ファイルの有無で決める)。 */
export function canResumeSession(
  cwd: string,
  sessionId: string | undefined,
  env: Readonly<Record<string, string | undefined>> = process.env,
): boolean {
  if (sessionId === undefined || sessionId === '') return false;
  try {
    return existsSync(sessionTranscriptPath(cwd, sessionId, env));
  } catch {
    // 権限等で見られないときは「再開できない」に倒す (勝手に --resume して落ちない)
    return false;
  }
}

/** GAP-190: セッションの使い方の決定。 */
export interface SessionPlan {
  /** 実際に使うセッション ID。 */
  readonly sessionId: string;
  /** 再開するか (false = このセッション ID で新規に始める)。 */
  readonly resume: boolean;
  /** 実際に送るプロンプト (再開時は新しい発言だけ = プラン枠の節約)。 */
  readonly prompt: string;
}

/**
 * サーバーの指定と、この PC の実状からセッションの使い方を決める。
 *
 * - サーバーが ID を指定し、この PC に実体がある → 再開 + 新しい発言だけ
 * - サーバーが ID を指定したが実体が無い (別 PC / 初期化後) → その ID で新規に
 *   始め、**履歴を畳んだプロンプト**を使う (会話が飛ばない)
 * - サーバーが ID を指定しない (システムジョブ等) → セッションを使わない
 */
export function planSession(
  picked: {
    readonly prompt: string;
    readonly sessionId?: string;
    readonly promptFull?: string;
  },
  cwd: string,
  env: Readonly<Record<string, string | undefined>> = process.env,
): SessionPlan | null {
  if (picked.sessionId === undefined || picked.sessionId === '') return null;
  // GAP-199: この値は `--session-id <値>` として引数になり、transcript の
  // ファイルパスにも使われる。UUID 以外は受け付けない (`../` も `-` 始まりも弾く)。
  if (!isValidSessionId(picked.sessionId)) return null;
  const resume = canResumeSession(cwd, picked.sessionId, env);
  return {
    sessionId: picked.sessionId,
    resume,
    // 再開できないなら履歴込み。promptFull が無ければ prompt をそのまま使う。
    prompt: resume ? picked.prompt : (picked.promptFull ?? picked.prompt),
  };
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
export function buildChatArgs(
  systemPrompt: string,
  toolsMode: ChatToolsMode = 'off',
  /**
   * GAP-190: セッションの使い方。resume なら --resume、そうでなければ
   * --session-id で「この ID で始める」。null ならセッションを使わない
   * (従来どおり毎回まっさらなセッション)。
   *
   * --append-system-prompt は再開時も毎回渡す — ペルソナ・案件状況・RAG は
   * ターンごとに変わるので、履歴を送らなくても最新の文脈は効かせる。
   */
  session: { readonly sessionId: string; readonly resume: boolean } | null = null,
  /**
   * GAP-191: 常駐プロセスとして起動するか。
   * true なら `--input-format stream-json` を必ず付ける — stdin を開いたままに
   * して、**ターンをまたいで / 実行中にも**指示を送れるようにするため
   * (実 CLI で 1 プロセス・同一 session_id のまま 2 ターン処理できることを確認済み)。
   */
  persistent = false,
): string[] {
  const base = [
    '-p',
    '--append-system-prompt',
    systemPrompt,
    '--output-format',
    'stream-json',
    '--include-partial-messages',
    '--verbose',
    ...(session === null
      ? []
      : session.resume
        ? ['--resume', session.sessionId]
        : ['--session-id', session.sessionId]),
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
      ...(persistent ? ['--input-format', 'stream-json'] : []),
    ];
  }
  if (toolsMode === 'approve') {
    // approve は元から stream-json 入力 (承認往復のため stdin を開いたままにする)
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
    // GAP-199: 作業フォルダの外を指すシンボリックリンクは送らない。
    // 例) report.html -> ~/.ssh/id_rsa を置かれても外に出ない。
    if (!resolvesInsideWorkspace(root, path)) continue;
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
  /** GAP-189: 中断要求を見に行く間隔 (ms)。既定 2 秒、テストで短縮可。 */
  readonly cancelPollMs?: number;
  /**
   * GAP-199: ローカル監査ログに残す指示元 (API の origin)。
   * 「どのサーバーからの指示で、この PC が何をしたか」を後から追えるようにする。
   */
  readonly apiOrigin?: string;
  /** GAP-199: 監査ログの書き込み先ホーム (テストで差し替える)。 */
  readonly auditHome?: string;
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
  /** GAP-189: 中断要求のポーリング (true なら PC 上の claude を実際に止める)。 */
  chatRelayControl(jobId: string): Promise<boolean>;
  /**
   * GAP-191: 実行中のターンへ流し込む追い足しを 1 件取り出す (無ければ null)。
   * 常駐プロセスを使っているときだけ呼ぶ — 取り出して捨てると指示が消えるため。
   */
  chatRelayFollowUp?(jobId: string): Promise<string | null>;
  /** GAP-137: 成果物 (HTML) を送る — complete の前に呼ぶ契約。 */
  chatRelayUploadArtifacts(jobId: string, artifacts: readonly ChatArtifact[]): Promise<void>;
  /** GAP-141: ツールジョブ開始前に作業場へ展開する「正本」一式。 */
  chatRelayWorkspaceSeed(jobId: string): Promise<readonly ChatArtifact[]>;
  chatRelayComplete(
    jobId: string,
    ok: boolean,
    error?: string,
    rateLimits?: readonly ChatRelayRateLimitObservation[],
    /** GAP-190: 実際に使った Claude セッションの実測値 (再開できたか含む)。 */
    session?: { readonly sessionId: string; readonly resumed: boolean },
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
/** GAP-191: 実行中のターンを外から操作する口。 */
export interface PersistentTurnHandle {
  /** この PC 上の claude を実際に止める。 */
  readonly kill: () => void;
  /** 実行中でも指示を流し込む (送れたら true)。 */
  readonly inject: (text: string) => boolean;
  readonly pid: number | undefined;
}

/** runChild / runPersistent の戻り値 (同じ形で扱う)。 */
export interface RunChildResult {
  ok: boolean;
  exitCode: number | null;
  timedOut: boolean;
  assistantText: string;
  spawnFailed: boolean;
  stderrTail: string;
  resultDetail: string;
  /** GAP-191: 既に生きていたプロセスを使い回したか (起動コストが要らなかった)。 */
  reusedProcess?: boolean;
}

export class ChatRelayWorker {
  /**
   * GAP-191: スレッド (セッション) ごとの常駐プロセス台帳。
   * worker はジョブごとに使い回されるので、プロセスは**クラス側**で持つ。
   */
  static readonly sessions = new PersistentSessionPool();

  constructor(
    private readonly api: ChatRelaySender,
    private readonly config: ChatRelayConfig,
  ) {}

  async runOnce(): Promise<ChatRelayOutcome> {
    const picked = await this.api.chatRelayPick(this.config.workerId);
    if (picked === null) return 'no-job';
    const { jobId, systemPrompt } = picked;
    // GAP-199: 実行モードは既知の 3 値に正規化するだけ (PC 側で上限は掛けない —
    // Claude Code もやっていないので勝手に制限を足さない、という判断)。
    // 想定外の文字列で強い権限に倒れないようにするための検証。
    const toolsMode = normalizeToolsMode(picked.toolsMode);

    // GAP-190: このスレッドのセッションをこの PC で再開できるかを、
    // transcript の実ファイルを見て決める (推測しない)。
    // 再開できるときは履歴を送らない = 利用者のプラン枠を余分に使わない。
    const plan = planSession(picked, chatWorkspaceDir(this.config.env), this.config.env);
    const prompt = plan === null ? picked.prompt : plan.prompt;

    // GAP-199: 何をさせられたかが本人の PC に残るようにする。
    // 書けなくても実行は止めない (監査は目的ではなく、後から見返すための記録)。
    const writeAudit = (outcome: string): void => {
      appendAudit(
        {
          at: new Date().toISOString(),
          jobId,
          requestedMode: picked.toolsMode,
          effectiveMode: toolsMode,
          cwd: chatWorkspaceDir(this.config.env),
          apiOrigin: this.config.apiOrigin ?? '',
          outcome,
        },
        this.config.env,
        this.config.auditHome,
      );
    };

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
          const safe = f.fileName.replaceAll('\\', '/').split('/').pop() ?? '';
          if (safe === '' || safe === '.' || safe === '..') continue;
          const target = join(workspace, safe);
          try {
            // GAP-169: サーバーは未設定フィールドを null で返すことがある。
            // `!== undefined` だけで見ていたため、html=null の base64 項目で
            // writeFileSync(target, null) が投げ、Excel/PDF が作業場に
            // 展開されないまま黙って落ちていた (実往復で検出した実バグ)。
            if (typeof f.html === 'string' && f.html !== '') {
              writeFileSync(target, f.html); // HTML 正本 (GAP-141)
            } else if (typeof f.contentB64 === 'string' && f.contentB64 !== '') {
              // GAP-161: ユーザーが会話に添付した資料 (画像/PDF/Excel 等) の実体。
              // これがあることで、この PC で走る Claude Code が実物を直接読める。
              writeFileSync(target, Buffer.from(f.contentB64, 'base64'));
            }
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

    // GAP-189: 中断の見張り。人が「停止」を押したらサーバーの状態が cancelled に
    // なるので、それを見て **この PC の claude を実際に kill する**。
    // 通信できないときは中断とみなさない (通信不良で仕事を殺さない)。
    let cancelled = false;
    let killChild: (() => void) | null = null;
    // GAP-191: 走っているターンへ**そのまま**流し込む口 (常駐プロセスのときだけ非 null)。
    let injectFollowUp: ((text: string) => boolean) | null = null;
    const cancelTimer = setInterval(() => {
      void this.api
        .chatRelayControl(jobId)
        .then((stop) => {
          if (!stop || cancelled) return;
          cancelled = true;
          killChild?.();
        })
        .catch(() => {
          /* 通信不良は中断ではない — 走っている仕事を殺さない */
        });
      // GAP-191: 中断の見張りと同じ間隔で「追い足し」も見る。
      // 常駐していないとき (従来動作) は取り出さない — 取り出して捨てると
      // 指示が消えてしまう。その場合は実行後に次のジョブとして流れる。
      if (injectFollowUp === null || cancelled) return;
      const followUp = this.api.chatRelayFollowUp?.bind(this.api);
      if (followUp === undefined) return;
      void followUp(jobId)
        .then((text: string | null) => {
          if (text === null || cancelled) return;
          const sent = injectFollowUp?.(text) ?? false;
          if (sent) {
            // 画面にも「今の実行に届いた」ことを出す (黙って混ぜない)
            pending.push({ text: FOLLOW_UP_MARK(text), chunkKind: 'delta' });
          } else {
            console.error('[bridge:chat-relay] 追い足しを流し込めませんでした');
          }
        })
        .catch(() => {
          /* 通信不良は「追い足し無し」として扱う */
        });
    }, Math.max(this.config.cancelPollMs ?? 2_000, 1));

    // 実行中に flush を回す — delta は claude の実行と並行して逐次返送される
    const timer = setInterval(flush, Math.max(this.config.flushIntervalMs, 1));
    let run;
    // GAP-191: 常駐プロセスが使えるのは「セッションがある」かつ「ツールあり」のとき。
    // off モードは 1 往復で終わる軽い経路なので従来どおり (stdin にテキストを書いて閉じる)。
    const usePersistent =
      persistentEnabled(this.config.env) && plan !== null && toolsMode !== 'off';
    const onItem = (item: ChatStreamItem): void => {
      if (item.kind === 'delta') pending.push({ text: item.text, chunkKind: 'delta' });
      else if (item.kind === 'tool_start') pending.push({ text: item.tool, chunkKind: 'tool' });
      else if (item.kind === 'tool_detail')
        // GAP-148: 実入力の要約 (JSON) — UI が名前だけの行を実値行へ格上げする
        pending.push({
          text: JSON.stringify({ tool: item.tool, summary: item.summary }),
          chunkKind: 'tool',
        });
      else if (item.kind === 'rate_limit')
        rateLimits.set(item.observation.rate_limit_type ?? 'overall', item.observation);
    };
    try {
      run = usePersistent
        ? await this.runPersistent(
            systemPrompt,
            prompt,
            toolsMode,
            plan as SessionPlan,
            decideApproval,
            onItem,
            (handle) => {
              killChild = handle.kill;
              injectFollowUp = handle.inject;
              if (cancelled) handle.kill();
            },
          )
        : await this.runChild(
            systemPrompt,
            prompt,
            toolsMode,
            plan,
            decideApproval,
            onItem,
            (kill) => {
              killChild = kill;
              // 見張りが先に「止めろ」を掴んでいた場合の取りこぼしを防ぐ。
              if (cancelled) kill();
            },
          );
    } finally {
      clearInterval(timer);
      clearInterval(cancelTimer);
    }

    // GAP-189: 中断されたときは、そこまでに出た本文だけ送って静かに終える。
    // 成果物の取り込みはしない (途中の状態をツールへ反映しない)。
    // complete は「Bridge が停止処理を終えた」報告 — サーバー側は cancelled を
    // 上書きせず静かに受け取る。
    if (cancelled) {
      flush();
      await sendChain.catch(() => undefined);
      try {
        await this.api.chatRelayComplete(
          jobId,
          false,
          '[cancelled] ユーザーが中断しました',
          undefined,
          plan === null ? undefined : { sessionId: plan.sessionId, resumed: plan.resume },
        );
      } catch {
        /* 中断済みなので送信失敗は握りつぶす */
      }
      writeAudit('cancelled');
      return 'completed';
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
      await this.api.chatRelayComplete(
        jobId,
        ok,
        error,
        [...rateLimits.values()],
        // GAP-190: 実際に使ったセッションと、再開できたかの実測値を返す。
        // サーバーはこれを正としてスレッドへ保存する (次回から確実に再開できる)。
        plan === null ? undefined : { sessionId: plan.sessionId, resumed: plan.resume },
      );
    } catch (err: unknown) {
      console.error('[bridge:chat-relay] complete 送信失敗:', err);
      writeAudit('report-failed');
      return 'failed';
    }
    writeAudit(ok ? 'completed' : 'failed');
    return ok ? 'completed' : 'failed';
  }

  /** GAP-134: ツールありは複数ターン + 承認待ちを含むためタイムアウトを引き上げる。 */
  private jobTimeoutMs(toolsMode: ChatToolsMode): number {
    return toolsMode === 'off'
      ? this.config.timeoutMs
      : Math.max(this.config.timeoutMs, 600_000);
  }

  /**
   * GAP-191: 常駐プロセスで 1 ターン走らせる。
   *
   * 従来 (runChild) は 1 ターン 1 プロセスだった。ここではスレッド (セッション)
   * ごとにプロセスを保ち、
   *   - 2 ターン目以降は**起動もセッション復元も要らない**
   *   - **実行中でも `injectFollowUp()` で指示を流し込める**
   * ようにする。実 CLI で「1 プロセス・同一 session_id のまま 2 ターン処理」
   * 「1 ターン目の実行中に送った 2 通目が受け取られる」ことを確認済み。
   */
  private runPersistent(
    systemPrompt: string,
    prompt: string,
    toolsMode: ChatToolsMode,
    session: SessionPlan,
    decideApproval: (
      tool: string,
      input: Record<string, unknown>,
    ) => Promise<'allow' | 'deny'>,
    onItem: (item: ChatStreamItem) => void,
    onReady?: (handle: PersistentTurnHandle) => void,
  ): Promise<RunChildResult> {
    return new Promise((resolve) => {
      const cwd = chatWorkspaceDir(this.config.env);
      try {
        mkdirSync(cwd, { recursive: true });
      } catch {
        /* 既存 or 権限 — CLI 側のエラーに任せる */
      }
      const key = sessionKey(cwd, session.sessionId);
      const pool = ChatRelayWorker.sessions;
      const before = pool.size;
      const live = pool.acquire(
        key,
        () =>
          new PersistentSession({
            command: this.config.command,
            args: [
              ...(this.config.prependArgs ?? []),
              ...buildChatArgs(systemPrompt, toolsMode, session, true),
            ],
            cwd,
            env: sanitizedChildEnv(this.config.env),
            idleMs: idleTimeoutMs(this.config.env),
            onExit: () => pool.drop(key),
          }),
      );
      const reused = live.alive;
      live.start();
      if (!live.alive) {
        resolve({
          ok: false,
          exitCode: 127,
          timedOut: false,
          assistantText: '',
          spawnFailed: true,
          stderrTail: live.stderr,
          resultDetail: '',
        });
        return;
      }
      void before;

      let settled = false;
      let timedOut = false;
      let sawDelta = false;
      let assistantText = '';
      let resultOk: boolean | null = null;
      let resultDetail = '';

      const finish = (): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        unsubscribe();
        resolve({
          ok: !timedOut && resultOk !== false,
          exitCode: timedOut ? null : 0,
          timedOut,
          assistantText: sawDelta ? '' : assistantText,
          spawnFailed: false,
          stderrTail: live.stderr,
          resultDetail,
          reusedProcess: reused,
        });
      };

      const unsubscribe = live.onLine((line) => {
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
          void decideApproval(item.tool, item.input)
            .catch(() => 'deny' as const)
            .then((decision) => {
              live.writeRaw(buildControlResponse(item.requestId, decision, item.input));
            });
        } else if (item.kind === 'assistant_text') {
          assistantText += item.text;
        } else if (item.kind === 'tool_detail') {
          onItem(item);
        } else {
          resultOk = item.ok;
          if (!item.ok && item.detail) resultDetail = item.detail;
          // **stdin は閉じない** — 閉じるとプロセスが終わって常駐でなくなる。
          finish();
        }
      });

      const timer = setTimeout(() => {
        timedOut = true;
        // ターンが返らないプロセスは使い回さない (壊れたまま次のターンへ渡さない)
        pool.drop(key);
        finish();
      }, this.jobTimeoutMs(toolsMode));

      onReady?.({
        // GAP-189 と同じ「実際に止める」口。常駐でも PC 上の claude を本当に殺す。
        kill: () => {
          pool.drop(key);
        },
        // GAP-191: **実行中に**追い足しを流し込む。
        inject: (text: string) => live.send(text, { asFollowUp: true }),
        pid: live.pid,
      });

      if (!live.send(prompt)) {
        timedOut = false;
        resultOk = false;
        resultDetail = 'prompt を常駐プロセスへ送れませんでした';
        pool.drop(key);
        finish();
      }
    });
  }

  private runChild(
    systemPrompt: string,
    prompt: string,
    toolsMode: ChatToolsMode,
    /** GAP-190: 使うセッション (null = セッションを使わない従来動作)。 */
    session: SessionPlan | null,
    decideApproval: (
      tool: string,
      input: Record<string, unknown>,
    ) => Promise<'allow' | 'deny'>,
    onItem: (item: ChatStreamItem) => void,
    /** GAP-189: 起動直後に「この子プロセスを止める関数」を渡す。 */
    onSpawn?: (kill: () => void) => void,
  ): Promise<RunChildResult> {
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
        [
          ...(this.config.prependArgs ?? []),
          ...buildChatArgs(systemPrompt, toolsMode, session),
        ],
        spawnOpts,
      );
      // GAP-189: 中断されたときに **この PC 上の claude を実際に止める**ための
      // 口を呼び出し側へ渡す。クラウドの状態を落とすだけの嘘の中断にしない。
      onSpawn?.(() => {
        if (child.exitCode === null && child.signalCode === null) {
          child.kill('SIGTERM');
          // SIGTERM を無視して残る場合に備えて、少し待って強制終了する。
          setTimeout(() => {
            if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
          }, 2_000).unref?.();
        }
      });
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
