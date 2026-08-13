# @atelier/email

Atelier のメールテンプレート (React Email)。**静的 HTML を `dist/` に書き出し**、
`apps/api` の送信処理がそれを読む。

## ビルド

```bash
pnpm --filter @atelier/email build
# → packages/email/dist/<template>.html
```

`src/templates/*.tsx` の各テンプレートが `dist/<name>.html` になる。

### なぜ `email export` で、`email build` ではないのか

`react-email` の CLI は用途の違う 2 コマンドを持つ (v3.0.7 で確認):

| コマンド | 何をするか | オプション |
|---|---|---|
| `email build` | **プレビューアプリ**を `.react-email` にビルドする | `-d, --dir` のみ |
| `email export` | **テンプレートを静的 HTML に書き出す** | `--outDir` / `-d, --dir` / `--pretty` ほか |

このパッケージが必要としているのは後者。`email build --src … --outDir …` は
`--src` が存在しないオプションのため `error: unknown option '--src'` で落ち、
**ルートの `pnpm build` を赤いままにしていた** (GAP-115 / T-F-47)。

## テンプレートを追加するとき

`src/templates/` に `.tsx` を置くだけでビルド対象になる。ただし 1 点だけ注意:

```tsx
import * as React from 'react';   // ← 必須
```

このパッケージの `tsconfig.json` は `"jsx": "preserve"` で、react-email のバンドラが
**classic ランタイム** (`React.createElement`) にトランスパイルする。React を
**値として** import していないと、レンダリング時に

```
✖ failed when rendering <name>.cjs
ReferenceError: React is not defined
```

で落ちる。`import type { ReactElement } from 'react'` は型 import なので実行時に
消える — 値の import とは別に必要。

## 消費側

`apps/api/src/email/templates/resolve_template_html(name)` が
`packages/email/dist/<name>.html` を読む。ビルド前に呼ぶと `FileNotFoundError` になる。

## スクリプト

| script | 用途 |
|---|---|
| `build` | `dist/*.html` を生成 (上記) |
| `dev` | プレビューサーバ (`http://localhost:3001`) |
| `lint` / `type-check` | ESLint / tsc |
| `clean` | `dist` と `.email` を削除 |
