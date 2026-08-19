/**
 * GAP-157: 表示フェーズのグローバル切替 (ヘッダーのフェーズスイッチャーが正本)。
 *
 * 経営者指示「フェーズはヘッダーで画面全体を切り替える。各タブの細々な
 * ところでやらない」— 選択はプロジェクト単位で localStorage に永続し、
 * カスタムイベントで全タブ (進行 / モック / タスク …) が同期する。
 * 値 = delivery_phase_id、null = 現在 (active) フェーズ。
 */

"use client";

import { useEffect, useState } from "react";

const KEY_PREFIX = "atelier_phase_sel_";
export const PHASE_CHANGED_EVENT = "atelier-phase-changed";

export function readSelectedPhase(projectId: string): string | null {
  if (typeof window === "undefined") return null;
  return window.localStorage.getItem(KEY_PREFIX + projectId);
}

export function writeSelectedPhase(projectId: string, phaseId: string | null): void {
  if (typeof window === "undefined") return;
  if (phaseId === null) window.localStorage.removeItem(KEY_PREFIX + projectId);
  else window.localStorage.setItem(KEY_PREFIX + projectId, phaseId);
  window.dispatchEvent(
    new CustomEvent(PHASE_CHANGED_EVENT, { detail: { projectId, phaseId } }),
  );
}

/** 表示フェーズ (null = 現在フェーズ)。ヘッダーでの切替に全タブが追従する。 */
export function useSelectedPhase(projectId: string | null | undefined): string | null {
  const [phaseId, setPhaseId] = useState<string | null>(null);
  useEffect(() => {
    if (!projectId) {
      setPhaseId(null);
      return;
    }
    setPhaseId(readSelectedPhase(projectId));
    const onChange = (ev: Event) => {
      const d = (ev as CustomEvent).detail as
        | { projectId?: string; phaseId?: string | null }
        | undefined;
      if (d?.projectId === projectId) setPhaseId(d.phaseId ?? null);
    };
    window.addEventListener(PHASE_CHANGED_EVENT, onChange);
    return () => window.removeEventListener(PHASE_CHANGED_EVENT, onChange);
  }, [projectId]);
  return phaseId;
}
