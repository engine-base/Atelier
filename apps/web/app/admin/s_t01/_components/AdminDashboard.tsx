/**
 * S-T01 運営ダッシュボード — T-UC-30 / GAP-019
 *
 * モック 06_mockups/admin/S-T01-dashboard.html に忠実な構成:
 *   ミッションヒーロー → KPI bento → (トレンド | 取得チャネル別) →
 *   (健全性 | ベータ FB) → (アクティビティ | 運営コスト)。
 *
 * 誠実表示の原則 (GAP-019):
 *   - 表示値はすべて実データ (実カウント/実計測/運営が記録した値)
 *   - 目標・チャネル・コストは運営の明示的な記録が実体 (未記録は記録フォーム)
 *   - MRR は課金未導入のため実額 ¥0 と明示 / 健全性は実測と設定有無のみ
 */

"use client";

import * as React from "react";
import { useState } from "react";

import { cn } from "../../../../lib/cn";

export interface AdminKpi {
  readonly id: string;
  readonly label: string;
  readonly value: number | string;
  readonly sub?: string;
}

export interface AdminActivity {
  readonly id: string;
  readonly ts: string;
  readonly action: string;
  readonly actor: string;
}

export interface MissionGoal {
  readonly title: string;
  readonly targetCount: number;
  readonly deadline: string;
  readonly note?: string | null;
}

export interface MissionData {
  readonly goal: MissionGoal | null;
  readonly currentCount: number;
  readonly added30d: number;
  readonly remaining?: number | null;
  readonly monthsLeft?: number | null;
  readonly neededPerMonth?: number | null;
}

export interface GoalFormValues {
  readonly title: string;
  readonly targetCount: number;
  readonly deadline: string;
  readonly note?: string;
}

export interface TrendPoint {
  readonly weekStart: string;
  readonly workspaces: number;
  readonly projects: number;
}

export interface ChannelCount {
  readonly channel: string;
  readonly count: number;
}

export interface AcquisitionRecord {
  readonly id: string;
  readonly channel: string;
  readonly note: string;
  readonly occurredOn: string;
}

export interface HealthRow {
  readonly name: string;
  readonly status: "ok" | "warn" | "err";
  readonly detail: string;
  readonly meta: string;
}

export interface FeedbackRow {
  readonly id: string;
  readonly email: string;
  readonly category: string;
  readonly content: string;
  readonly status: string;
  readonly createdAt: string;
}

export interface CostRow {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly amountYen: number;
}

export const CHANNEL_LABEL: Readonly<Record<string, string>> = {
  referral: "紹介・口コミ",
  sns: "SNS（X / note）",
  personal: "個人つながり",
  other: "その他",
};

const CHANNEL_BAR: Readonly<Record<string, string>> = {
  referral: "bg-primary",
  sns: "bg-tertiary",
  personal: "bg-secondary",
  other: "bg-on-surface-variant",
};

const FB_TAG: Readonly<Record<string, { label: string; cls: string }>> = {
  bug: { label: "不具合", cls: "bg-[#FEE2E2] text-[#991B1B]" },
  feature: { label: "要望", cls: "bg-primary-container text-on-primary-container" },
  praise: { label: "称賛", cls: "bg-tertiary-container text-on-tertiary-container" },
  other: { label: "その他", cls: "bg-surface-variant text-on-surface-variant" },
};

export interface AdminDashboardProps {
  readonly kpis: readonly AdminKpi[];
  readonly recent: readonly AdminActivity[];
  /** GAP-019: ミッション (goal=null は目標未設定 → 記録フォーム)。 */
  readonly mission?: MissionData;
  readonly onSaveGoal?: (v: GoalFormValues) => void;
  readonly savingGoal?: boolean;
  /** GAP-019: 週次トレンド実累計。 */
  readonly trends?: readonly TrendPoint[];
  readonly billingEnabled?: boolean;
  /** GAP-019: 取得チャネル。 */
  readonly channels?: readonly ChannelCount[];
  readonly channelRecent?: readonly AcquisitionRecord[];
  readonly channelRange?: "30d" | "all";
  readonly onChannelRange?: (r: "30d" | "all") => void;
  readonly onRecordAcquisition?: (channel: string) => void;
  readonly onDeleteAcquisition?: (id: string) => void;
  /** GAP-019: 健全性 (実計測)。 */
  readonly health?: readonly HealthRow[];
  /** GAP-019: ベータ FB。 */
  readonly feedback?: readonly FeedbackRow[];
  readonly feedbackOpenCount?: number;
  readonly feedbackFilter?: "open" | "all";
  readonly onFeedbackFilter?: (f: "open" | "all") => void;
  readonly onResolveFeedback?: (id: string) => void;
  /** GAP-019: 運営コスト (当月)。 */
  readonly costs?: readonly CostRow[];
  readonly costTotalYen?: number;
  readonly costMonthLabel?: string;
  readonly onRecordCost?: (v: { name: string; amountYen: number; description?: string }) => void;
  readonly onDeleteCost?: (id: string) => void;
  readonly actionNotice?: string;
  readonly actionError?: string;
}

