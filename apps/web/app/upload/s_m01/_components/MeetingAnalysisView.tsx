/**
 * GAP-184 — 議事録の解析結果を「1 時間の打合せの厚み」で見せる。
 *
 * 直前の実態: 要約・話者・要件・アクションの 4 項目だけで、**決定事項・論点・
 * 数値/金額/期限・リスク・未決事項が丸ごと欠落**していた。しかもサーバー側が
 * 本文を 24,000 字で打ち切っていたため、1 時間を超える会議は後半が存在しない
 * ことになっていた。
 *
 * ここでは 9 セクションを描き、各項目に **文字起こしからの引用**を添える。
 * 引用があるから「本当にそう言っていたか」を人が照合できる = 創作を検出できる。
 */

"use client";

import * as React from "react";

import { cn } from "../../../../lib/cn";

export interface AnalysisQuoted {
  readonly quote?: string | null;
}

export interface AnalysisDecision extends AnalysisQuoted {
  readonly title: string;
  readonly detail?: string | null;
  readonly decided_by?: string | null;
}

export interface AnalysisRequirement extends AnalysisQuoted {
  readonly title: string;
  readonly detail?: string | null;
  readonly kind?: "functional" | "non_functional" | "constraint" | string;
  readonly priority?: "must" | "should" | "could" | string;
}

export interface AnalysisQuestion extends AnalysisQuoted {
  readonly question: string;
  readonly context?: string | null;
}

export interface AnalysisRisk extends AnalysisQuoted {
  readonly title: string;
  readonly impact?: string | null;
}

export interface AnalysisAction extends AnalysisQuoted {
  readonly title: string;
  readonly owner?: string | null;
  readonly due?: string | null;
}

export interface AnalysisFact extends AnalysisQuoted {
  readonly label: string;
  readonly value?: string | null;
}

export interface MeetingAnalysis {
  readonly summary: string;
  readonly speakers: readonly { name: string; role?: string | null }[];
  readonly agenda?: readonly string[];
  readonly decisions?: readonly AnalysisDecision[];
  /** GAP-184 で object 化。旧データ (文字列配列) も受ける。 */
  readonly requirements: readonly (AnalysisRequirement | string)[];
  readonly open_questions?: readonly AnalysisQuestion[];
  readonly risks?: readonly AnalysisRisk[];
  readonly action_items: readonly AnalysisAction[];
  readonly facts?: readonly AnalysisFact[];
  readonly next_meeting?: { date?: string | null; agenda?: string | null } | null;
  /** 分割解析した区間数 (長い会議で 2 以上)。 */
  readonly segments?: number;
  readonly source_chars?: number;
  /** 上限に達して一部を解析できなかった場合のみ true。 */
  readonly truncated?: boolean;
}

const KIND_LABEL: Record<string, string> = {
  functional: "機能",
  non_functional: "非機能",
  constraint: "制約",
};

const PRIORITY_LABEL: Record<string, string> = {
  must: "必須",
  should: "推奨",
  could: "任意",
};

const PRIORITY_TONE: Record<string, string> = {
  must: "bg-error text-on-error",
  should: "bg-primary-container text-primary-container-fg",
  could: "bg-surface-variant text-on-surface-variant",
};

/** 旧形式 (文字列だけ) の要件も新形式に揃える。 */
export function toRequirement(r: AnalysisRequirement | string): AnalysisRequirement {
  return typeof r === "string" ? { title: r } : r;
}

function Quote({ quote }: { readonly quote?: string | null }) {
  if (!quote) return null;
  return (
    <p className="mt-1 border-l-2 border-border pl-2 text-[11.5px] italic leading-[1.6] text-on-surface-variant">
      「{quote}」
    </p>
  );
}

