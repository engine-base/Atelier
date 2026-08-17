/**
 * S-T03 AI 社員テンプレ — T-UC-32 / GAP-031⑤ (T-A-42 scope expand)
 *
 * モック admin/S-T03-templates.html の 2 ペイン構成:
 *   - 左「テンプレ一覧ペイン」(tpl-list-pane) = TemplateList
 *   - 右「エディタペイン」= TemplateEditor (基本情報 / System Prompt / specialty /
 *     デフォルト装着スキル / デフォルトナレッジカテゴリ / 保存して全 WS 反映)
 * 複製・バージョン履歴の復元・テンプレ新規追加はモックにあるが本 scope 外
 * (tickets.json T-A-42 note に別途起票の記録あり) — 死にボタンを出さない。
 */

"use client";

import * as React from "react";

export interface Template {
  readonly id: string;
  readonly name: string;
  readonly role: string;
  readonly description: string;
}

export interface TemplateListProps {
  readonly templates: readonly Template[];
  /** 複製/編集/削除。いずれも未指定なら「アクション」を出さない（read-only 時など）。 */
  readonly onClone?: (id: string) => void;
  readonly onEdit?: (id: string) => void;
  readonly onDelete?: (id: string) => void;
  /** 選択中テンプレ (エディタ連動時)。onSelect 指定で行が選択可能になる。 */
  readonly selectedId?: string | null;
  readonly onSelect?: (id: string) => void;
}

