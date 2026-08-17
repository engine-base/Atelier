/**
 * S-L03 クライアントプロジェクトビュー — T-UC-22 (R-T08)
 *
 * クライアント向け project の限定ビュー (api/schemas/client_signin.py の
 * ClientProjectView に対応)。description / scopes / viewed_as_client_display_name を表示。
 *
 * F-VIS 是正: モック 06_mockups/client/S-L03-project.html に忠実な
 * クライアント専用レイアウト (サイドバー無し) で再構築。クライアントヘッダ /
 * 限定アクセスバナー / プロジェクトヘッダカード / アクセス範囲 / 編集不可 notice /
 * 運営とのやり取り。
 *
 * GAP-029 (R-T08 経営者承認済): client スコープ read API の実データで
 * 工程進捗バー / リンク有効期限 / 成果物一覧 / モックギャラリー /
 * あなたのコメント + 投稿 (comment スコープのみ) を描画。content 系 props が
 * undefined のセクションは描画しない (API 未取得時に偽の空を出さない)。
 */

"use client";

import * as React from "react";

import { cn } from "../../../../lib/cn";
import type {
  ClientCommentCreateInput,
  ClientCommentItemData,
  ClientMocksData,
  ClientOutputItemData,
  ClientProjectOverviewData,
} from "../../../../lib/auth/client-portal";

export interface ClientProjectViewData {
  readonly id: string;
  readonly name: string;
  readonly description: string | null;
  readonly scopes: readonly string[];
  readonly viewed_as_client_display_name: string | null;
}

export interface ClientProjectViewProps {
  readonly data: ClientProjectViewData;
  /** ログアウト (client cookie 破棄 → サインインへ)。未指定なら出さない。 */
  readonly onSignOut?: () => void;
  readonly className?: string;
  /** GAP-029 実コンテンツ。undefined = セクション非表示、null = 取得失敗の honest 表示。 */
  readonly overview?: ClientProjectOverviewData | null;
  readonly outputs?: readonly ClientOutputItemData[] | null;
  readonly mocks?: ClientMocksData | null;
  readonly comments?: readonly ClientCommentItemData[] | null;
  /** コメント投稿 (comment スコープ保有時のみ container が渡す)。 */
  readonly onPostComment?: (input: ClientCommentCreateInput) => void;
  readonly posting?: boolean;
  readonly postNotice?: string | null;
  readonly postError?: string | null;
}

const SCOPE_LABEL: Record<string, string> = {
  view: "閲覧",
  comment: "コメント",
  approve: "承認",
};

const SCOPE_DESCRIPTION: Record<string, string> = {
  view: "プロジェクトの進捗と成果物を閲覧できます",
  comment: "各成果物にコメントを残せます",
  approve: "成果物の承認ができます",
};

function firstChar(value: string | null): string {
  const trimmed = (value ?? "").trim();
  return trimmed ? trimmed.slice(0, 1) : "?";
}

const PHASE_STATUS_LABEL: Record<string, string> = {
  pending: "予定",
  in_progress: "進行中",
  completed: "完了",
  skipped: "スキップ",
};

function jaDate(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? iso
    : d.toLocaleDateString("ja-JP", { dateStyle: "medium" });
}