function Card({
  title,
  count,
  emptyText,
  children,
}: {
  readonly title: string;
  readonly count: number;
  readonly emptyText: string;
  readonly children: React.ReactNode;
}) {
  return (
    <div className="rounded-md border border-border p-4">
      <h3 className="mb-2 flex items-center gap-2 text-[11px] font-bold uppercase tracking-[0.08em] text-on-surface-variant">
        {title}
        <span className="rounded-full bg-surface-variant px-1.5 py-0.5 tabular-nums">
          {count}
        </span>
      </h3>
      {count === 0 ? (
        <p className="text-[12px] text-on-surface-variant">{emptyText}</p>
      ) : (
        children
      )}
    </div>
  );
}

export function MeetingAnalysisView({
  analysis,
}: {
  readonly analysis: MeetingAnalysis;
}) {
  const decisions = analysis.decisions ?? [];
  const questions = analysis.open_questions ?? [];
  const risks = analysis.risks ?? [];
  const facts = analysis.facts ?? [];
  const agenda = analysis.agenda ?? [];
  const requirements = analysis.requirements.map(toRequirement);

  return (
    <section aria-label="解析結果" className="flex flex-col gap-3">
      <div className="rounded-md border-l-[3px] border-primary bg-primary-container/40 p-4">
        <h3 className="mb-1 text-[11px] font-bold uppercase tracking-[0.08em] text-primary">
          サマリー
        </h3>
        <p className="whitespace-pre-wrap text-body-sm leading-relaxed text-on-surface">
          {analysis.summary || "（要約なし）"}
        </p>
        {analysis.segments && analysis.segments > 1 ? (
          <p className="mt-2 text-[11px] text-on-surface-variant">
            長い打合せのため {analysis.segments} 区間に分けて全文を解析しました
            {analysis.source_chars
              ? `（文字起こし ${analysis.source_chars.toLocaleString()} 字）`
              : ""}
          </p>
        ) : null}
        {analysis.truncated ? (
          <p role="alert" className="mt-2 text-[11.5px] font-semibold text-error">
            ⚠ 非常に長いため一部が解析されていません。全文は上の文字起こしを確認してください。
          </p>
        ) : null}
      </div>

      {agenda.length > 0 ? (
        <div className="rounded-md border border-border p-4">
          <h3 className="mb-2 text-[11px] font-bold uppercase tracking-[0.08em] text-on-surface-variant">
            話した議題
          </h3>
          <ol className="flex list-inside list-decimal flex-col gap-1 text-[12.5px] text-on-surface">
            {agenda.map((a) => (
              <li key={a}>{a}</li>
            ))}
          </ol>
        </div>
      ) : null}

      <Card title="決定したこと" count={decisions.length} emptyText="この打合せで確定した事項はありませんでした">
        <ul className="flex flex-col gap-2.5">
          {decisions.map((d) => (
            <li key={d.title} className="text-[12.5px] text-on-surface">
              <div className="flex items-start gap-2">
                <span aria-hidden className="mt-[6px] h-1.5 w-1.5 shrink-0 rounded-full bg-tertiary" />
                <span className="font-semibold">{d.title}</span>
                {d.decided_by ? (
                  <span className="text-on-surface-variant">（{d.decided_by}）</span>
                ) : null}
              </div>
              {d.detail ? (
                <p className="ml-3.5 text-on-surface-variant">{d.detail}</p>
              ) : null}
              <div className="ml-3.5">
                <Quote quote={d.quote} />
              </div>
            </li>
          ))}
        </ul>
      </Card>

      <Card title="抽出要件" count={requirements.length} emptyText="抽出されませんでした">
        <ul className="flex flex-col gap-2.5">
          {requirements.map((r) => (
            <li key={r.title} className="text-[12.5px] text-on-surface">
              <div className="flex flex-wrap items-center gap-1.5">
                <span className="font-semibold">{r.title}</span>
                {r.priority ? (
                  <span
                    className={cn(
                      "rounded-full px-1.5 py-0.5 text-[10px] font-bold",
                      PRIORITY_TONE[r.priority] ??
                        "bg-surface-variant text-on-surface-variant",
                    )}
                  >
                    {PRIORITY_LABEL[r.priority] ?? r.priority}
                  </span>
                ) : null}
                {r.kind ? (
                  <span className="rounded-full bg-surface-variant px-1.5 py-0.5 text-[10px] font-semibold text-on-surface-variant">
                    {KIND_LABEL[r.kind] ?? r.kind}
                  </span>
                ) : null}
              </div>
              {r.detail ? <p className="text-on-surface-variant">{r.detail}</p> : null}
              <Quote quote={r.quote} />
            </li>
          ))}
        </ul>
      </Card>

      <div className="grid gap-3 sm:grid-cols-2">
        <Card title="未決事項" count={questions.length} emptyText="持ち越しはありません">
          <ul className="flex flex-col gap-2.5">
            {questions.map((q) => (
              <li key={q.question} className="text-[12.5px] text-on-surface">
                <div className="font-semibold">{q.question}</div>
                {q.context ? (
                  <p className="text-on-surface-variant">{q.context}</p>
                ) : null}
                <Quote quote={q.quote} />
              </li>
            ))}
          </ul>
        </Card>

        <Card title="リスク・懸念" count={risks.length} emptyText="挙がりませんでした">
          <ul className="flex flex-col gap-2.5">
            {risks.map((r) => (
              <li key={r.title} className="text-[12.5px] text-on-surface">
                <div className="font-semibold">{r.title}</div>
                {r.impact ? <p className="text-on-surface-variant">{r.impact}</p> : null}
                <Quote quote={r.quote} />
              </li>
            ))}
          </ul>
        </Card>
      </div>

      <Card
        title="数値・日付・金額"
        count={facts.length}
        emptyText="具体的な数値は出ませんでした"
      >
        <dl className="grid gap-2 sm:grid-cols-2">
          {facts.map((f) => (
            <div key={f.label} className="text-[12.5px]">
              <dt className="font-semibold text-on-surface">{f.label}</dt>
              <dd className="text-on-surface">{f.value}</dd>
              <Quote quote={f.quote} />
            </div>
          ))}
        </dl>
      </Card>

      <div className="grid gap-3 sm:grid-cols-2">
        <Card title="話者" count={analysis.speakers.length} emptyText="特定できませんでした">
          <ul className="flex flex-wrap gap-1.5">
            {analysis.speakers.map((sp) => (
              <li
                key={sp.name}
                className="rounded-full bg-surface-variant px-2.5 py-1 text-[12px] font-medium text-on-surface"
              >
                {sp.name}
                {sp.role ? (
                  <span className="text-on-surface-variant">（{sp.role}）</span>
                ) : null}
              </li>
            ))}
          </ul>
        </Card>

        <Card
          title="アクションアイテム"
          count={analysis.action_items.length}
          emptyText="ありません"
        >
          <ul className="flex flex-col gap-2">
            {analysis.action_items.map((a) => (
              <li key={a.title} className="text-[12.5px] text-on-surface">
                <div className="flex items-start gap-2">
                  <span aria-hidden className="mt-[6px] h-1.5 w-1.5 shrink-0 rounded-full bg-tertiary" />
                  <span>
                    {a.title}
                    {a.owner ? (
                      <span className="text-on-surface-variant">（{a.owner}）</span>
                    ) : null}
                    {a.due ? (
                      <span className="ml-1 rounded-full bg-surface-variant px-1.5 py-0.5 text-[10px] font-semibold text-on-surface-variant">
                        期限 {a.due}
                      </span>
                    ) : null}
                  </span>
                </div>
                <div className="ml-3.5">
                  <Quote quote={a.quote} />
                </div>
              </li>
            ))}
          </ul>
        </Card>
      </div>

      {analysis.next_meeting ? (
        <div className="rounded-md border border-border bg-surface-variant/40 p-4 text-[12.5px] text-on-surface">
          <span className="font-bold">次回：</span>
          {analysis.next_meeting.date ?? "日程未定"}
          {analysis.next_meeting.agenda ? ` — ${analysis.next_meeting.agenda}` : ""}
        </div>
      ) : null}
    </section>
  );
}