export function TemplateList({
  templates,
  onClone,
  onEdit,
  onDelete,
  selectedId,
  onSelect,
}: TemplateListProps) {
  const hasActions = Boolean(onClone || onEdit || onDelete);

  return (
    <section
      aria-label="AI 社員テンプレ一覧"
      className="overflow-hidden rounded-lg border border-border bg-white"
    >
      <header className="flex items-center justify-between border-b border-border px-5 py-3.5">
        <div>
          <p className="text-[11px] font-bold uppercase tracking-[0.14em] text-on-surface-variant">
            Default Templates
          </p>
          <strong className="text-sm font-bold text-on-surface">
            {templates.length} 名のテンプレ
          </strong>
        </div>
      </header>

      {templates.length === 0 ? (
        <p className="py-12 text-center text-body-md text-on-surface-variant">
          テンプレがありません
        </p>
      ) : (
        <ul className="divide-y divide-border">
          {templates.map((t) => (
            <li
              key={t.id}
              className={`flex items-center gap-3 px-5 py-3.5 transition-colors hover:bg-surface-variant ${
                selectedId === t.id ? "bg-primary-container/40" : ""
              }`}
            >
              <span
                aria-hidden="true"
                className="inline-flex h-12 w-12 shrink-0 items-center justify-center rounded-full bg-primary-container text-lg font-bold text-on-primary-container"
              >
                {t.name.charAt(0)}
              </span>

              <div className="min-w-0 flex-1">
                {onSelect ? (
                  <button
                    type="button"
                    onClick={() => onSelect(t.id)}
                    aria-current={selectedId === t.id ? "true" : undefined}
                    className="block w-full truncate text-left text-sm font-bold text-on-surface hover:text-primary"
                  >
                    {t.name}
                  </button>
                ) : (
                  <p className="truncate text-sm font-bold text-on-surface">
                    {t.name}
                  </p>
                )}
                {t.description ? (
                  <p className="truncate text-[11px] text-on-surface-variant">
                    {t.description}
                  </p>
                ) : null}
                <p className="mt-0.5 truncate text-[11px] font-semibold text-primary">
                  {t.role}
                </p>
              </div>

              {hasActions ? (
                <div className="flex shrink-0 items-center gap-2">
                  {onClone ? (
                    <button
                      type="button"
                      onClick={() => onClone(t.id)}
                      aria-label={`${t.name} を複製`}
                      className="inline-flex h-8 items-center rounded-md border border-primary px-3 text-label-md font-semibold text-primary transition-colors hover:bg-primary-container"
                    >
                      複製
                    </button>
                  ) : null}
                  {onEdit ? (
                    <button
                      type="button"
                      onClick={() => onEdit(t.id)}
                      aria-label={`${t.name} を編集`}
                      className="inline-flex h-8 items-center rounded-md bg-primary px-3 text-label-md font-semibold text-on-primary transition-colors hover:bg-primary-hover"
                    >
                      編集
                    </button>
                  ) : null}
                  {onDelete ? (
                    <button
                      type="button"
                      onClick={() => onDelete(t.id)}
                      aria-label={`${t.name} を削除`}
                      className="inline-flex h-8 items-center rounded-md border border-error px-3 text-label-md font-semibold text-error transition-colors hover:bg-[#FEE2E2]"
                    >
                      ×
                    </button>
                  ) : null}
                </div>
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

// --------------------------------------------------------------------------- //
// GAP-031⑤: エディタペイン (モック右側)。PATCH /admin/ai-employee-templates/{id}
// — 保存で version 自動 increment + ai_employees.template_id 参照経由で全 WS 反映。
// --------------------------------------------------------------------------- //

export const DEPARTMENT_LABEL: Readonly<Record<string, string>> = {
  executive: "経営",
  sales: "営業・契約部",
  product: "プロダクト企画部",
  architecture: "設計部",
  design: "デザイン部",
  dev_qa: "開発・検証部",
  cross_functional: "全社横断",
};

export const ROLE_LABEL: Readonly<Record<string, string>> = {
  coo: "COO",
  lead: "部長（lead）",
  member: "メンバー（member）",
};

export interface TemplateEditorTemplate {
  readonly id: string;
  readonly defaultName: string;
  readonly displayName: string;
  readonly department: string;
  readonly role: string;
  readonly systemPrompt: string;
  readonly specialty: string;
  readonly version: number;
  readonly skills: readonly string[];
  readonly knowledgeCats: readonly string[];
}

export interface SkillOption {
  readonly id: string;
  readonly label: string;
}

export interface TemplateEditorPatch {
  readonly default_display_name?: string;
  readonly department?: string;
  readonly role?: string;
  readonly system_prompt?: string;
  readonly specialty?: string;
  readonly default_skills?: readonly string[];
  readonly default_knowledge_cats?: readonly string[];
}

export interface TemplateEditorProps {
  readonly template: TemplateEditorTemplate;
  /** 実在スキル (/admin/skills)。pills のラベル解決と「スキル追加」候補に使う。 */
  readonly availableSkills: readonly SkillOption[];
  /** 実展開先 (ai_employees.template_id 参照の実カウント)。未取得なら null。 */
  readonly deployment: {
    readonly workspaceCount: number;
    readonly employeeCount: number;
  } | null;
  readonly saving: boolean;
  readonly actionNotice: string | null;
  readonly actionError: string | null;
  /** 変更フィールドのみの部分更新 patch を渡す。 */
  readonly onSave: (patch: TemplateEditorPatch) => void;
}

const fieldLabelCls =
  "flex items-center gap-2 text-[11px] font-bold uppercase tracking-[0.12em] text-on-surface-variant";
const adminOnlyBadge = (
  <span className="rounded bg-[#FEF3C7] px-1.5 py-0.5 text-[10px] font-bold text-[#92400E]">
    ADMIN ONLY
  </span>
);

export function TemplateEditor({
  template,
  availableSkills,
  deployment,
  saving,
  actionNotice,
  actionError,
  onSave,
}: TemplateEditorProps) {
  const [displayName, setDisplayName] = React.useState(template.displayName);
  const [department, setDepartment] = React.useState(template.department);
  const [role, setRole] = React.useState(template.role);
  const [systemPrompt, setSystemPrompt] = React.useState(template.systemPrompt);
  const [specialty, setSpecialty] = React.useState(template.specialty);
  const [skills, setSkills] = React.useState<readonly string[]>(template.skills);
  const [cats, setCats] = React.useState<readonly string[]>(
    template.knowledgeCats,
  );
  const [skillToAdd, setSkillToAdd] = React.useState("");
  const [catToAdd, setCatToAdd] = React.useState("");
  const [localError, setLocalError] = React.useState<string | null>(null);

  const skillLabel = React.useMemo(() => {
    const m = new Map(availableSkills.map((s) => [s.id, s.label]));
    return (id: string) => m.get(id) ?? `${id.slice(0, 8)}…（未登録スキル）`;
  }, [availableSkills]);

  const addableSkills = availableSkills.filter((s) => !skills.includes(s.id));

  const buildPatch = (): TemplateEditorPatch => {
    const patch: {
      default_display_name?: string;
      department?: string;
      role?: string;
      system_prompt?: string;
      specialty?: string;
      default_skills?: readonly string[];
      default_knowledge_cats?: readonly string[];
    } = {};
    if (displayName !== template.displayName) {
      patch.default_display_name = displayName;
    }
    if (department !== template.department) patch.department = department;
    if (role !== template.role) patch.role = role;
    if (systemPrompt !== template.systemPrompt) {
      patch.system_prompt = systemPrompt;
    }
    if (specialty !== template.specialty) patch.specialty = specialty;
    if (JSON.stringify(skills) !== JSON.stringify(template.skills)) {
      patch.default_skills = skills;
    }
    if (JSON.stringify(cats) !== JSON.stringify(template.knowledgeCats)) {
      patch.default_knowledge_cats = cats;
    }
    return patch;
  };

  const handleSave = () => {
    setLocalError(null);
    if (!displayName.trim()) {
      setLocalError("表示名を入力してください。");
      return;
    }
    if (!systemPrompt.trim()) {
      setLocalError("System Prompt を入力してください。");
      return;
    }
    const patch = buildPatch();
    if (Object.keys(patch).length === 0) {
      setLocalError("変更がありません。");
      return;
    }
    onSave(patch);
  };

  return (
    <section
      aria-label={`テンプレ編集: ${template.displayName}`}
      className="overflow-hidden rounded-lg border border-border bg-white"
    >
      <header className="flex flex-wrap items-center justify-between gap-3 border-b border-border px-5 py-4">
        <div className="min-w-0">
          <h2 className="truncate text-base font-bold text-on-surface">
            {template.displayName}
            <span className="ml-2 rounded bg-surface-variant px-1.5 py-0.5 text-[11px] font-semibold text-on-surface-variant">
              v{template.version}
            </span>
          </h2>
          <p className="mt-0.5 text-[12px] text-on-surface-variant">
            {DEPARTMENT_LABEL[template.department] ?? template.department} ·{" "}
            {ROLE_LABEL[template.role] ?? template.role}
            {deployment ? (
              <span className="ml-2 font-semibold text-primary">
                展開先：{deployment.workspaceCount} WS（自動同期）
              </span>
            ) : null}
          </p>
        </div>
        <button
          type="button"
          onClick={handleSave}
          disabled={saving}
          className="inline-flex h-9 items-center rounded-md bg-primary px-4 text-label-md font-semibold text-on-primary transition-colors hover:bg-primary-hover disabled:opacity-50"
        >
          {saving ? "保存中…" : "保存して全 WS 反映"}
        </button>
      </header>

      <div className="space-y-5 px-5 py-4">
        {actionNotice ? (
          <p
            role="status"
            className="rounded-md bg-primary-container px-3 py-2 text-body-sm text-on-primary-container"
          >
            {actionNotice}
          </p>
        ) : null}
        {actionError || localError ? (
          <p
            role="alert"
            className="rounded-md bg-[#FEE2E2] px-3 py-2 text-body-sm text-error"
          >
            {actionError ?? localError}
          </p>
        ) : null}

        {deployment ? (
          <p className="rounded-md border border-border bg-surface-variant px-3 py-2 text-[12px] text-on-surface-variant">
            注意：テンプレを保存すると、{deployment.workspaceCount}{" "}
            ワークスペースの {deployment.employeeCount}{" "}
            体に次回利用時から適用されます。ユーザーが個別カスタムしている表示名・アイコン・口調は保持されます。
          </p>
        ) : null}

        <fieldset className="space-y-3">
          <legend className="text-sm font-bold text-on-surface">
            基本情報
          </legend>
          <div className="grid gap-3 sm:grid-cols-2">
            <div>
              <span className={fieldLabelCls}>内部名（変更不可）</span>
              <p className="mt-1 rounded-md border border-border bg-surface-variant px-3 py-2 font-mono text-body-sm text-on-surface-variant">
                {template.defaultName}
              </p>
            </div>
            <label className="block">
              <span className={fieldLabelCls}>デフォルト表示名</span>
              <input
                type="text"
                value={displayName}
                onChange={(e) => setDisplayName(e.target.value)}
                className="mt-1 w-full rounded-md border border-border px-3 py-2 text-body-md text-on-surface"
              />
            </label>
            <label className="block">
              <span className={fieldLabelCls}>部署</span>
              <select
                value={department}
                onChange={(e) => setDepartment(e.target.value)}
                className="mt-1 w-full rounded-md border border-border bg-white px-3 py-2 text-body-md text-on-surface"
              >
                {Object.entries(DEPARTMENT_LABEL).map(([value, label]) => (
                  <option key={value} value={value}>
                    {label}
                  </option>
                ))}
              </select>
            </label>
            <label className="block">
              <span className={fieldLabelCls}>役職</span>
              <select
                value={role}
                onChange={(e) => setRole(e.target.value)}
                className="mt-1 w-full rounded-md border border-border bg-white px-3 py-2 text-body-md text-on-surface"
              >
                {Object.entries(ROLE_LABEL).map(([value, label]) => (
                  <option key={value} value={value}>
                    {label}
                  </option>
                ))}
              </select>
            </label>
          </div>
        </fieldset>

        <label className="block">
          <span className={fieldLabelCls}>System Prompt {adminOnlyBadge}</span>
          <textarea
            value={systemPrompt}
            onChange={(e) => setSystemPrompt(e.target.value)}
            rows={10}
            className="mt-1 w-full rounded-md border border-border px-3 py-2 font-mono text-[12px] leading-relaxed text-on-surface"
          />
        </label>

        <label className="block">
          <span className={fieldLabelCls}>
            専門領域（specialty） {adminOnlyBadge}
          </span>
          <input
            type="text"
            value={specialty}
            onChange={(e) => setSpecialty(e.target.value)}
            className="mt-1 w-full rounded-md border border-border px-3 py-2 text-body-md text-on-surface"
          />
        </label>

        <div>
          <span className={fieldLabelCls}>
            デフォルト装着スキル（{skills.length}） {adminOnlyBadge}
          </span>
          <ul className="mt-2 flex flex-wrap gap-2">
            {skills.length === 0 ? (
              <li className="text-body-sm text-on-surface-variant">
                装着スキルなし
              </li>
            ) : (
              skills.map((id) => (
                <li
                  key={id}
                  className="inline-flex items-center gap-1.5 rounded-full border border-border bg-surface-variant px-3 py-1 text-[12px] font-semibold text-on-surface"
                >
                  {skillLabel(id)}
                  <button
                    type="button"
                    onClick={() => setSkills(skills.filter((s) => s !== id))}
                    aria-label={`スキル ${skillLabel(id)} を外す`}
                    className="text-on-surface-variant hover:text-error"
                  >
                    ×
                  </button>
                </li>
              ))
            )}
          </ul>
          <div className="mt-2 flex items-center gap-2">
            <label className="sr-only" htmlFor="tpl-skill-to-add">
              追加するスキル
            </label>
            <select
              id="tpl-skill-to-add"
              value={skillToAdd}
              onChange={(e) => setSkillToAdd(e.target.value)}
              className="rounded-md border border-border bg-white px-3 py-1.5 text-body-sm text-on-surface"
            >
              <option value="">スキルを選択…</option>
              {addableSkills.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.label}
                </option>
              ))}
            </select>
            <button
              type="button"
              disabled={!skillToAdd}
              onClick={() => {
                if (skillToAdd) {
                  setSkills([...skills, skillToAdd]);
                  setSkillToAdd("");
                }
              }}
              className="inline-flex h-8 items-center rounded-md border border-dashed border-primary px-3 text-label-md font-semibold text-primary transition-colors hover:bg-primary-container disabled:opacity-50"
            >
              スキル追加
            </button>
          </div>
        </div>

        <div>
          <span className={fieldLabelCls}>
            デフォルトナレッジカテゴリ {adminOnlyBadge}
          </span>
          <ul className="mt-2 flex flex-wrap gap-2">
            {cats.length === 0 ? (
              <li className="text-body-sm text-on-surface-variant">
                カテゴリなし
              </li>
            ) : (
              cats.map((c) => (
                <li
                  key={c}
                  className="inline-flex items-center gap-1.5 rounded-full border border-border bg-surface-variant px-3 py-1 text-[12px] font-semibold text-on-surface"
                >
                  {c}
                  <button
                    type="button"
                    onClick={() => setCats(cats.filter((x) => x !== c))}
                    aria-label={`カテゴリ ${c} を外す`}
                    className="text-on-surface-variant hover:text-error"
                  >
                    ×
                  </button>
                </li>
              ))
            )}
          </ul>
          <div className="mt-2 flex items-center gap-2">
            <label className="sr-only" htmlFor="tpl-cat-to-add">
              追加するカテゴリ名
            </label>
            <input
              id="tpl-cat-to-add"
              type="text"
              value={catToAdd}
              onChange={(e) => setCatToAdd(e.target.value)}
              placeholder="カテゴリ名"
              className="w-48 rounded-md border border-border px-3 py-1.5 text-body-sm text-on-surface"
            />
            <button
              type="button"
              disabled={!catToAdd.trim() || cats.includes(catToAdd.trim())}
              onClick={() => {
                const v = catToAdd.trim();
                if (v && !cats.includes(v)) {
                  setCats([...cats, v]);
                  setCatToAdd("");
                }
              }}
              className="inline-flex h-8 items-center rounded-md border border-dashed border-primary px-3 text-label-md font-semibold text-primary transition-colors hover:bg-primary-container disabled:opacity-50"
            >
              カテゴリ追加
            </button>
          </div>
        </div>
      </div>
    </section>
  );
}