export function ClientProjectView({
  data,
  onSignOut,
  className,
  overview,
  outputs,
  mocks,
  comments,
  onPostComment,
  posting,
  postNotice,
  postError,
}: ClientProjectViewProps) {
  const displayName = data.viewed_as_client_display_name;
  const permissionLabel =
    data.scopes.map((s) => SCOPE_LABEL[s] ?? s).join(" + ") || "閲覧";
  const canComment = data.scopes.includes("comment") && Boolean(onPostComment);

  const commentTargets = React.useMemo(() => {
    const outs = (outputs ?? []).map((o) => ({
      key: `workflow_output:${o.id}`,
      label: `${o.stage_label} v${o.version}`,
    }));
    const ms = (mocks?.items ?? []).map((m) => ({
      key: `mock:${m.id}`,
      label: `モック: ${m.screen_name} v${m.version}`,
    }));
    return [...outs, ...ms];
  }, [outputs, mocks]);
  const [commentTarget, setCommentTarget] = React.useState("");
  const [commentText, setCommentText] = React.useState("");
  const [commentLocalError, setCommentLocalError] = React.useState<
    string | null
  >(null);

  const handlePostComment = () => {
    setCommentLocalError(null);
    if (!commentTarget) {
      setCommentLocalError("コメント対象を選択してください。");
      return;
    }
    if (!commentText.trim()) {
      setCommentLocalError("コメント内容を入力してください。");
      return;
    }
    const [targetType, targetId] = commentTarget.split(":", 2);
    onPostComment?.({
      target_type: targetType as "workflow_output" | "mock",
      target_id: targetId ?? "",
      content: commentText.trim(),
    });
    setCommentText("");
  };

  return (
    <article className={cn("flex flex-col", className)}>
      {/* クライアントヘッダ (サイドバー無し・専用トップバー) */}
      <header className="flex items-center justify-between gap-4 border-b border-border bg-white px-6 py-3.5">
        <div className="flex items-center gap-3">
          {/* GAP-126: 公式ロックアップ (Atelier 文字入り) — 文字を別タイプしない */}
          {/* eslint-disable-next-line @next/next/no-img-element -- 静的 SVG のためサイズ最適化不要 */}
          <img
            src="/brand/logo-horizontal-lockup.svg"
            alt="Atelier"
            className="h-7 w-auto object-contain"
          />
          <div className="border-l border-border pl-3 text-sm text-on-surface-variant">
            Client Portal · {data.name}
          </div>
        </div>
        <div className="flex items-center gap-3">
          {displayName ? (
            <>
              <div className="flex h-8 w-8 items-center justify-center rounded-full bg-primary text-[13px] font-bold text-on-primary">
                {firstChar(displayName)}
              </div>
              <div className="text-right">
                <div className="text-sm font-semibold text-on-surface">
                  {displayName}
                </div>
                <div className="text-sm text-on-surface-variant">
                  {permissionLabel} 可
                </div>
              </div>
            </>
          ) : null}
          {onSignOut ? (
            <button
              type="button"
              onClick={onSignOut}
              aria-label="サインアウト"
              title="サインアウト"
              className="inline-flex h-8 w-8 items-center justify-center rounded-md text-on-surface-variant transition-colors hover:bg-surface-variant focus-visible:outline-2 focus-visible:outline-primary"
            >
              <LogOutIcon />
            </button>
          ) : null}
        </div>
      </header>

      {/* 限定アクセスバナー */}
      <div className="flex items-center gap-2.5 bg-secondary-container px-6 py-2.5 text-[12.5px] text-secondary-container-fg">
        <ShieldIcon />
        <span>
          <strong className="font-bold">限定アクセスモード：</strong>
          このプロジェクトの{permissionLabel}が可能です。編集はできません。
          {overview?.link_remaining_days != null ? (
            <>
              {" "}
              リンク有効期限：残り {overview.link_remaining_days} 日
            </>
          ) : null}
        </span>
      </div>

      <div className="mx-auto w-full max-w-[1100px] px-6 py-8">
        {/* プロジェクトヘッダカード (進捗サマリ) */}
        <section
          aria-labelledby="pj-title"
          className="mb-6 rounded-lg bg-gradient-to-br from-primary-container to-tertiary-container p-8"
        >
          <p className="mb-2 text-[11px] font-bold uppercase tracking-[0.14em] text-on-primary-container">
            PROJECT
          </p>
          <h1
            id="pj-title"
            className="mb-2 text-[28px] font-bold leading-tight tracking-tight text-on-primary-container"
          >
            {data.name}
          </h1>
          {data.description ? (
            <p className="max-w-2xl text-sm leading-relaxed text-on-primary-container">
              {data.description}
            </p>
          ) : null}
          {overview?.operator_workspace_name ? (
            <p className="mt-2 text-[12px] text-on-primary-container">
              運営：{overview.operator_workspace_name}
              {overview.operator_name ? ` · ${overview.operator_name}` : ""}
            </p>
          ) : null}
          {overview && overview.phases.length > 0 ? (
            <div className="mt-5 flex flex-wrap items-center gap-x-2 gap-y-2">
              <ol
                aria-label="工程進捗"
                className="flex flex-wrap items-center gap-x-1.5 gap-y-1.5 text-[12.5px] text-on-primary-container"
              >
                {overview.phases.map((p, i) => (
                  <li key={`${p.order}-${p.name}`} className="flex items-center gap-1.5">
                    {i > 0 ? <span aria-hidden="true">→</span> : null}
                    <span
                      className={cn(
                        p.status === "in_progress" &&
                          "rounded-full bg-white/70 px-2.5 py-0.5 font-bold",
                        p.status === "completed" && "font-semibold",
                        p.status === "pending" && "opacity-60",
                        p.status === "skipped" && "line-through opacity-40",
                      )}
                      title={PHASE_STATUS_LABEL[p.status] ?? p.status}
                    >
                      {p.name}
                    </span>
                  </li>
                ))}
              </ol>
              <span className="ml-auto text-[26px] font-bold leading-none text-on-primary-container">
                {overview.progress_percent}%
              </span>
            </div>
          ) : null}
          {overview === null ? (
            <p className="mt-3 text-[12px] text-on-primary-container">
              進捗情報を取得できませんでした。
            </p>
          ) : null}
        </section>

        <div className="grid grid-cols-1 gap-5 lg:grid-cols-[2fr_1fr]">
          <div className="flex min-w-0 flex-col gap-5">
            {outputs !== undefined ? (
              <section aria-label="成果物">
                <h2 className="mb-4 text-base font-bold tracking-tight text-on-surface">
                  成果物
                </h2>
                <div className="rounded-lg border border-border bg-white">
                  {outputs === null ? (
                    <p className="px-5 py-8 text-center text-sm text-on-surface-variant">
                      成果物を取得できませんでした。
                    </p>
                  ) : outputs.length === 0 ? (
                    <p className="px-5 py-8 text-center text-sm text-on-surface-variant">
                      共有された成果物はまだありません
                    </p>
                  ) : (
                    <ul className="divide-y divide-border">
                      {outputs.map((o) => (
                        <li key={o.id} className="flex items-center gap-3 px-5 py-3.5">
                          <div className="min-w-0 flex-1">
                            <p className="truncate text-sm font-bold text-on-surface">
                              {o.stage_label}
                            </p>
                            <p className="mt-0.5 text-[11.5px] text-on-surface-variant">
                              {jaDate(o.updated_at)} · v{o.version}
                              {o.formats.length > 0
                                ? ` · ${o.formats.map((f) => f.toUpperCase()).join(" / ")}`
                                : ""}
                            </p>
                          </div>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              </section>
            ) : null}

            {mocks !== undefined ? (
              <section aria-label="モック">
                <div className="mb-4 flex items-center justify-between">
                  <h2 className="text-base font-bold tracking-tight text-on-surface">
                    モック
                  </h2>
                  {mocks ? (
                    <span className="text-[12px] font-semibold text-on-surface-variant">
                      全 {mocks.total_screens} 画面
                    </span>
                  ) : null}
                </div>
                {mocks === null ? (
                  <p className="rounded-lg border border-border bg-white px-5 py-8 text-center text-sm text-on-surface-variant">
                    モックを取得できませんでした。
                  </p>
                ) : mocks.items.length === 0 ? (
                  <p className="rounded-lg border border-border bg-white px-5 py-8 text-center text-sm text-on-surface-variant">
                    共有されたモックはまだありません
                  </p>
                ) : (
                  <ul className="grid grid-cols-2 gap-3 sm:grid-cols-3">
                    {mocks.items.map((m) => (
                      <li
                        key={m.id}
                        className="rounded-lg border border-border bg-white p-4"
                      >
                        <p className="truncate text-sm font-bold text-on-surface">
                          {m.screen_name}
                        </p>
                        <p className="mt-1 text-[11.5px] text-on-surface-variant">
                          v{m.version} · {jaDate(m.updated_at)} 更新
                        </p>
                      </li>
                    ))}
                  </ul>
                )}
              </section>
            ) : null}

            {/* アクセス範囲 (scopes を実データからバインド) */}
            <section aria-label="アクセス範囲">
            <div className="mb-4 flex items-center justify-between">
              <h2 className="text-base font-bold tracking-tight text-on-surface">
                アクセス範囲
              </h2>
            </div>
            <div className="rounded-lg border border-border bg-white p-5">
              {data.scopes.length > 0 ? (
                <ul className="flex flex-col gap-4">
                  {data.scopes.map((s) => (
                    <li key={s} className="flex items-start gap-3">
                      <span className="inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full bg-primary-container px-2.5 py-1 text-[11px] font-semibold text-primary-container-fg">
                        <span
                          aria-hidden="true"
                          className="h-1.5 w-1.5 rounded-full bg-current"
                        />
                        {SCOPE_LABEL[s] ?? s}
                      </span>
                      <span className="pt-0.5 text-sm text-on-surface-variant">
                        {SCOPE_DESCRIPTION[s] ?? "—"}
                      </span>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="py-8 text-center text-sm text-on-surface-variant">
                  権限が設定されていません
                </p>
              )}
            </div>
          </section>
          </div>

          {/* サイドカラム: 編集不可 notice + コメント + 運営とのやり取り */}
          <aside className="flex min-w-0 flex-col gap-4">
            <div className="flex items-start gap-2 rounded-md border-l-[3px] border-tertiary bg-tertiary-container p-3 text-xs text-tertiary-container-fg">
              <EyeOffIcon />
              <span>
                <strong className="font-bold">編集不可：</strong>
                あなたのアカウントは{permissionLabel}権限のみです
              </span>
            </div>

            {comments !== undefined ? (
              <section
                aria-label="あなたのコメント"
                className="rounded-lg border border-border bg-white p-4"
              >
                <h2 className="mb-3 text-sm font-bold tracking-tight text-on-surface">
                  あなたのコメント（
                  {comments
                    ? comments.filter((c) => c.is_client_author).length
                    : 0}
                  ）
                </h2>
                {comments === null ? (
                  <p className="py-4 text-center text-[12.5px] text-on-surface-variant">
                    コメントを取得できませんでした。
                  </p>
                ) : comments.length === 0 ? (
                  <p className="py-4 text-center text-[12.5px] text-on-surface-variant">
                    コメントはまだありません
                  </p>
                ) : (
                  <ul className="flex flex-col gap-3">
                    {comments.map((c) => (
                      <li
                        key={c.id}
                        className={cn(
                          "rounded-md border border-border p-3",
                          !c.is_client_author && "bg-surface-variant",
                        )}
                      >
                        <p className="mb-1 flex items-center justify-between gap-2 text-[11px] text-on-surface-variant">
                          <span className="font-bold">
                            {c.is_client_author
                              ? displayName || "あなた"
                              : `運営${c.author_name ? ` · ${c.author_name}` : ""}`}
                          </span>
                          <span>{jaDate(c.created_at)}</span>
                        </p>
                        {c.target_label ? (
                          <p className="mb-1 text-[11px] font-semibold text-primary">
                            {c.target_label}
                          </p>
                        ) : null}
                        <p className="whitespace-pre-wrap text-[12.5px] leading-relaxed text-on-surface">
                          {c.content}
                        </p>
                      </li>
                    ))}
                  </ul>
                )}
              </section>
            ) : null}

            {canComment ? (
              <section
                aria-label="コメントを投稿"
                className="rounded-lg border border-border bg-white p-4"
              >
                <h2 className="mb-3 text-sm font-bold tracking-tight text-on-surface">
                  コメントを投稿
                </h2>
                {postNotice ? (
                  <p
                    role="status"
                    className="mb-2 rounded-md bg-primary-container px-3 py-2 text-[12.5px] text-primary-container-fg"
                  >
                    {postNotice}
                  </p>
                ) : null}
                {postError || commentLocalError ? (
                  <p
                    role="alert"
                    className="mb-2 rounded-md bg-[#FEE2E2] px-3 py-2 text-[12.5px] text-error"
                  >
                    {postError ?? commentLocalError}
                  </p>
                ) : null}
                <label className="mb-2 block">
                  <span className="text-[11px] font-bold uppercase tracking-[0.12em] text-on-surface-variant">
                    コメント対象
                  </span>
                  <select
                    value={commentTarget}
                    onChange={(e) => setCommentTarget(e.target.value)}
                    className="mt-1 w-full rounded-md border border-border bg-white px-3 py-2 text-[13px] text-on-surface"
                  >
                    <option value="">対象を選択…</option>
                    {commentTargets.map((t) => (
                      <option key={t.key} value={t.key}>
                        {t.label}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="mb-3 block">
                  <span className="text-[11px] font-bold uppercase tracking-[0.12em] text-on-surface-variant">
                    コメント内容
                  </span>
                  <textarea
                    value={commentText}
                    onChange={(e) => setCommentText(e.target.value)}
                    rows={3}
                    className="mt-1 w-full rounded-md border border-border px-3 py-2 text-[13px] text-on-surface"
                  />
                </label>
                <button
                  type="button"
                  onClick={handlePostComment}
                  disabled={posting}
                  className="inline-flex h-9 w-full items-center justify-center rounded-md bg-primary text-label-md font-semibold text-on-primary transition-colors hover:bg-primary-hover disabled:opacity-50"
                >
                  {posting ? "投稿中…" : "コメントを投稿"}
                </button>
              </section>
            ) : null}

            <div className="rounded-lg bg-primary-container p-5 text-primary-container-fg">
              <h2 className="mb-2 text-base font-bold tracking-tight">
                運営とのやり取り
              </h2>
              <p className="text-sm leading-relaxed text-primary-container-fg">
                投稿されたコメントは運営側の成果物・モック画面にそのまま共有されます。通常
                1 営業日以内に返信します。
              </p>
            </div>
          </aside>
        </div>
      </div>
    </article>
  );
}

function LogOutIcon() {
  return (
    <svg
      aria-hidden="true"
      width="15"
      height="15"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
      <polyline points="16 17 21 12 16 7" />
      <line x1="21" x2="9" y1="12" y2="12" />
    </svg>
  );
}

function ShieldIcon() {
  return (
    <svg
      aria-hidden="true"
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="flex-shrink-0"
    >
      <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10Z" />
      <path d="m9 12 2 2 4-4" />
    </svg>
  );
}

function EyeOffIcon() {
  return (
    <svg
      aria-hidden="true"
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="mt-0.5 flex-shrink-0"
    >
      <path d="M9.88 9.88a3 3 0 1 0 4.24 4.24" />
      <path d="M10.73 5.08A10.43 10.43 0 0 1 12 5c7 0 10 7 10 7a13.16 13.16 0 0 1-1.67 2.68" />
      <path d="M6.61 6.61A13.526 13.526 0 0 0 2 12s3 7 10 7a9.74 9.74 0 0 0 5.39-1.61" />
      <line x1="2" x2="22" y1="2" y2="22" />
    </svg>
  );
}
