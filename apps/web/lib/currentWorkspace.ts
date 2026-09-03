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
  const before = window.localStorage.getItem(CURRENT_WS_KEY);
  window.localStorage.setItem(CURRENT_WS_KEY, id);
  // GAP-271 (通し J15-05): 切り替えた瞬間に「現在案件」を旧 WS のまま残さない。
  // 一覧 (S-B01) も切替を受けて現在 WS で読み直す。
  if (before !== id) {
    window.localStorage.removeItem(CURRENT_PROJECT_STORAGE_KEY);
    window.dispatchEvent(new Event(WORKSPACE_SWITCHED_EVENT));
  }
}

/** useProjectId と同じ永続キー (循環 import を避けるためここに複製)。 */
const CURRENT_PROJECT_STORAGE_KEY = "atelier_current_project";

/** GAP-271: 現在ワークスペースが切り替わった (一覧・ヘッダーが読み直す)。 */
export const WORKSPACE_SWITCHED_EVENT = "atelier:workspace-switched";

/**
 * GAP-270 (通し J15-03): 表示名を保存した直後にヘッダーへ反映する。
 * シェルは起動時に 1 回しか `/me` を読まないので、保存側がこれを呼ぶ。
 */
export const ME_CHANGED_EVENT = "atelier:me-changed";

export function notifyMeChanged(): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new Event(ME_CHANGED_EVENT));
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
