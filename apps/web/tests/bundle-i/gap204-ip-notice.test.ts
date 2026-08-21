/**
 * GAP-204 — 著作権と利用条件の明示、AI 学習拒否の意思表示
 *
 * 技術的な事実として、ブラウザへ配った HTML/CSS は必ず読める。**見た目の模倣を
 * 技術で止めることはできない**。止められないぶん、
 *   - 誰の著作物で、どういう条件で使えるのか
 *   - 学習用の収集を拒否していること
 * を配る側に明示し、**法的に戦える状態**にしておく。ここではそれが消えていない
 * ことを固定する（うっかり消えても気づけるように）。
 */

import { describe, expect, it, vi } from "vitest";

// next/font はビルド時にしか動かないので、layout を読むためだけに差し替える。
vi.mock("next/font/google", () => ({
  Noto_Sans_JP: () => ({ variable: "--font-noto", className: "font-noto" }),
}));

import { metadata } from "../../app/layout";
import robots from "../../app/robots";
import { ROUTE_MAP } from "../../lib/routes";

describe("GAP-204 著作権表示", () => {
  it("配る HTML に著作権表示が入る", () => {
    const other = metadata.other as Record<string, unknown> | undefined;
    expect(other).toBeDefined();
    expect(String(other?.copyright)).toContain("ENGINE BASE");
    expect(String(other?.copyright)).toContain("All rights reserved");
  });

  it("利用条件の所在が示され、それが実在するページである", () => {
    const other = metadata.other as Record<string, unknown> | undefined;
    const url = String(other?.["rights-standard"]);
    expect(url).toBe("/terms");
    // 意味的 URL → 実ルートの対応表に無いと 404 になる（リンク切れの明示を防ぐ）
    expect(ROUTE_MAP.some(([clean]) => clean === url)).toBe(true);
  });

  it("検索索引付けは既定で止めたまま", () => {
    expect(metadata.robots).toMatchObject({ index: false, follow: false });
  });
});

describe("GAP-204 AI 学習用の収集を拒否する意思表示", () => {
  const rules = robots().rules as Array<{
    userAgent?: string | string[];
    disallow?: string | string[];
  }>;

  it("主要な学習クローラを名指しで全面拒否している", () => {
    for (const bot of ["GPTBot", "ClaudeBot", "CCBot", "Google-Extended", "PerplexityBot"]) {
      const rule = rules.find((r) => r.userAgent === bot);
      expect(rule, `${bot} の指定が無い`).toBeDefined();
      expect(rule?.disallow).toBe("/");
    }
  });

  it("アプリ本体のパスは全クローラに対して拒否している", () => {
    const all = rules.find((r) => r.userAgent === "*");
    expect(all).toBeDefined();
    expect(all?.disallow).toContain("/api/");
    expect(all?.disallow).toContain("/chat/");
  });

  it("公開ページ（規約・プライバシー）まで巻き添えで塞いでいない", () => {
    // 拒否の意思は示すが、規約自体が読めなくなるのは本末転倒。
    const all = rules.find((r) => r.userAgent === "*");
    const disallow = (all?.disallow ?? []) as string[];
    expect(disallow.some((p) => "/terms".startsWith(p))).toBe(false);
    expect(disallow.some((p) => "/privacy".startsWith(p))).toBe(false);
  });
});
