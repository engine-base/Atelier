/**
 * Atelier Bridge — スレッドごとの常駐 Claude プロセス (GAP-191)
 *
 * **これまでの実態**: GAP-190 で `--session-id` / `--resume` により会話は続くように
 * なったが、**ターンごとに新しい `claude -p` を起動していた**。そのため
 *   - 実行中のターンへ指示を差し込めない (終わるまで待って次のジョブとして流す)
 *   - 毎ターン起動コスト (数秒) がかかる
 *
 * **実 CLI で確認した事実 (2026-08-20 実測)**:
 *   `--input-format stream-json` で起動したプロセスは stdin を開いたまま
 *   **複数ターンを同じ session_id・同じ pid で処理する**。さらに
 *   **1 ターン目の実行中 (t=3.3s) に 2 通目を送っても受け取られ**、
 *   1 ターン目の結果 (t=4.4s) の直後に 2 通目の答え (t=7.2s) が返った。
 *   → Claude Code のインタラクティブで作業中に入力するのと同じ挙動。
 *
 * **この モジュールがやること**: スレッド (= セッション) ごとに 1 プロセスを保ち、
 *   - ターンをまたいで使い回す (起動コストとセッション再構築が消える)
 *   - **実行中でも `send()` で指示を流し込める**
 *   - 一定時間使われなければ自分で終了する (利用者の PC に居座らない)
 *   - 中断は SIGTERM → SIGKILL で**実際に止める** (GAP-189 と同じ)
 *
 * **どこで動くか**: 利用者の PC。**誰の費用か**: 利用者本人の Claude プラン。
 */

import { type ChildProcess, spawn } from 'node:child_process';

/** 常駐を止めたいとき用 ('0' で 1 ターン 1 プロセスの従来動作)。既定は ON。 */
export const PERSISTENT_ENV = 'ATELIER_BRIDGE_PERSISTENT';
/** 何も来なくなってからプロセスを畳むまでの時間 (ms)。 */
export const IDLE_TIMEOUT_ENV = 'ATELIER_BRIDGE_PERSISTENT_IDLE_MS';
export const DEFAULT_IDLE_TIMEOUT_MS = 15 * 60_000;

export function persistentEnabled(env: Readonly<Record<string, string | undefined>>): boolean {
  return env[PERSISTENT_ENV] !== '0';
}

export function idleTimeoutMs(env: Readonly<Record<string, string | undefined>>): number {
  const raw = (env[IDLE_TIMEOUT_ENV] ?? '').trim();
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_IDLE_TIMEOUT_MS;
}

/** stdout の 1 行 (JSON 文字列) をそのまま受け取るハンドラ。
 *
 * JSON へのパースは呼び出し側が行う — 既存の行パーサ (parseStreamLine /
 * extractToolDetails) をそのまま使えるようにするため。 */
export type LineHandler = (line: string) => void;

export interface PersistentSessionOptions {
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly env: Record<string, string>;
  /** 使われなくなってから終了するまでの ms。 */
  readonly idleMs: number;
  /** テスト用の spawn 差し替え。 */
  readonly spawnFn?: typeof spawn;
  /** プロセスが死んだときの通知 (次回は作り直す)。 */
  readonly onExit?: (code: number | null) => void;
}

/**
 * 1 セッション = 1 プロセス。
 *
 * 「今このプロセスが生きているか」は**推測せず**実際の child の状態で持つ。
 */
export class PersistentSession {
  private child: ChildProcess | null = null;
  private buffer = '';
  private handlers: LineHandler[] = [];
  private idleTimer: NodeJS.Timeout | null = null;
  private stderrTail = '';
  /** GAP-241: ターン単位で「プロセスが死んだ」を知りたい側の購読。 */
  private exitHandlers: Array<(code: number | null) => void> = [];
  /** 実行中に投げ込まれた追い足しの本文 (画面へ返すため記録する)。 */
  readonly injected: string[] = [];

  constructor(private readonly opts: PersistentSessionOptions) {}

  get alive(): boolean {
    return (
      this.child !== null && this.child.exitCode === null && this.child.signalCode === null
    );
  }

  get pid(): number | undefined {
    return this.child?.pid;
  }

  get stderr(): string {
    return this.stderrTail.slice(-2000);
  }

  /** プロセスを立ち上げる (既に生きていれば何もしない)。 */
  start(): void {
    if (this.alive) return;
    const spawnFn = this.opts.spawnFn ?? spawn;
    const child = spawnFn(this.opts.command, [...this.opts.args], {
      stdio: ['pipe', 'pipe', 'pipe'],
      cwd: this.opts.cwd,
      env: this.opts.env,
    });
    this.child = child;
    this.buffer = '';
    child.stdout?.on('data', (chunk: Buffer) => this.consume(chunk.toString('utf8')));
    child.stderr?.on('data', (chunk: Buffer) => {
      this.stderrTail = (this.stderrTail + chunk.toString('utf8')).slice(-4000);
    });
    child.on('close', (code) => {
      this.child = null;
      this.clearIdleTimer();
      this.opts.onExit?.(code);
      this.notifyExit(code);
    });
    // spawn 自体の失敗 (claude 不在 / 実行権限なし) をここで受ける。
    // 受けないと unhandled 'error' でプロセスごと落ちる。
    child.on('error', () => {
      this.child = null;
      this.clearIdleTimer();
      this.opts.onExit?.(127);
      this.notifyExit(127);
    });
    this.touch();
  }

