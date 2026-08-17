/**
 * S-E01 メッセージ本文の rich 描画 (GAP-118)
 *
 * これまで assistant 応答は whitespace-pre-wrap の生テキストで、markdown が
 * 記号のまま見えていた。react-markdown (+ remark-gfm / rehype-highlight) で
 * 見出し・リスト・表・引用・リンク・コードを実描画する。
 *
 * ライブラリ選定 (2026-08 調査):
 *   - react-markdown: デファクト。既定で raw HTML を描画しない (XSS 安全)、
 *     要素ごとに自前コンポーネントを差し込める (コードコピー等の拡張が自由)
 *   - remark-gfm: 表・打消し・タスクリスト・自動リンク (GitHub 方言)
 *   - rehype-highlight: コードブロックのシンタックスハイライト (highlight.js)
 *   - 不採用: streamdown (制御余地が小さい/バンドル大)、@assistant-ui の
 *     markdown アドオン (同社 runtime への全面移行が前提で本チャットは自前構造)、
 *     marked/markdown-it 直 (sanitize を自前で持つ必要がありリスク)
 *
 * コードブロックは言語ラベル + 「コピー」ボタン付きカード。
 * リンクは新規タブ + rel=noopener。表は横スクロールコンテナで包む。
 */

"use client";

import * as React from "react";
import ReactMarkdown from "react-markdown";
import rehypeHighlight from "rehype-highlight";
import remarkGfm from "remark-gfm";
import { Check, Copy } from "lucide-react";

function textOf(node: React.ReactNode): string {
  if (node == null || typeof node === "boolean") return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(textOf).join("");
  if (React.isValidElement(node)) {
    return textOf((node.props as { children?: React.ReactNode }).children);
  }
  return "";
}

/** pre > code のコードブロックカード (言語ラベル + コピー)。 */
function CodeBlock({ children }: { children?: React.ReactNode }) {
  const [copied, setCopied] = React.useState(false);
  const child = Array.isArray(children) ? children[0] : children;
  const className =
    (React.isValidElement(child) &&
      (child.props as { className?: string }).className) ||
    "";
  const lang = /language-([\w-]+)/.exec(className)?.[1] ?? "";
  const code = textOf(children).replace(/\n$/, "");

  const copy = () => {
    void navigator.clipboard?.writeText(code).then(() => {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    });
  };

  return (
    <div className="my-2 overflow-hidden rounded-md border border-border bg-[#0F172A]">
      <div className="flex items-center justify-between border-b border-white/10 px-3 py-1.5">
        <span className="font-mono text-[11px] font-semibold uppercase tracking-wide text-white/60">
          {lang || "code"}
        </span>
        <button
          type="button"
          onClick={copy}
          aria-label="コードをコピー"
          className="inline-flex items-center gap-1 rounded-sm px-2 py-0.5 text-[11px] font-semibold text-white/70 transition hover:bg-white/10 hover:text-white"
        >
          {copied ? (
            <Check size={12} aria-hidden="true" />
          ) : (
            <Copy size={12} aria-hidden="true" />
          )}
          {copied ? "コピー済み" : "コピー"}
        </button>
      </div>
      <pre className="overflow-x-auto px-3.5 py-3 font-mono text-[12.5px] leading-[1.7] text-[#E2E8F0]">
        {children}
      </pre>
    </div>
  );
}

/** 各 markdown 要素 → Atelier トークンでの描画。 */
const COMPONENTS: React.ComponentProps<typeof ReactMarkdown>["components"] = {
  h1: ({ children }) => (
    <h3 className="mb-1.5 mt-3 text-[16.5px] font-bold text-on-surface first:mt-0">
      {children}
    </h3>
  ),
  h2: ({ children }) => (
    <h4 className="mb-1.5 mt-3 text-[15.5px] font-bold text-on-surface first:mt-0">
      {children}
    </h4>
  ),
  h3: ({ children }) => (
    <h5 className="mb-1 mt-2.5 text-[14.5px] font-bold text-on-surface first:mt-0">
      {children}
    </h5>
  ),
  p: ({ children }) => <p className="my-1.5 first:mt-0 last:mb-0">{children}</p>,
  ul: ({ children }) => (
    <ul className="my-1.5 list-disc space-y-1 pl-5">{children}</ul>
  ),
  ol: ({ children }) => (
    <ol className="my-1.5 list-decimal space-y-1 pl-5">{children}</ol>
  ),
  li: ({ children }) => <li className="leading-[1.7]">{children}</li>,
  a: ({ href, children }) => (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className="font-semibold text-primary underline underline-offset-2 hover:opacity-80"
    >
      {children}
    </a>
  ),
  blockquote: ({ children }) => (
    <blockquote className="my-2 border-l-[3px] border-primary-container bg-surface-variant/60 px-3 py-1.5 text-on-surface-variant">
      {children}
    </blockquote>
  ),
  table: ({ children }) => (
    <div className="my-2 overflow-x-auto rounded-md border border-border">
      <table className="w-full border-collapse text-[13px]">{children}</table>
    </div>
  ),
  th: ({ children }) => (
    <th className="border-b border-border bg-surface-variant px-3 py-1.5 text-left font-bold text-on-surface">
      {children}
    </th>
  ),
  td: ({ children }) => (
    <td className="border-b border-border px-3 py-1.5 align-top last:border-b-0">
      {children}
    </td>
  ),
  hr: () => <hr className="my-3 border-border" />,
  pre: ({ children }) => <CodeBlock>{children}</CodeBlock>,
  code: ({ className, children }) => {
    // pre 配下 (ブロック) は CodeBlock 側で描画するのでそのまま返す
    if (className?.includes("language-") || textOf(children).includes("\n")) {
      return <code className={className}>{children}</code>;
    }
    return (
      <code className="rounded-sm bg-surface-variant px-1.5 py-0.5 font-mono text-[12.5px] text-on-surface">
        {children}
      </code>
    );
  },
};

export interface MessageContentProps {
  readonly content: string;
}

/** assistant メッセージ本文の markdown 描画。 */
export function MessageContent({ content }: MessageContentProps) {
  return (
    <div className="chat-md min-w-0 text-[14px] leading-[1.75] text-on-surface">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[rehypeHighlight]}
        components={COMPONENTS}
      >
        {content}
      </ReactMarkdown>
    </div>
  );
}
