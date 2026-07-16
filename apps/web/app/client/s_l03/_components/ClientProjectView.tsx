/**
 * S-L03 クライアントプロジェクトビュー — T-UC-22 (R-T08)
 *
 * クライアント向け project の限定ビュー (api/schemas/client_signin.py の
 * ClientProjectView に対応)。description / scopes / viewed_as_client_display_name を表示。
 *
 * F-VIS 是正: モック 06_mockups/client/S-L03-project.html に忠実な
 * クライアント専用レイアウト (サイドバー無し) で再構築。クライアントヘッダ /
 * 限定アクセスバナー / プロジェクトヘッダカード / アクセス範囲 / 編集不可 notice /
 * 運営とのやり取り。表示は API が返す実データ (name/description/scopes/display_name)
 * にのみバインドし、モックのダミー値 (成果物・工程%・コメント) は起こさない。
 */

"use client";

import * as React from "react";

import { cn } from "../../../../lib/cn";

export interface ClientProjectViewData {
  readonly id: string;
  readonly name: string;
  readonly description: string | null;
  readonly scopes: readonly string[];
  readonly viewed_as_client_display_name: string | null;
}

export interface ClientProjectViewProps {
  readonly data: ClientProjectViewData;
  readonly className?: string;
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

export function ClientProjectView({ data, className }: ClientProjectViewProps) {
  const displayName = data.viewed_as_client_display_name;
  const permissionLabel =
    data.scopes.map((s) => SCOPE_LABEL[s] ?? s).join(" + ") || "閲覧";

  return (
    <article className={cn("flex flex-col", className)}>
      {/* クライアントヘッダ (サイドバー無し・専用トップバー) */}
      <header className="flex items-center justify-between gap-4 border-b border-border bg-white px-6 py-3.5">
        <div className="flex items-center gap-3">
          <div className="flex h-7 w-7 items-center justify-center rounded-md bg-primary text-[13px] font-bold text-on-primary">
            A
          </div>
          <div>
            <div className="text-[15px] font-bold leading-tight tracking-tight text-on-surface">
              Atelier
            </div>
            <div className="text-sm text-on-surface-variant">
              Client Portal · {data.name}
            </div>
          </div>
        </div>
        {displayName ? (
          <div className="flex items-center gap-3">
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
          </div>
        ) : null}
      </header>

      {/* 限定アクセスバナー */}
      <div className="flex items-center gap-2.5 bg-secondary-container px-6 py-2.5 text-[12.5px] text-secondary-container-fg">
        <ShieldIcon />
        <span>
          <strong className="font-bold">限定アクセスモード：</strong>
          このプロジェクトの{permissionLabel}が可能です。編集はできません。
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
        </section>

        <div className="grid grid-cols-1 gap-5 lg:grid-cols-[2fr_1fr]">
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
                      <span className="inline-flex items-center gap-1.5 rounded-full bg-primary-container px-2.5 py-1 text-[11px] font-semibold text-primary-container-fg">
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

          {/* サイドカラム: 編集不可 notice + 運営とのやり取り */}
          <aside className="flex flex-col gap-4">
            <div className="flex items-start gap-2 rounded-md border-l-[3px] border-tertiary bg-tertiary-container p-3 text-xs text-tertiary-container-fg">
              <EyeOffIcon />
              <span>
                <strong className="font-bold">編集不可：</strong>
                あなたのアカウントは{permissionLabel}権限のみです
              </span>
            </div>

            <div className="rounded-lg bg-primary-container p-5 text-primary-container-fg">
              <h2 className="mb-2 text-base font-bold tracking-tight">
                運営とのやり取り
              </h2>
              <p className="text-sm leading-relaxed text-primary-container-fg">
                コメントを投稿すると、自動で運営側に通知が届きます。通常 1
                営業日以内に返信します。
              </p>
            </div>
          </aside>
        </div>
      </div>
    </article>
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
