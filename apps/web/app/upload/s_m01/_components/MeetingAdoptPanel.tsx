/**
 * GAP-186 — 議事録の抽出項目を「確認して採用」→ 要件・タスク・決定へ反映する。
 *
 * 経営者指示「1,2 だね」の ①。
 *
 * **自動反映はしない。** AI の抽出をそのまま正にすると、聞き間違い・言い過ぎが
 * そのままプロジェクトの要件として固定される。ここは「提案 → 人がチェック →
 * 確定」の場で、チェックを入れて押したものだけが実データになる。
 *
 * 各項目に**文字起こしからの引用**を添えてあるので、採用する前に
 * 「本当にそう言っていたか」を照合できる。
 */

"use client";

import * as React from "react";
import { useCallback, useEffect, useMemo, useState } from "react";

import {
  adoptItems as adoptItemsDefault,
  fetchAdoptable as fetchAdoptableDefault,
  type AdoptableItem,
  type AdoptKind,
} from "./meeting-adopt";

/** 種別ごとの見出しと、反映先の説明 (どこへ行くのかを隠さない)。 */
const GROUPS: readonly {
  kind: AdoptKind;
  title: string;
  destination: string;
  empty: string;
}[] = [
  {
    kind: "requirement",
    title: "抽出要件",
    destination: "タスクとして追加されます",
    empty: "採用できる要件はありません",
  },
  {
    kind: "action",
    title: "アクション",
    destination: "タスクとして追加されます",
    empty: "採用できるアクションはありません",
  },
  {
    kind: "decision",
    title: "決定したこと",
    destination: "決定として記録されます",
    empty: "採用できる決定事項はありません",
  },
  {
    kind: "open_question",
    title: "未決事項",
    destination: "未決の決定として記録されます",
    empty: "採用できる未決事項はありません",
  },
];

const META_LABEL: Record<string, string> = {
  priority: "優先度",
  kind: "種類",
  owner: "担当",
  due: "期限",
  decided_by: "決めた人",
};

const VALUE_LABEL: Record<string, string> = {
  must: "必須",
  should: "推奨",
  could: "任意",
  functional: "機能",
  non_functional: "非機能",
  constraint: "制約",
};

function targetHref(item: AdoptableItem, projectId?: string): string | null {
  if (!item.target_id) return null;
  if (item.target_type === "task") {
    return `/tasks?task=${encodeURIComponent(item.target_id)}`;
  }
  return projectId
    ? `/decisions?project=${encodeURIComponent(projectId)}`
    : "/decisions";
}

export interface MeetingAdoptPanelProps {
  readonly meetingId: string;
  /** 決定一覧へのリンクに使う (未指定でも動く)。 */
  readonly projectId?: string;
  /** 反映が起きたときの通知 (親がトーストを出す)。 */
  readonly onAdopted?: (message: string) => void;
  /** 注入用 (省略時は実 API)。 */
  readonly fetchAdoptableFn?: typeof fetchAdoptableDefault;
  readonly adoptItemsFn?: typeof adoptItemsDefault;
}

