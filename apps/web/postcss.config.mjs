/**
 * Tailwind CSS + autoprefixer pipeline.
 *
 * config パスは指定しない。Tailwind が apps/web/tailwind.config.ts を自動検出する。
 * (旧: `config: '../../tailwind.config.ts'` は Vercel ビルドで解決失敗し、空の
 *  デフォルト設定にフォールバック → CSS が preflight のみになるバグの原因だった)
 */
export default {
  plugins: {
    tailwindcss: {},
    autoprefixer: {},
  },
};