/* ────────────────────────── ミッションヒーロー ────────────────────────── */
function MissionHero({
  mission,
  onSaveGoal,
  savingGoal,
}: {
  readonly mission: MissionData;
  readonly onSaveGoal?: (v: GoalFormValues) => void;
  readonly savingGoal?: boolean;
}) {
  const goal = mission.goal;
  const [editing, setEditing] = useState(false);
  const [title, setTitle] = useState(goal?.title ?? "");
  const [target, setTarget] = useState(goal ? String(goal.targetCount) : "");
  const [deadline, setDeadline] = useState(goal?.deadline ?? "");
  const [note, setNote] = useState(goal?.note ?? "");

  const pct = goal
    ? Math.min(100, Math.round((mission.currentCount / goal.targetCount) * 100))
    : 0;

  const form =
    onSaveGoal && (editing || !goal) ? (
      <form
        aria-label="獲得目標の記録"
        className="mt-4 grid max-w-[520px] grid-cols-2 gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          const t = Number(target);
          if (!title.trim() || !Number.isFinite(t) || t <= 0 || !deadline) return;
          onSaveGoal({
            title: title.trim(),
            targetCount: t,
            deadline,
            note: note.trim() || undefined,
          });
          setEditing(false);
        }}
      >
        <label className="col-span-2 block">
          <span className="text-[11px] font-semibold opacity-80">目標タイトル</span>
          <input
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="例: 100 社獲得"
            className="mt-1 w-full rounded-md border border-white/20 bg-white/10 px-3 py-2 text-[13px] text-white outline-none placeholder:text-white/40"
          />
        </label>
        <label className="block">
          <span className="text-[11px] font-semibold opacity-80">目標数</span>
          <input
            type="number"
            min={1}
            value={target}
            onChange={(e) => setTarget(e.target.value)}
            className="mt-1 w-full rounded-md border border-white/20 bg-white/10 px-3 py-2 text-[13px] text-white outline-none"
          />
        </label>
        <label className="block">
          <span className="text-[11px] font-semibold opacity-80">期限</span>
          <input
            type="date"
            value={deadline}
            onChange={(e) => setDeadline(e.target.value)}
            className="mt-1 w-full rounded-md border border-white/20 bg-white/10 px-3 py-2 text-[13px] text-white outline-none"
          />
        </label>
        <label className="col-span-2 block">
          <span className="text-[11px] font-semibold opacity-80">メモ（任意 — 想定 ARR 等）</span>
          <input
            value={note}
            onChange={(e) => setNote(e.target.value)}
            className="mt-1 w-full rounded-md border border-white/20 bg-white/10 px-3 py-2 text-[13px] text-white outline-none"
          />
        </label>
        <div className="col-span-2 flex gap-2">
          <button
            type="submit"
            disabled={savingGoal}
            className="rounded-md bg-white px-4 py-1.5 text-[12.5px] font-bold text-[#1E3A8A] disabled:opacity-50"
          >
            {savingGoal ? "保存中…" : "目標を記録"}
          </button>
          {goal ? (
            <button
              type="button"
              onClick={() => setEditing(false)}
              className="rounded-md px-3 py-1.5 text-[12.5px] font-semibold text-white/80 hover:bg-white/10"
            >
              キャンセル
            </button>
          ) : null}
        </div>
      </form>
    ) : null;

  return (
    <section
      aria-label="ミッション"
      className="grid grid-cols-1 items-center gap-7 rounded-lg bg-[#1E3A8A] p-7 text-white lg:grid-cols-[1fr_320px]"
    >
      <div>
        <p className="mb-2 text-[11px] font-bold uppercase tracking-[0.18em] opacity-70">
          事業ゴール
        </p>
        {goal && !editing ? (
          <>
            <h2 className="mb-2 text-[22px] font-extrabold leading-snug tracking-tight">
              {goal.title} — あと{" "}
              <strong className="text-[#5EEAD4]">{mission.remaining} 社</strong>
              {mission.monthsLeft != null && mission.monthsLeft > 0 ? (
                <>
                  、月平均{" "}
                  <strong className="text-[#5EEAD4]">
                    {mission.neededPerMonth} 社
                  </strong>{" "}
                  のペースが必要
                </>
              ) : null}
            </h2>
            <p className="max-w-[580px] text-[13px] leading-relaxed opacity-80">
              直近 30 日の実増分は +{mission.added30d} 社。期限 {goal.deadline}
              {mission.monthsLeft != null ? `（残り ${mission.monthsLeft} ヶ月）` : ""}。
            </p>
            <div className="mt-4 grid max-w-[480px] grid-cols-2 gap-2.5">
              <div className="rounded-md bg-white/10 px-3.5 py-2.5">
                <div className="text-[10.5px] tracking-[0.06em] opacity-65">
                  必要なペース
                </div>
                <div className="mt-0.5 text-[18px] font-extrabold tabular-nums">
                  +{mission.neededPerMonth} 社 / 月
                </div>
              </div>
              <div className="rounded-md bg-white/10 px-3.5 py-2.5">
                <div className="text-[10.5px] tracking-[0.06em] opacity-65">
                  いまのペース（実測 30 日）
                </div>
                <div className="mt-0.5 text-[18px] font-extrabold tabular-nums text-[#FCD34D]">
                  +{mission.added30d} 社 / 月
                </div>
              </div>
              {goal.note ? (
                <div className="col-span-2 rounded-md bg-white/10 px-3.5 py-2.5">
                  <div className="text-[10.5px] tracking-[0.06em] opacity-65">
                    メモ（運営記録）
                  </div>
                  <div className="mt-0.5 text-[13px] font-semibold">{goal.note}</div>
                </div>
              ) : null}
            </div>
            {onSaveGoal ? (
              <button
                type="button"
                onClick={() => setEditing(true)}
                className="mt-3 rounded-md border border-white/30 px-3 py-1.5 text-[11.5px] font-semibold text-white/90 hover:bg-white/10"
              >
                目標を編集
              </button>
            ) : null}
          </>
        ) : (
          <>
            <h2 className="mb-1 text-[20px] font-extrabold tracking-tight">
              獲得目標が未設定です
            </h2>
            <p className="max-w-[580px] text-[13px] opacity-80">
              目標値は運営が明示的に記録します（システムは数値を創作しません）。
            </p>
            {form}
          </>
        )}
        {goal && editing ? form : null}
      </div>

      <div className="rounded-lg border border-white/15 bg-white/5 p-5">
        <div className="flex items-center gap-4">
          <div
            aria-hidden="true"
            className="relative flex h-[90px] w-[90px] items-center justify-center rounded-full"
            style={{
              background: `conic-gradient(#14B8A6 0% ${pct}%, rgba(255,255,255,0.08) ${pct}% 100%)`,
            }}
          >
            <div className="absolute inset-[7px] rounded-full bg-[#1E3A8A]" />
            <div className="relative text-center">
              <div className="text-[22px] font-black leading-none">
                {mission.currentCount}
              </div>
              <div className="mt-0.5 text-[10.5px] opacity-70">
                {goal ? `/ ${goal.targetCount}` : "WS"}
              </div>
            </div>
          </div>
          <div className="flex-1">
            <div className="text-[11px] uppercase tracking-[0.08em] opacity-70">
              獲得（実ワークスペース数）
            </div>
            <div className="mt-1 text-[14px] font-bold leading-normal">
              現在 {mission.currentCount} 社 · 30 日で +{mission.added30d}
            </div>
            {goal ? (
              <div className="mt-1.5 text-[11.5px] opacity-75">
                あと {mission.remaining} 社
                {mission.monthsLeft != null ? ` · 残り ${mission.monthsLeft} ヶ月` : ""}
              </div>
            ) : null}
          </div>
        </div>
      </div>
    </section>
  );
}

