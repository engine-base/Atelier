/**
 * NoteMarkdown — S-K01 ノート本文の軽量 Markdown 描画 (依存追加なし)
 *
 * content_md のうちナレッジノートで実際に使う構文だけを整形する:
 *   # / ## / ### 見出し、- リスト、> 引用 (モック .note-quote)、``` コード、
 *   `inline code`、**強調**。それ以外の行は段落。
 * モック S-K01-explorer.html の .note-h2 / .note-p / .note-quote / .note-list に対応。
 */

"use client";

import * as React from "react";

/** インライン構文: `code` と **bold** を span に分解する。 */
function renderInline(text: string): React.ReactNode[] {
  const parts: React.ReactNode[] = [];
  // `code` / **bold** を順に切り出す
  const re = /(`[^`]+`|\*\*[^*]+\*\*)/g;
  let last = 0;
  let m: RegExpExecArray | null;
  let key = 0;
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) parts.push(text.slice(last, m.index));
    const tok = m[0];
    if (tok.startsWith("`")) {
      parts.push(
        <code
          key={`c${key++}`}
          className="rounded bg-surface-variant px-1 py-0.5 font-mono text-[12.5px] text-on-surface"
        >
          {tok.slice(1, -1)}
        </code>,
      );
    } else {
      parts.push(
        <strong key={`b${key++}`} className="font-bold">
          {tok.slice(2, -2)}
        </strong>,
      );
    }
    last = m.index + tok.length;
  }
  if (last < text.length) parts.push(text.slice(last));
  return parts;
}

type Block =
  | { kind: "h"; level: number; text: string }
  | { kind: "p"; text: string }
  | { kind: "list"; items: string[] }
  | { kind: "quote"; lines: string[] }
  | { kind: "code"; lines: string[] };

function parseBlocks(md: string): Block[] {
  const blocks: Block[] = [];
  const lines = md.split(/\r?\n/);
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    if (line.trim() === "") {
      i++;
      continue;
    }
    if (line.startsWith("```")) {
      const buf: string[] = [];
      i++;
      while (i < lines.length && !lines[i]!.startsWith("```")) {
        buf.push(lines[i]!);
        i++;
      }
      i++; // closing fence
      blocks.push({ kind: "code", lines: buf });
      continue;
    }
    const h = /^(#{1,3})\s+(.*)$/.exec(line);
    if (h) {
      blocks.push({ kind: "h", level: h[1]!.length, text: h[2]! });
      i++;
      continue;
    }
    if (/^[-*]\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^[-*]\s+/.test(lines[i]!)) {
        items.push(lines[i]!.replace(/^[-*]\s+/, ""));
        i++;
      }
      blocks.push({ kind: "list", items });
      continue;
    }
    if (line.startsWith(">")) {
      const buf: string[] = [];
      while (i < lines.length && lines[i]!.startsWith(">")) {
        buf.push(lines[i]!.replace(/^>\s?/, ""));
        i++;
      }
      blocks.push({ kind: "quote", lines: buf });
      continue;
    }
    // 連続する通常行は 1 段落にまとめる
    const buf: string[] = [];
    while (
      i < lines.length &&
      lines[i]!.trim() !== "" &&
      !/^(#{1,3})\s|^[-*]\s|^>|^```/.test(lines[i]!)
    ) {
      buf.push(lines[i]!);
      i++;
    }
    blocks.push({ kind: "p", text: buf.join("\n") });
  }
  return blocks;
}

export function NoteMarkdown({ content }: { readonly content: string }) {
  const blocks = parseBlocks(content);
  return (
    <div>
      {blocks.map((b, idx) => {
        switch (b.kind) {
          case "h":
            return b.level === 1 ? (
              <h3 key={idx} className="mb-3 mt-6 text-[20px] font-bold text-on-surface first:mt-0">
                {b.text}
              </h3>
            ) : (
              <h3 key={idx} className="mb-2.5 mt-6 text-[18px] font-bold text-on-surface first:mt-0">
                {b.text}
              </h3>
            );
          case "list":
            return (
              <ul key={idx} className="mb-3 list-disc pl-[22px] text-[14px] leading-[1.85] text-on-surface">
                {b.items.map((it, j) => (
                  <li key={j}>{renderInline(it)}</li>
                ))}
              </ul>
            );
          case "quote":
            return (
              <blockquote
                key={idx}
                className="mb-3 rounded-r-md border-l-[3px] border-primary bg-primary-container px-4 py-3 text-[13.5px] italic leading-[1.8] text-primary-container-fg"
              >
                {b.lines.map((l, j) => (
                  <p key={j}>{renderInline(l)}</p>
                ))}
              </blockquote>
            );
          case "code":
            return (
              <pre
                key={idx}
                className="mb-3 overflow-x-auto rounded-md bg-surface-variant p-3 font-mono text-[12.5px] leading-relaxed text-on-surface"
              >
                {b.lines.join("\n")}
              </pre>
            );
          default:
            return (
              <p key={idx} className="mb-3 whitespace-pre-wrap text-[14px] leading-[1.85] text-on-surface">
                {renderInline(b.text)}
              </p>
            );
        }
      })}
    </div>
  );
}