  /**
   * 指示を 1 通送る。**実行中でも送れる** (実 CLI で確認済み)。
   *
   * 送れなかった場合は false を返す — 「送ったつもり」を作らない。
   */
  send(text: string, options: { readonly asFollowUp?: boolean } = {}): boolean {
    if (!this.alive || this.child?.stdin === null || this.child?.stdin === undefined) {
      return false;
    }
    if (this.child.stdin.destroyed) return false;
    const payload = `${JSON.stringify({
      type: 'user',
      session_id: '',
      parent_tool_use_id: null,
      message: { role: 'user', content: text },
    })}\n`;
    const ok = this.child.stdin.write(payload);
    if (options.asFollowUp) this.injected.push(text);
    this.touch();
    return ok !== false;
  }

  /** stdout の行を受け取る購読を追加する (解除関数を返す)。 */
  onLine(handler: LineHandler): () => void {
    this.handlers.push(handler);
    return () => {
      this.handlers = this.handlers.filter((h) => h !== handler);
    };
  }

  /**
   * GAP-241: プロセス終了の購読 (解除関数を返す)。
   *
   * 実行中のターンは result 行でしか終われないため、result を出さずに
   * プロセスが死ぬと (root での `--dangerously-skip-permissions` 拒否など)
   * ターンがタイムアウトまで宙に浮く。終了を購読できれば、その場で失敗として
   * 返せる。
   */
  onExit(handler: (code: number | null) => void): () => void {
    this.exitHandlers.push(handler);
    return () => {
      this.exitHandlers = this.exitHandlers.filter((h) => h !== handler);
    };
  }

  private notifyExit(code: number | null): void {
    for (const handler of [...this.exitHandlers]) handler(code);
  }

  /** この PC 上の claude を**実際に**止める (GAP-189 と同じ二段構え)。 */
  kill(): void {
    const child = this.child;
    if (child === null) return;
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGTERM');
      setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      }, 2_000).unref?.();
    }
  }

  /** stdin を閉じて終了させる (正常終了)。 */
  close(): void {
    this.clearIdleTimer();
    const child = this.child;
    if (child === null) return;
    try {
      child.stdin?.end();
    } catch {
      /* すでに閉じている */
    }
    this.kill();
  }

  /** 制御メッセージ等をそのまま stdin へ書く (承認応答など)。 */
  writeRaw(payload: string): boolean {
    if (!this.alive) return false;
    const stdin = this.child?.stdin;
    if (stdin === null || stdin === undefined || stdin.destroyed) return false;
    const ok = stdin.write(payload);
    this.touch();
    return ok !== false;
  }

  private consume(text: string): void {
    this.buffer += text;
    const lines = this.buffer.split('\n');
    this.buffer = lines.pop() ?? '';
    for (const line of lines) {
      if (line.trim() === '') continue;
      this.touch();
      for (const handler of [...this.handlers]) handler(line);
    }
  }

  private touch(): void {
    this.clearIdleTimer();
    this.idleTimer = setTimeout(() => this.close(), this.opts.idleMs);
    this.idleTimer.unref?.();
  }

  private clearIdleTimer(): void {
    if (this.idleTimer !== null) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
  }
}

/**
 * セッション ID ごとに常駐プロセスを持つ台帳。
 *
 * 別スレッドの会話が混ざらないよう、**キーはセッション ID + 作業フォルダ**。
 */
export class PersistentSessionPool {
  private readonly sessions = new Map<string, PersistentSession>();

  /** 使い回せるものがあれば返し、無ければ作る。 */
  acquire(key: string, make: () => PersistentSession): PersistentSession {
    const existing = this.sessions.get(key);
    if (existing !== undefined && existing.alive) return existing;
    const created = make();
    this.sessions.set(key, created);
    return created;
  }

  /** 生きているセッション数 (常駐しすぎていないかの確認用)。 */
  get size(): number {
    let n = 0;
    for (const s of this.sessions.values()) if (s.alive) n += 1;
    return n;
  }

  drop(key: string): void {
    const s = this.sessions.get(key);
    s?.close();
    this.sessions.delete(key);
  }

  closeAll(): void {
    for (const key of [...this.sessions.keys()]) this.drop(key);
  }
}

/** セッション台帳のキー (会話が混ざらないように作業フォルダも含める)。 */
export function sessionKey(cwd: string, sessionId: string | null): string {
  return `${cwd}::${sessionId ?? 'no-session'}`;
}
