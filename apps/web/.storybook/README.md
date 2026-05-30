# Storybook (T-I-20 / 任意・Phase 5+)

Atelier の Web UI コンポーネントを個別カタログ化するための Storybook 設定 + stories。

## 現状ステータス(正直な開示)

| 項目 | 状態 |
|---|---|
| 依存 (storybook 8.4 + @storybook/nextjs + addon-essentials + addon-a11y) | ✅ package.json 追加済 |
| 設定 (main.ts / preview.ts) | ✅ 配置済、tsc 0 errors |
| stories (Avatar / Skeleton / Dialog / DataTable) | ✅ 実装済、tsc + lint clean |
| `storybook build` (静的書き出し) | ⚠️ **未対応** — 下記の既知問題 |

### 既知の build 問題

`@storybook/nextjs@8` の webpack5 builder が **Next.js 15 の bundled webpack** と
衝突し、`SB_BUILDER-WEBPACK5_0002 (reading 'tap' of undefined)` で preview build が
失敗する。これは Storybook 8 系と Next 15 / React 19 の組み合わせの既知の非互換。

**対処の選択肢 (Phase 5+ で対応):**
- Storybook 9 系へ上げる(Next 15 対応が進んでいる)
- vite builder (`@storybook/experimental-nextjs-vite`) へ切替
- `storybook dev` (HMR) はローカル開発確認に使える場合がある

T-I-20 は tickets.json でも **「任意・Phase 5+」** と明記されているため、本 PR では
stories + 設定までを scope とし、CI での静的 build は Phase 5+ に持ち越す。

## ローカル開発での起動 (HMR)

```bash
pnpm -F @atelier/web exec storybook dev -p 6006
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
T-I-10 の E2E axe scan と連動して a11y 漏れを 2 段階で塞ぐ。
