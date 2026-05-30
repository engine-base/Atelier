# Storybook (T-I-20)

Atelier の Web UI コンポーネントを個別カタログ化するための Storybook 設定 + stories。

## 現状ステータス

| 項目 | 状態 |
|---|---|
| 依存 (storybook 10 + @storybook/nextjs-vite + addon-docs + addon-a11y) | ✅ package.json 追加済 |
| 設定 (main.ts / preview.ts) | ✅ 配置済、tsc 0 errors |
| stories (Avatar / Skeleton / Dialog / DataTable) | ✅ 実装済、tsc + lint clean |
| `storybook build` (静的書き出し) | ✅ **動作確認済** (vite builder で build 成功) |

## Builder の経緯 (T-I-20 補強で解決)

当初は `@storybook/nextjs@8` の webpack5 builder を使ったが、Next.js 15 の
bundled webpack と衝突し `SB_BUILDER-WEBPACK5_0002 (reading 'tap' of undefined)`
で build 不能だった。

次に `@storybook/experimental-nextjs-vite@8.6` を試したが、依存している
`vite-plugin-storybook-nextjs@1.x` が Next 14 の internal path
(`next/dist/build/webpack/plugins/define-env-plugin.js`) を require していて
Next 15 で消えており、これも build 不能。

最終的に **Storybook 10 系の `@storybook/nextjs-vite`** に移行した。
これは `vite-plugin-storybook-nextjs@3.x` を使い Next 15 + React 19 で動作する。
ローカルで `storybook build` 成功確認済 (12 stories, vite 11.69s)。

## ローカル開発での起動 (HMR)

```bash
pnpm -F @atelier/web exec storybook dev -p 6006
```

## 静的 build

```bash
pnpm -F @atelier/web exec storybook build
# → apps/web/storybook-static/ に出力 (index.html, iframe.html, assets/)
```

## stories の場所

- `apps/web/components/**/*.stories.@(ts|tsx|mdx)` — 現状 4 stories
  (Avatar / Skeleton / ui/dialog / data-table/DataTable)
- `apps/web/app/**/*.stories.@(ts|tsx|mdx)` — 今後追加

今後 Bundle B/C の他コンポーネント (AppShell / Sidebar / TopBar / Picker /
Toast / EmployeeIcon / Pagination / Form / Field / Loading / Notifications) も
順次 stories 化する。

## a11y addon

`@storybook/addon-a11y` で各 story の WCAG 2.2 AA 違反を即時検出。
T-I-10 の E2E axe scan (39 routes 0 violations 実証済) と連動して
a11y 漏れを 2 段階で塞ぐ。
