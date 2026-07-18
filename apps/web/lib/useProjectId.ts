/**
 * 現在のプロジェクト id 解決フック。
 *
 * project-scoped 画面(タスク/工程/議事録 等)は従来 `?project=` のみを見ており、
 * サイドバー nav は静的 href(project 無し)だったため、プロジェクトを開いた後に
 * nav で移動すると project が失われ「プロジェクトを選択」で行き止まりになっていた。
 *
 * このフックは `?project=` を最優先し、あれば localStorage に永続化する
 * (以後の nav 遷移で最後に開いたプロジェクトを保持)。URL に無ければ永続値へ
 * フォールバックする。ワークスペースの atelier_current_workspace と同じ方式。
 */

"use client";

import { useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";

export const CURRENT_PROJECT_KEY = "atelier_current_project";

export function readCurrentProject(): string | null {
  if (typeof window === "undefined") return null;
  return window.localStorage.getItem(CURRENT_PROJECT_KEY);
}

export function writeCurrentProject(id: string): void {
  if (typeof window !== "undefined") {
    window.localStorage.setItem(CURRENT_PROJECT_KEY, id);
  }
}

export function useProjectId(): string | null {
  const params = useSearchParams();
  const fromUrl = params.get("project");
  // 初期は URL 値(SSR と一致)。mount 後に localStorage を反映してハイドレーション不整合を避ける。
  const [id, setId] = useState<string | null>(fromUrl);

  useEffect(() => {
    if (fromUrl) {
      writeCurrentProject(fromUrl);
      setId(fromUrl);
    } else {
      setId(readCurrentProject());
    }
  }, [fromUrl]);

  return id;
}
