/**
 * 法令文書ビュー — S-PUB01〜03 (design-audit v2)
 *
 * 従来はページごとに縮約版の本文をハードコードしており、DB/API の正本
 * (GET /public/legal-documents/{doc_type}) と乖離していた。正本から取得して
 * Markdown 描画する方式に是正 (版数・最終更新も実データ)。
 */

"use client";

import * as React from "react";
import { useEffect, useState } from "react";

import { NoteMarkdown } from "../../knowledge/s_k01/_components/NoteMarkdown";
import { getJson } from "../../../lib/auth/connector";

export type LegalDocType = "terms_of_service" | "privacy_policy" | "tokushoho";

interface LegalDoc {
  readonly title: string;
  readonly body_md: string;
  readonly version: string;
  readonly effective_date?: string | null;
  readonly updated_at?: string | null;
}

function dateLabel(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日`;
}

export function LegalDocArticle({
  docType,
  fetchDoc,
}: {
  readonly docType: LegalDocType;
  /** テスト用に注入可能。既定は GET /public/legal-documents/{doc_type}。 */
  readonly fetchDoc?: (t: LegalDocType) => Promise<LegalDoc>;
}) {
  const [doc, setDoc] = useState<LegalDoc | null>(null);
  const [error, setError] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const run = fetchDoc
      ? fetchDoc(docType)
      : getJson<LegalDoc>(`/public/legal-documents/${docType}`).then(
          (r) => r.data,
        );
    run
      .then((d) => {
        if (!cancelled) setDoc(d);
      })
      .catch(() => {
        if (!cancelled) setError(true);
      });
    return () => {
      cancelled = true;
    };
  }, [docType, fetchDoc]);

  if (error) {
    return (
      <p role="alert" className="text-body-md text-error">
        文書の取得に失敗しました。時間をおいて再度お試しください。
      </p>
    );
  }
  if (!doc) {
    return (
      <p role="status" className="text-body-md text-on-surface-variant">
        読み込み中…
      </p>
    );
  }

  const updated = dateLabel(doc.effective_date) ?? dateLabel(doc.updated_at);
  // body_md 先頭の H1 がタイトルと重複する場合は取り除く (二重見出し防止)
  const body = doc.body_md.replace(/^#\s+.*\n+/, "");
  return (
    <article>
      <p className="mb-2 text-[12px] text-on-surface-variant">
        {updated ? `最終更新：${updated} · ` : ""}バージョン {doc.version}
      </p>
      <h1 className="mb-4 text-[26px] font-bold tracking-tight text-on-surface">
        {doc.title}
      </h1>
      <NoteMarkdown content={body} />
    </article>
  );
}