export function MeetingAdoptPanel({
  meetingId,
  projectId,
  onAdopted,
  fetchAdoptableFn = fetchAdoptableDefault,
  adoptItemsFn = adoptItemsDefault,
}: MeetingAdoptPanelProps) {
  const [items, setItems] = useState<readonly AdoptableItem[]>([]);
  const [checked, setChecked] = useState<ReadonlySet<string>>(new Set());
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const reload = useCallback(async () => {
    setLoading(true);
    try {
      setItems(await fetchAdoptableFn(meetingId));
      setError(null);
    } catch {
      // 解析がまだ無い議事録などはここに来る。行き止まりにせず理由を出す。
      setError("採用できる項目を取得できませんでした。解析が完了しているか確認してください。");
    } finally {
      setLoading(false);
    }
  }, [fetchAdoptableFn, meetingId]);

  useEffect(() => {
    setChecked(new Set());
    void reload();
  }, [reload]);

  const pending = useMemo(() => items.filter((i) => !i.adopted), [items]);
  const selected = useMemo(
    () => pending.filter((i) => checked.has(i.key)),
    [pending, checked],
  );

  const toggle = (key: string): void => {
    setChecked((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const toggleAll = (): void => {
    setChecked((prev) =>
      prev.size === pending.length ? new Set() : new Set(pending.map((i) => i.key)),
    );
  };

  const submit = (): void => {
    if (selected.length === 0) return;
    setSaving(true);
    setNotice(null);
    adoptItemsFn(
      meetingId,
      selected.map((i) => i.key),
    )
      .then(async (result) => {
        setNotice(result.message);
        onAdopted?.(result.message);
        setChecked(new Set());
        await reload();
      })
      .catch(() => setError("反映できませんでした。時間をおいて再試行してください。"))
      .finally(() => setSaving(false));
  };

  if (loading) {
    return (
      <p className="text-[12px] text-on-surface-variant">採用できる項目を確認しています…</p>
    );
  }

  if (error) {
    return (
      <p role="alert" className="text-[12px] font-semibold text-error">
        {error}
      </p>
    );
  }

  if (items.length === 0) {
    return (
      <p className="text-[12px] text-on-surface-variant">
        この議事録に、要件・タスク・決定として残せる項目はありませんでした。
      </p>
    );
  }

  return (
    <section
      aria-label="議事録からの反映"
      className="flex flex-col gap-3 rounded-md border border-border p-4"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h3 className="text-[11px] font-bold uppercase tracking-[0.08em] text-on-surface-variant">
            要件・タスクへ反映
          </h3>
          <p className="mt-1 text-[11.5px] text-on-surface-variant">
            チェックした項目だけが反映されます（自動では反映しません）。引用を見て、
            言っていない内容が混ざっていないか確認してから採用してください。
          </p>
        </div>
        {pending.length > 0 ? (
          <button
            type="button"
            onClick={toggleAll}
            className="shrink-0 rounded-md border border-border bg-white px-2.5 py-1 text-[11.5px] font-semibold text-on-surface hover:bg-surface-variant"
          >
            {checked.size === pending.length ? "すべて外す" : "すべて選ぶ"}
          </button>
        ) : null}
      </div>

      {notice ? (
        <p role="status" className="text-[12px] font-semibold text-on-surface">
          {notice}
        </p>
      ) : null}

      {GROUPS.map((group) => {
        const rows = items.filter((i) => i.kind === group.kind);
        return (
          <div key={group.kind}>
            <h4 className="flex flex-wrap items-baseline gap-2 text-[12px] font-bold text-on-surface">
              {group.title}
              <span className="text-[11px] font-normal text-on-surface-variant">
                {group.destination}
              </span>
            </h4>
            {rows.length === 0 ? (
              <p className="mt-1 text-[11.5px] text-on-surface-variant">{group.empty}</p>
            ) : (
              <ul className="mt-1 flex flex-col gap-2">
                {rows.map((item) => {
                  const href = targetHref(item, projectId);
                  return (
                    <li key={item.key} className="flex items-start gap-2">
                      {item.adopted ? (
                        <span
                          aria-hidden
                          className="mt-[3px] inline-block h-3.5 w-3.5 shrink-0 rounded-sm bg-surface-variant"
                        />
                      ) : (
                        <input
                          type="checkbox"
                          id={`adopt-${item.key}`}
                          checked={checked.has(item.key)}
                          onChange={() => toggle(item.key)}
                          className="mt-[3px] h-3.5 w-3.5 shrink-0"
                        />
                      )}
                      <div className="min-w-0 flex-1 text-[12.5px] text-on-surface">
                        <label
                          htmlFor={item.adopted ? undefined : `adopt-${item.key}`}
                          className="flex flex-wrap items-center gap-1.5 font-semibold"
                        >
                          {item.title}
                          {Object.entries(item.meta).map(([k, v]) =>
                            META_LABEL[k] ? (
                              <span
                                key={k}
                                className="rounded-full bg-surface-variant px-1.5 py-0.5 text-[10px] font-semibold text-on-surface-variant"
                              >
                                {META_LABEL[k]} {VALUE_LABEL[v] ?? v}
                              </span>
                            ) : null,
                          )}
                          {item.adopted ? (
                            <span className="rounded-full bg-primary-container px-1.5 py-0.5 text-[10px] font-bold text-primary-container-fg">
                              反映済み
                            </span>
                          ) : null}
                        </label>
                        {item.detail ? (
                          <p className="text-on-surface-variant">{item.detail}</p>
                        ) : null}
                        {item.quote ? (
                          <p className="mt-1 border-l-2 border-border pl-2 text-[11.5px] italic leading-[1.6] text-on-surface-variant">
                            「{item.quote}」
                          </p>
                        ) : null}
                        {item.adopted && href ? (
                          <a
                            href={href}
                            className="mt-1 inline-block text-[11.5px] font-semibold text-primary underline"
                          >
                            {item.target_type === "task" ? "タスクを開く" : "決定を開く"}
                          </a>
                        ) : null}
                      </div>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        );
      })}

      <div className="flex items-center gap-3">
        <button
          type="button"
          onClick={submit}
          disabled={saving || selected.length === 0}
          className="inline-flex items-center gap-1.5 rounded-md bg-primary px-4 py-[7px] text-[12.5px] font-semibold text-on-primary transition-opacity hover:opacity-90 disabled:opacity-50"
        >
          {saving ? "反映中…" : `選んだ ${selected.length} 件を反映する`}
        </button>
        {pending.length === 0 ? (
          <span className="text-[11.5px] text-on-surface-variant">
            すべて反映済みです
          </span>
        ) : null}
      </div>
    </section>
  );
}