/* ────────────────────────── トレンド (実 SVG) ────────────────────────── */
function TrendPanel({
  points,
  billingEnabled,
}: {
  readonly points: readonly TrendPoint[];
  readonly billingEnabled: boolean;
}) {
  const w = 600;
  const h = 160;
  const max = Math.max(1, ...points.map((p) => Math.max(p.workspaces, p.projects)));
  const x = (i: number) => (points.length <= 1 ? 0 : (i / (points.length - 1)) * w);
  const y = (v: number) => h - (v / max) * (h - 20) - 10;
  const path = (get: (p: TrendPoint) => number) =>
    points.map((p, i) => `${i === 0 ? "M" : "L"} ${x(i).toFixed(1)},${y(get(p)).toFixed(1)}`).join(" ");

  return (
    <div className="rounded-lg border border-border bg-white p-5">
      <div className="mb-3 flex flex-wrap items-center gap-2.5">
        <h2 className="text-sm font-bold text-on-surface">
          利用者・プロジェクトの推移（週次実累計）
        </h2>
        <div className="ml-auto flex gap-3.5 text-[11.5px] text-on-surface">
          <span>
            <span className="mr-1 inline-block h-2 w-2 rounded-full bg-primary" />
            ワークスペース
          </span>
          <span>
            <span className="mr-1 inline-block h-2 w-2 rounded-full bg-tertiary" />
            プロジェクト
          </span>
        </div>
      </div>
      {points.length < 2 ? (
        <p className="py-8 text-center text-[13px] text-on-surface-variant">
          データがまだ十分にありません。
        </p>
      ) : (
        <>
          <svg
            role="img"
            aria-label="週次トレンド"
            viewBox={`0 0 ${w} ${h}`}
            preserveAspectRatio="none"
            className="h-[160px] w-full"
          >
            <g stroke="#E7E5E4" strokeWidth="1" strokeDasharray="3,4">
              <line x1="0" y1={y(max)} x2={w} y2={y(max)} />
              <line x1="0" y1={y(max / 2)} x2={w} y2={y(max / 2)} />
            </g>
            <text x="4" y={y(max) - 3} fontSize="9" fill="#94A3B8">
              {max}
            </text>
            <path d={path((p) => p.workspaces)} stroke="#2563EB" strokeWidth="2.5" fill="none" />
            <path d={path((p) => p.projects)} stroke="#14B8A6" strokeWidth="2.5" fill="none" />
          </svg>
          <div className="mt-1 flex justify-between text-[10px] tabular-nums text-on-surface-variant">
            <span>{points[0]?.weekStart}</span>
            <span>{points[points.length - 1]?.weekStart}</span>
          </div>
        </>
      )}
      {!billingEnabled ? (
        <p className="mt-2 text-[11.5px] text-on-surface-variant">
          MRR: ¥0（課金未導入 — ベータ無料運用中のため実額）
        </p>
      ) : null}
    </div>
  );
}

