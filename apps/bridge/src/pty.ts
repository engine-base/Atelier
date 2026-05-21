/**
 * Atelier Bridge — PTY セッション層（基盤雛形）
 *
 * Vibeyard の node-pty / xterm.js 層を fork して使う。このファイルは
 * 型定義と空骨格のみ。実体は Vibeyard 取込後に置き換える。
 */

export interface PtySpawnOptions {
  readonly command: string; // e.g. 'claude'
  readonly args: readonly string[];
  readonly cwd: string; // worktree path
  readonly env: Readonly<Record<string, string>>;
  readonly cols?: number;
  readonly rows?: number;
}

export interface PtySession {
  readonly pid: number;
  readonly options: PtySpawnOptions;
  write(data: string): void;
  onData(handler: (data: string) => void): () => void;
  onExit(handler: (code: number, signal: string | null) => void): () => void;
  resize(cols: number, rows: number): void;
  kill(signal?: string): Promise<void>;
}

/**
 * PtySession を生成する factory。Vibeyard 取込後に node-pty.spawn を呼ぶ実装に
 * 置き換える。現状は型と契約のみ。
 */
export function spawnPty(_options: PtySpawnOptions): PtySession {
  throw new Error('not implemented — pending Vibeyard fork import');
}
