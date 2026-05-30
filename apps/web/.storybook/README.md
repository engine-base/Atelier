# Storybook (T-I-20)

Atelier の Web UI コンポーネントを個別カタログ化するための Storybook 設定。

## 起動

```bash
pnpm -F @atelier/web exec storybook dev -p 6006
```

ただし現状は **設定ファイルのみ** であり、storybook 本体 / addon は依存に
追加していない (Phase 5+ で本格化)。実起動には以下が必要:

```bash
pnpm -F @atelier/web add -D storybook @storybook/nextjs \
  @storybook/addon-essentials @storybook/addon-a11y \
  @storybook/addon-interactions
```

## stories の場所

- `apps/web/components/**/*.stories.@(ts|tsx|mdx)`
- `apps/web/app/**/*.stories.@(ts|tsx|mdx)`

Bundle B/C で作ったコンポーネント (AppShell / Sidebar / TopBar / Picker /
Dialog / Toast / Avatar / EmployeeIcon / DataTable / Pagination / Form / Field /
Skeleton / Loading / Notifications) を順次 stories 化する想定。

## a11y addon

`@storybook/addon-a11y` で各 story の WCAG 2.2 AA 違反を即時検出。
T-I-10 の E2E axe scan と連動して a11y 漏れを 2 段階で塞ぐ。