/* ────────────────────────── 取得チャネル別 ────────────────────────── */
function ChannelPanel({
  channels,
  recent,
  range,
  onRange,
  onRecord,
  onDelete,
}: {
  readonly channels: readonly ChannelCount[];
  readonly recent: readonly AcquisitionRecord[];
  readonly range: "30d" | "all";
  readonly onRange?: (r: "30d" | "all") => void;
  readonly onRecord?: (channel: string) => void;
  readonly onDelete?: (id: string) => void;
}) {
  const [channel, setChannel] = useState("referral");
  const total = channels.reduce((a, c) => a + c.count, 0);
  return (
    <div className="rounded-lg border border-border bg-white p-5">
      <div className="mb-3 flex items-center gap-2">
        <h2 className="text-sm font-bold text-on-surface">取得チャネル別</h2>
        {onRange ? (
          <div className="ml-auto flex gap-0.5 rounded-md bg-surface-variant p-[3px]">
            {(
              [
                ["30d", "30 日"],
                ["all", "累計"],
              ] as const
            ).map(([key, label]) => (
              <button
                key={key}
                type="button"
                onClick={() => onRange(key)}
                aria-pressed={range === key}
                className={cn(
                  "rounded-[5px] px-2.5 py-1 text-[11.5px] font-semibold",
                  range === key
                    ? "bg-white text-on-surface shadow-sm"
                    : "text-on-surface-variant",
                )}
              >
                {label}
              </button>
            ))}
          </div>
        ) : null}
      </div>
      {total === 0 ? (
        <p className="py-4 text-[13px] text-on-surface-variant">
          記録がまだありません。獲得があったら下から記録してください。
        </p>
      ) : (
        <div className="flex flex-col gap-2.5">
          {channels.map((c) => (
            <div key={c.channel}>
              <div className="mb-1 flex justify-between text-[12.5px] text-on-surface">
                <span>{CHANNEL_LABEL[c.channel] ?? c.channel}</span>
                <strong>{c.count} 件</strong>
              </div>
              <div className="h-1.5 overflow-hidden rounded-full bg-surface-variant">
                <div
                  className={cn("h-full rounded-full", CHANNEL_BAR[c.channel] ?? "bg-primary")}
                  style={{ width: `${Math.round((c.count / total) * 100)}%` }}
                />
              </div>
            </div>
          ))}
        </div>
      )}

      {onRecord ? (
        <form
          className="mt-3 flex items-center gap-1.5 border-t border-dashed border-border pt-3"
          onSubmit={(e) => {
            e.preventDefault();
            onRecord(channel);
          }}
        >
          <select
            value={channel}
            onChange={(e) => setChannel(e.target.value)}
            aria-label="獲得チャネル"
            className="h-8 flex-1 rounded-md border border-border bg-white px-2 text-[12px] text-on-surface"
          >
            {Object.entries(CHANNEL_LABEL).map(([k, v]) => (
              <option key={k} value={k}>
                {v}
              </option>
            ))}
          </select>
          <button
            type="submit"
            className="h-8 rounded-md bg-primary px-3 text-[12px] font-semibold text-on-primary hover:bg-[#1E54D8]"
          >
            獲得を記録
          </button>
        </form>
      ) : null}

      {recent.length > 0 && onDelete ? (
        <ul className="mt-2 flex flex-col gap-1">
          {recent.slice(0, 3).map((r) => (
            <li
              key={r.id}
              className="flex items-center gap-2 rounded-sm bg-surface-variant/60 px-2 py-1 text-[11.5px] text-on-surface-variant"
            >
              <span className="tabular-nums">{r.occurredOn}</span>
              <span>{CHANNEL_LABEL[r.channel] ?? r.channel}</span>
              <button
                type="button"
                aria-label={`記録 ${r.occurredOn} ${CHANNEL_LABEL[r.channel] ?? r.channel} を削除`}
                onClick={() => onDelete(r.id)}
                className="ml-auto rounded-sm px-1 text-error hover:bg-white"
              >
                ×
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

/* ────────────────────────── 健全性 ────────────────────────── */
const HEALTH_DOT: Readonly<Record<string, string>> = {
  ok: "bg-tertiary shadow-[0_0_0_4px_rgba(20,184,166,0.18)]",
  warn: "bg-secondary shadow-[0_0_0_4px_rgba(199,160,74,0.18)]",
  err: "bg-error shadow-[0_0_0_4px_rgba(220,38,38,0.18)]",
};

function HealthPanel({ rows }: { readonly rows: readonly HealthRow[] }) {
  return (
    <div className="rounded-lg border border-border bg-white p-5">
      <div className="mb-2 flex items-center gap-2.5">
        <h2 className="text-sm font-bold text-on-surface">プラットフォーム健全性</h2>
        <span className="ml-auto text-[11.5px] text-on-surface-variant">実計測 · 表示時点</span>
      </div>
      <ul className="flex flex-col">
        {rows.map((r) => (
          <li
            key={r.name}
            className="grid grid-cols-[28px_1fr_auto] items-center gap-2.5 border-b border-border py-3 last:border-b-0"
          >
            <span
              aria-hidden="true"
              className={cn("mx-[9px] h-2.5 w-2.5 rounded-full", HEALTH_DOT[r.status])}
            />
            <div>
              <div className="text-[13px] font-semibold text-on-surface">{r.name}</div>
              <div className="text-[11.5px] text-on-surface-variant">{r.detail}</div>
            </div>
            <span className="text-[11.5px] tabular-nums text-on-surface-variant">{r.meta}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/* ────────────────────────── ベータ FB ────────────────────────── */
function FeedbackPanel({
  feedback,
  openCount,
  filter,
  onFilter,
  onResolve,
}: {
  readonly feedback: readonly FeedbackRow[];
  readonly openCount: number;
  readonly filter: "open" | "all";
  readonly onFilter?: (f: "open" | "all") => void;
  readonly onResolve?: (id: string) => void;
}) {
  return (
    <div className="rounded-lg border border-border bg-white p-5">
      <div className="mb-3 flex items-center gap-2">
        <h2 className="text-sm font-bold text-on-surface">
          ベータ FB（未対応 {openCount} 件）
        </h2>
        {onFilter ? (
          <div className="ml-auto flex gap-0.5 rounded-md bg-surface-variant p-[3px]">
            {(
              [
                ["open", "未対応"],
                ["all", "すべて"],
              ] as const
            ).map(([key, label]) => (
              <button
                key={key}
                type="button"
                onClick={() => onFilter(key)}
                aria-pressed={filter === key}
                className={cn(
                  "rounded-[5px] px-2.5 py-1 text-[11.5px] font-semibold",
                  filter === key
                    ? "bg-white text-on-surface shadow-sm"
                    : "text-on-surface-variant",
                )}
              >
                {label}
              </button>
            ))}
          </div>
        ) : null}
      </div>
      {feedback.length === 0 ? (
        <p className="py-4 text-[13px] text-on-surface-variant">
          {filter === "open" ? "未対応の FB はありません。" : "FB はまだありません。"}
        </p>
      ) : (
        feedback.slice(0, 6).map((f) => {
          const tag = FB_TAG[f.category] ?? FB_TAG.other!;
          return (
            <div
              key={f.id}
              className="mb-2 rounded-md border border-border bg-surface px-3.5 py-3 last:mb-0"
            >
              <div className="mb-1 flex items-center gap-2 text-[11px] text-on-surface-variant">
                <span
                  className={cn(
                    "rounded-full px-[7px] py-px text-[10px] font-bold",
                    tag.cls,
                  )}
                >
                  {tag.label}
                </span>
                <span>{f.email}</span>
                <span className="ml-auto tabular-nums">{f.createdAt}</span>
              </div>
              <div className="text-[12.5px] leading-relaxed text-on-surface">{f.content}</div>
              {f.status === "open" && onResolve ? (
                <div className="mt-1.5 flex justify-end">
                  <button
                    type="button"
                    onClick={() => onResolve(f.id)}
                    className="rounded-sm px-2 py-0.5 text-[11px] font-semibold text-tertiary hover:bg-surface-variant"
                  >
                    対応済みにする
                  </button>
                </div>
              ) : f.status === "resolved" ? (
                <div className="mt-1 text-right text-[10.5px] font-semibold text-on-surface-variant">
                  対応済み
                </div>
              ) : null}
            </div>
          );
        })
      )}
    </div>
  );
}

/* ────────────────────────── 運営コスト ────────────────────────── */
function CostPanel({
  costs,
  totalYen,
  monthLabel,
  onRecord,
  onDelete,
}: {
  readonly costs: readonly CostRow[];
  readonly totalYen: number;
  readonly monthLabel: string;
  readonly onRecord?: (v: { name: string; amountYen: number; description?: string }) => void;
  readonly onDelete?: (id: string) => void;
}) {
  const [name, setName] = useState("");
  const [amount, setAmount] = useState("");
  const [desc, setDesc] = useState("");
  return (
    <div className="rounded-lg border border-border bg-white p-5">
      <div className="mb-2 flex items-center gap-2.5">
        <h2 className="text-sm font-bold text-on-surface">運営側コスト（{monthLabel}）</h2>
        <span className="ml-auto text-[11.5px] text-on-surface-variant">運営が記録した実費のみ</span>
      </div>
      {costs.length === 0 ? (
        <p className="py-3 text-[13px] text-on-surface-variant">
          今月の記録はまだありません。
        </p>
      ) : (
        <ul className="flex flex-col">
          {costs.map((c) => (
            <li
              key={c.id}
              className="grid grid-cols-[1fr_auto_auto] items-center gap-3 border-b border-border py-2.5 last:border-b-0"
            >
              <div>
                <div className="text-[13px] font-semibold text-on-surface">{c.name}</div>
                {c.description ? (
                  <div className="text-[11.5px] text-on-surface-variant">{c.description}</div>
                ) : null}
              </div>
              <div className="text-right text-[14px] font-extrabold tabular-nums text-on-surface">
                ¥{c.amountYen.toLocaleString()}
              </div>
              {onDelete ? (
                <button
                  type="button"
                  aria-label={`コスト ${c.name} を削除`}
                  onClick={() => onDelete(c.id)}
                  className="rounded-sm px-1.5 py-1 text-[12px] text-error hover:bg-surface-variant"
                >
                  ×
                </button>
              ) : null}
            </li>
          ))}
        </ul>
      )}
      <div className="mt-2 flex items-baseline justify-between border-t-2 border-on-surface pt-3">
        <span className="text-[12.5px] font-bold text-on-surface">合計（{monthLabel}）</span>
        <span className="text-[22px] font-black tabular-nums text-primary">
          ¥{totalYen.toLocaleString()}
        </span>
      </div>
      {onRecord ? (
        <form
          className="mt-3 grid grid-cols-[1fr_100px_auto] items-center gap-1.5 border-t border-dashed border-border pt-3"
          onSubmit={(e) => {
            e.preventDefault();
            const a = Number(amount);
            if (!name.trim() || !Number.isFinite(a) || a < 0) return;
            onRecord({
              name: name.trim(),
              amountYen: Math.round(a),
              description: desc.trim() || undefined,
            });
            setName("");
            setAmount("");
            setDesc("");
          }}
        >
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="項目名（例: Fly.io）"
            aria-label="コスト項目名"
            className="h-8 rounded-md border border-border bg-white px-2 text-[12px] text-on-surface"
          />
          <input
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            type="number"
            min={0}
            placeholder="¥"
            aria-label="金額 (円)"
            className="h-8 rounded-md border border-border bg-white px-2 text-[12px] text-on-surface"
          />
          <button
            type="submit"
            className="h-8 rounded-md bg-primary px-3 text-[12px] font-semibold text-on-primary hover:bg-[#1E54D8]"
          >
            記録
          </button>
          <input
            value={desc}
            onChange={(e) => setDesc(e.target.value)}
            placeholder="補足（任意）"
            aria-label="コスト補足"
            className="col-span-3 h-8 rounded-md border border-border bg-white px-2 text-[12px] text-on-surface"
          />
        </form>
      ) : null}
    </div>
  );
}

/* ────────────────────────── 既存: KPI / アクティビティ ────────────────────────── */
interface ActivityMeta {
  readonly category: string;
  readonly chip: string;
  readonly pill: string;
}

function activityMeta(action: string): ActivityMeta {
  const a = action.toLowerCase();
  if (/(create|signup|invite|register|add|join)/.test(a)) {
    return {
      category: "作成",
      chip: "bg-tertiary-container text-on-tertiary-container",
      pill: "bg-tertiary-container text-on-tertiary-container",
    };
  }
  if (/(delete|remove|churn|suspend|withdraw|revoke)/.test(a)) {
    return { category: "削除", chip: "bg-error/10 text-error", pill: "bg-error/10 text-error" };
  }
  if (/(skill|knowledge|publish|update|upgrade|deploy)/.test(a)) {
    return {
      category: "更新",
      chip: "bg-secondary-container text-on-secondary-container",
      pill: "bg-secondary-container text-on-secondary-container",
    };
  }
  return {
    category: "操作",
    chip: "bg-primary-container text-on-primary-container",
    pill: "bg-primary-container text-on-primary-container",
  };
}

function KpiTile({ kpi }: { readonly kpi: AdminKpi }) {
  return (
    <article className="relative overflow-hidden rounded-lg border border-border bg-white p-5">
      <div className="mb-2 text-[11px] font-bold uppercase tracking-[0.06em] text-on-surface-variant">
        {kpi.label}
      </div>
      <div className="text-[28px] font-bold leading-none tracking-tight tabular-nums text-on-surface">
        {kpi.value}
      </div>
      {kpi.sub ? (
        <div className="mt-2 text-[11.5px] font-semibold text-on-surface-variant">{kpi.sub}</div>
      ) : null}
    </article>
  );
}

function ActivityRow({ item }: { readonly item: AdminActivity }) {
  const meta = activityMeta(item.action);
  return (
    <li className="grid grid-cols-[28px_1fr_auto] items-start gap-3 border-b border-border py-3 last:border-b-0">
      <span
        aria-hidden="true"
        className={cn("flex h-7 w-7 items-center justify-center rounded-md", meta.chip)}
      >
        <span className="h-2 w-2 rounded-full bg-current" />
      </span>
      <div className="min-w-0 text-[13px] leading-relaxed text-on-surface">
        <span className="font-bold">{item.actor}</span>
        <span className="text-on-surface-variant"> · </span>
        <span className="break-all font-mono text-[12.5px]">{item.action}</span>
        <span
          className={cn(
            "ml-2 inline-flex items-center rounded-full px-2 py-[1px] text-[10.5px] font-semibold align-middle",
            meta.pill,
          )}
        >
          {meta.category}
        </span>
      </div>
      <time className="whitespace-nowrap text-[11px] tabular-nums text-on-surface-variant">
        {item.ts}
      </time>
    </li>
  );
}

export function AdminDashboard({
  kpis,
  recent,
  mission,
  onSaveGoal,
  savingGoal,
  trends,
  billingEnabled = false,
  channels,
  channelRecent = [],
  channelRange = "30d",
  onChannelRange,
  onRecordAcquisition,
  onDeleteAcquisition,
  health,
  feedback,
  feedbackOpenCount = 0,
  feedbackFilter = "open",
  onFeedbackFilter,
  onResolveFeedback,
  costs,
  costTotalYen = 0,
  costMonthLabel = "",
  onRecordCost,
  onDeleteCost,
  actionNotice,
  actionError,
}: AdminDashboardProps) {
  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-col gap-1">
        <span className="text-[11px] font-bold uppercase tracking-[0.14em] text-on-surface-variant">
          Platform Overview
        </span>
        <div className="flex items-center gap-3">
          <span className="inline-flex items-center rounded-sm bg-error px-2.5 py-[3px] text-[10px] font-extrabold tracking-[0.08em] text-on-error">
            運営
          </span>
          <h1 className="text-3xl font-bold tracking-tight text-on-surface">
            運営ダッシュボード
          </h1>
        </div>
      </header>

      {actionError ? (
        <p role="alert" className="rounded-md bg-error/10 px-3 py-2 text-[12.5px] text-error">
          {actionError}
        </p>
      ) : actionNotice ? (
        <p
          role="status"
          className="rounded-md bg-tertiary-container px-3 py-2 text-[12.5px] text-tertiary-container-fg"
        >
          {actionNotice}
        </p>
      ) : null}

      {mission ? (
        <MissionHero mission={mission} onSaveGoal={onSaveGoal} savingGoal={savingGoal} />
      ) : null}

      <section aria-label="KPI" className="grid grid-cols-2 gap-4 md:grid-cols-4">
        {kpis.map((k) => (
          <KpiTile key={k.id} kpi={k} />
        ))}
      </section>

      {(trends || channels) && (
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-[2fr_1fr]">
          {trends ? <TrendPanel points={trends} billingEnabled={billingEnabled} /> : null}
          {channels ? (
            <ChannelPanel
              channels={channels}
              recent={channelRecent}
              range={channelRange}
              onRange={onChannelRange}
              onRecord={onRecordAcquisition}
              onDelete={onDeleteAcquisition}
            />
          ) : null}
        </div>
      )}

      {(health || feedback) && (
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-[2fr_1fr]">
          {health ? <HealthPanel rows={health} /> : null}
          {feedback ? (
            <FeedbackPanel
              feedback={feedback}
              openCount={feedbackOpenCount}
              filter={feedbackFilter}
              onFilter={onFeedbackFilter}
              onResolve={onResolveFeedback}
            />
          ) : null}
        </div>
      )}

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-[2fr_1fr]">
        <section
          aria-label="最近のアクティビティ"
          className="rounded-lg border border-border bg-white p-5"
        >
          <div className="mb-4 flex items-center gap-2.5">
            <h2 className="text-base font-bold text-on-surface">最近のアクティビティ</h2>
            <span className="ml-auto text-[11.5px] text-on-surface-variant">監査ログ · 直近</span>
          </div>
          {recent.length === 0 ? (
            <p className="py-12 text-center text-on-surface-variant">
              アクティビティはまだありません
            </p>
          ) : (
            <ul role="list" className="flex flex-col">
              {recent.map((a) => (
                <ActivityRow key={a.id} item={a} />
              ))}
            </ul>
          )}
        </section>
        {costs ? (
          <CostPanel
            costs={costs}
            totalYen={costTotalYen}
            monthLabel={costMonthLabel}
            onRecord={onRecordCost}
            onDelete={onDeleteCost}
          />
        ) : null}
      </div>
    </div>
  );
}
