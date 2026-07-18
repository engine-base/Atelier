/**
 * Atelier の標準 9 工程（canonical）。
 *
 * ダッシュボード(S-B02)の「工程の流れ（9 工程）」と 工程ワークフロー画面(S-F01) が
 * 別々に工程を描いていたため不整合(ダッシュ=9工程表示 / 工程画面=「未登録」)が出ていた。
 * ここに一本化し、両画面が同じ工程・同じ現在地判定を使うことで表示を一致させる。
 */

export interface CanonicalPhase {
  readonly key: string;
  readonly label: string;
}

export const CANONICAL_PHASES: readonly CanonicalPhase[] = [
  { key: "hearing", label: "ヒアリング" },
  { key: "requirements", label: "要件定義" },
  { key: "architecture", label: "アーキ設計" },
  { key: "design", label: "デザイン" },
  { key: "breakdown", label: "機能分解" },
  { key: "tasks", label: "タスク分解" },
  { key: "implementation", label: "実装" },
  { key: "verification", label: "検証" },
  { key: "delivery", label: "納品" },
];

/** current_phase の index（不明時は 0=ヒアリング）。 */
export function currentPhaseIndex(currentPhaseKey: string | undefined): number {
  return Math.max(
    0,
    CANONICAL_PHASES.findIndex((p) => p.key === currentPhaseKey),
  );
}

/** index の工程が current より前=done / 一致=in_progress / 後=pending。 */
export function phaseStatusByCurrent(
  index: number,
  currentPhaseKey: string | undefined,
): "done" | "in_progress" | "pending" {
  const currentIdx = currentPhaseIndex(currentPhaseKey);
  if (index < currentIdx) return "done";
  if (index === currentIdx) return "in_progress";
  return "pending";
}
