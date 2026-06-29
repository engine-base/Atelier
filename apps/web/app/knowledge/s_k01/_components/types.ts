/**
 * S-K01 ナレッジエクスプローラ — 共有型 (T-UC-43 / F-023・F-024)
 *
 * API (`GET /knowledge` の Knowledge schema) のうち、UI が必要とするフィールドだけを
 * 切り出したビュー型。生成 openapi.ts はハンドエディット禁止のため、ここでは表示に使う
 * フィールドのみを明示的に定義して narrow する。
 */

export type KnowledgeScope = "common" | "employee_specific" | "project";

/** API の Knowledge ノードのうち UI が参照するフィールド。 */
export interface KnowledgeNode {
  readonly id: string;
  readonly account_id: string;
  readonly account_type: string;
  readonly scope: KnowledgeScope;
  readonly parent_id?: string | null;
  readonly visible_in_tree?: boolean;
  readonly category: string;
  readonly title: string;
  readonly content_md: string;
  readonly tags: readonly string[];
  readonly source_project_id?: string | null;
  readonly owner_employee_id?: string | null;
  readonly confidence_score?: number;
  readonly usage_count?: number;
  readonly updated_at?: string;
}

/** scope タブの定義。順序は共通 → AI社員別 → プロジェクト別 (モック準拠)。 */
export const SCOPES: readonly {
  readonly id: KnowledgeScope;
  readonly label: string;
}[] = [
  { id: "common", label: "共通" },
  { id: "employee_specific", label: "AI社員別" },
  { id: "project", label: "プロジェクト別" },
] as const;
