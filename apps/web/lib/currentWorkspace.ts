/**
 * 現在ワークスペースの永続化 — T-UC-38 と TopBar ピッカーで共有する正本。
 *
 * useProjectId (atelier_current_project) と同じ方式: localStorage 永続 +
 * 未選択時は呼び出し側が一覧の先頭へフォールバックする。
 */

export const CURRENT_WS_KEY = "atelier_current_workspace";

export function readCurrentWorkspace(): string | undefined {
  if (typeof window === "undefined") return undefined;
  return window.localStorage.getItem(CURRENT_WS_KEY) ?? undefined;
}

export function writeCurrentWorkspace(id: string): void {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(CURRENT_WS_KEY, id);
}

/**
 * GAP-207: 「ワークスペースの一覧が変わった」を画面全体へ知らせる。
 *
 * シェル (ConditionalAppShell) は起動時に 1 回しか `/workspaces` を読まない。
 * そのため **最初のワークスペースを作った直後**、シェルはまだ「0 件」のままで、
 * サイドバーもワークスペース名も再読み込みするまで更新されなかった
 * (GAP-207 の実ブラウザ e2e で発見)。作った側がこれを呼ぶ。
 */
export const WORKSPACES_CHANGED_EVENT = "atelier:workspaces-changed";

export function notifyWorkspacesChanged(): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new Event(WORKSPACES_CHANGED_EVENT));
}
