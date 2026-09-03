import type { Metadata } from "next";
import type { ReactNode } from "react";
import { Noto_Sans_JP } from "next/font/google";

import { ConditionalAppShell } from "../components/layout/ConditionalAppShell";
import { ErrorBoundary } from "../components/ErrorBoundary";
import { GlobalErrorReporter } from "../components/GlobalErrorReporter";
import "./globals.css";

/** GAP-204: 権利者表示。契約主体と一致させること。 */
const COPYRIGHT_HOLDER = "ENGINE BASE";
/** 利用条件の所在 (規約 第9条 知的財産権 / 第10条 秘密情報)。 */
const TERMS_URL = "/terms";

// モック(_shared/atelier.css)は Noto Sans JP を Google Fonts から読み込む。
// 実装はフォント宣言のみで実体を読み込んでおらず system font にフォールバックしていたため、
// タイポグラフィがモックと別物になっていた (F-VIS: フォント未ロード)。next/font で実ロードする。
const notoSansJP = Noto_Sans_JP({
  subsets: ["latin"],
  weight: ["400", "500", "600", "700", "900"],
  variable: "--font-noto",
  display: "swap",
});

export const metadata: Metadata = {
  title: {
    default: "Atelier",
    template: "%s | Atelier",
  },
  description: "AI 社員常駐型プロジェクト管理 SaaS",
  robots: {
    index: false,
    follow: false,
  },
  // GAP-204: 著作権と利用条件を **配る HTML 自体に** 明記する。
  //
  // 技術的な事実として、ブラウザへ届いた HTML/CSS は必ず読める。見た目の模倣を
  // 技術で止めることはできない。止められないぶん、**誰の著作物で、どういう
  // 条件で使えるのかを明示**しておき、法的に戦える状態にする
  // (規約側の実体は利用規約 第9条・第10条 — supabase/migrations/gap-204_*)。
  other: {
    // GAP-312: 本番 web がどの commit のビルドかを機械で読めるようにする
    // (通し R2 で「Vercel の配信が main より古い」をバンドルの推定でしか言えなかった)。
    // Vercel はビルド時に VERCEL_GIT_COMMIT_SHA を渡す。ローカルは dev。
    "atelier-build": (
      process.env.NEXT_PUBLIC_VERCEL_GIT_COMMIT_SHA ??
      process.env.VERCEL_GIT_COMMIT_SHA ??
      "dev"
    ).slice(0, 12),
    copyright: `© ${COPYRIGHT_HOLDER} All rights reserved.`,
    "rights-standard": TERMS_URL,
  },
};

interface RootLayoutProps {
  children: ReactNode;
}

export default function RootLayout({ children }: RootLayoutProps) {
  return (
    <html lang="ja" className={notoSansJP.variable}>
      <body>
        {/* GAP-182: 画面が壊れたら自前のエラーログに記録する (外部 SaaS へは送らない)。
            以前は ErrorBoundary がどこからも使われておらず、白画面が誰にも届かなかった。 */}
        <ErrorBoundary>
          {/* GAP-297: 描画エラー以外 (イベント / 非同期 / 未処理の Promise) も記録する */}
          <GlobalErrorReporter />
          <ConditionalAppShell>{children}</ConditionalAppShell>
        </ErrorBoundary>
      </body>
    </html>
  );
}
