import type { MetadataRoute } from "next";

/**
 * GAP-204: クローラと AI 学習に対する意思表示。
 *
 * **正直に書いておく限界**: robots.txt に強制力はありません。無視するクローラは
 * 無視します。これは「技術的に防ぐ仕組み」ではなく、**「拒否の意思を明示した」
 * という記録**です。規約 第9条4項（機械学習の学習データとしての利用の禁止）と
 * 対になっていて、後から争うときの根拠になります。
 *
 * 本サービスはログインしないと中身が見えないため、そもそもクローラが取得できる
 * のは公開ページ（トップ・規約・プライバシー）だけです。それらも索引付け自体を
 * 止める必要はないので、**AI の学習用収集だけを名指しで拒否**し、アプリ本体の
 * パスは全クローラに対して拒否します。
 */

/** 学習用データ収集を行うと公表されている主なクローラ。 */
const AI_TRAINING_CRAWLERS = [
  "GPTBot",
  "ClaudeBot",
  "Claude-Web",
  "anthropic-ai",
  "CCBot",
  "Google-Extended",
  "Applebot-Extended",
  "PerplexityBot",
  "Bytespider",
  "Amazonbot",
  "FacebookBot",
  "Meta-ExternalAgent",
  "cohere-ai",
  "Diffbot",
  "omgili",
];

/** 未ログインでは見られないアプリ本体（そもそも取れないが、意思として書く）。 */
const APP_PATHS = ["/api/", "/admin/", "/chat/", "/projects/", "/outputs/", "/templates/"];

export default function robots(): MetadataRoute.Robots {
  return {
    rules: [
      { userAgent: "*", disallow: APP_PATHS },
      // 学習用の収集は全面的に拒否する（規約 第9条4項と対）。
      ...AI_TRAINING_CRAWLERS.map((userAgent) => ({ userAgent, disallow: "/" })),
    ],
  };
}
