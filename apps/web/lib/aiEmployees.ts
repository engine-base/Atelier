/**
 * AI 社員の表示ヘルパー (S-E01 / S-F01 共用)。
 *
 * カラーはモック 06_mockups/_shared/atelier.css の .avatar-* に準拠。
 * role/department は ai_employees テーブルの値 → 表示ラベルへの変換。
 */

/** モック atelier.css .avatar-* の社員カラー (name = 英字社員名)。 */
export const EMPLOYEE_COLORS: Record<string, string> = {
  tony: "#DC2626",
  natasha: "#7C3AED",
  steve: "#1E40AF",
  peter: "#DC2626",
  strange: "#C7A04A",
  wanda: "#BE185D",
  thor: "#0891B2",
  vision: "#16A34A",
  tchalla: "#1F2937",
  jarvis: "#2563EB",
};

export interface EmployeeLike {
  readonly id: string;
  readonly name?: string;
  readonly display_name?: string;
  readonly role?: string;
  readonly department?: string;
}

export function employeeName(e: EmployeeLike | undefined): string | undefined {
  return e?.display_name ?? e?.name;
}

export function employeeColor(e: EmployeeLike | undefined): string {
  return (e?.name ? EMPLOYEE_COLORS[e.name] : undefined) ?? "#2563EB";
}

const ROLE_LABELS: Record<string, string> = {
  coo: "COO",
  lead: "部長",
  member: "メンバー",
};

const DEPARTMENT_LABELS: Record<string, string> = {
  management: "経営企画部",
  product: "プロダクト企画部",
  sales: "営業部",
  engineering: "開発部",
  db: "データ基盤部",
  design: "デザイン部",
  qa: "品質保証部",
  knowledge: "ナレッジ部",
  minutes: "議事録部",
};

/** 「プロダクト企画部 部長」のような肩書きラベル。不明フィールドはそのまま出す。 */
export function employeeTitle(e: EmployeeLike | undefined): string | undefined {
  if (!e) return undefined;
  const dept = e.department ? (DEPARTMENT_LABELS[e.department] ?? e.department) : undefined;
  const role = e.role ? (ROLE_LABELS[e.role] ?? e.role) : undefined;
  const parts = [dept, role].filter(Boolean);
  return parts.length > 0 ? parts.join(" ") : undefined;
}
