import type { Config } from 'tailwindcss';

import rootConfig from '../../tailwind.config';

/**
 * apps/web 専用 Tailwind 設定。
 *
 * Next.js が apps/web を project root として **自動検出** する正準位置に置く
 * (postcss.config.mjs が `tailwindcss: {}` を使うことで Tailwind 本体が
 * ここを読み込む)。content グロブは本ファイル (apps/web) からの相対で解決される
 * ため、CWD やビルド環境 (ローカル / Vercel) に依存せず常に正しくマッチする。
 *
 * 旧構成: postcss が `config: '../../tailwind.config.ts'` という CWD 相対の文字列
 * パスで root config を参照していたが、Vercel ビルドではこの解決に失敗して
 * Tailwind が空のデフォルト設定にフォールバック → 全 utility / token が消え
 * preflight(9KB)のみになっていた (= 画面が無装飾)。本ファイルで解消する。
 *
 * theme / plugins などは root config から継承し、content だけを apps/web 基準に
 * 上書きする (theme の二重管理を避ける)。
 */
const config: Config = {
  ...rootConfig,
  content: [
    './app/**/*.{ts,tsx,mdx}',
    './components/**/*.{ts,tsx,mdx}',
    '../../packages/**/src/**/*.{ts,tsx}',
  ],
};

export default config;
