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
