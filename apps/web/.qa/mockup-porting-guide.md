# モック忠実移植ガイド (全画面共通・厳守)

各画面の「本文(メインコンテンツ)」を `06_mockups/` の該当HTMLに**忠実に**再構築する。
シェル(サイドバー/トップバー)は AppShell が共通提供済なので**触らない**。本文だけを作り込む。

## 絶対に守ること
1. **データ配線・認証・API呼び出し・props・export名・型・container/presentational 分割は一切変えない**。
   壊したら動作退行。見た目優先で working flow を壊すのは禁止。
2. 編集してよいのは**その画面の `page.tsx` と `_components/*` の JSX/className だけ**。
   `lib/` `providers/` 共有型・他画面・テストは触らない。
3. **既存の testid / role / aria-label / 主要な文言は維持**(vitest が参照)。要素を増やすのは可、
   既存の検証対象を消さない。不明ならテストを Read して確認。
4. 仕上げに **`pnpm --filter @atelier/web type-check`** が通ること。既存 vitest を壊さないこと。

## モック→トークンの対応 (色は必ずトークン, サイズ/角丸は px 一致でよい)
- ページ地色: `bg-surface`(#FEFCF8) … AppShell 提供済。本文で再指定不要。
- **カード**: モック `.card` は純白。`bg-white border border-border rounded-lg p-5`(=20px)。
  影付き `.card-elevated` → `shadow-sm`。色付きカード `.card-primary/-secondary/-tertiary` →
  `bg-primary-container text-primary-container-fg`(等) `rounded-lg p-5`。
- **本文テキスト**: 主 `text-on-surface`、**muted/補足/ラベル `text-on-surface-variant`**(#475569)。
  色付き面の上は対応する `*-container-fg`。真っ黒 hardcode 禁止。
- **見出し**: page-title→`text-3xl font-bold tracking-tight`(28px), section-title→`text-base font-bold`(16px),
  eyebrow→`text-[11px] font-bold uppercase tracking-[0.14em] text-on-surface-variant`。
- **ボタン**: primary→`bg-primary text-on-primary rounded-md px-4 py-2 text-sm font-semibold hover:bg-[#1E54D8]`、
  outlined→`border border-primary text-primary hover:bg-primary-container`、
  ghost→`text-on-surface hover:bg-surface-variant`、danger→`bg-error text-on-error`。全て hover/focus 状態を付ける。
- **badge**(角丸小): `inline-flex items-center gap-1 rounded-sm px-2 py-0.5 text-[10.5px] font-semibold`
  + 配色 `bg-*-container text-*-container-fg` / neutral=`bg-surface-variant text-on-surface-variant` /
  danger=`bg-[#FEE2E2] text-[#991B1B]`。
- **pill**(状態, 角丸full): `inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[11px] font-semibold`
  先頭に `<span>` の 6px ドット。状態色は atelier.css の `.pill-*` を踏襲
  (pending=surface-variant, in-progress/completed=tertiary系, verifying=primary系, awaiting=secondary系, blocked=error系)。
- **avatar**: `inline-flex items-center justify-center rounded-full` 32px 既定。社員色は atelier.css の `.avatar-<name>` を踏襲。
- **table**: `.table-wrap`→`border border-border rounded-lg overflow-hidden`。thead th→
  `bg-surface-variant text-[11px] font-bold uppercase tracking-wider text-on-surface-variant`。行 hover。
- **notice**: 左ボーダー3px + `bg-*-container text-*-container-fg rounded-md p-3`。
- **empty**: `py-12 text-center text-on-surface-variant`。
- 余白/グリッド: モックの `grid-2/3/4` `gap-*` `mb-*` を Tailwind 既定ユーティリティ(gap-4, grid-cols-3 等)で px 一致再現。
- 本文の外枠: モック `.content` は `max-w-[1200px]`。本文ルートに `mx-auto w-full max-w-[1200px]` を付ける。

## 手順
1. 指定された `06_mockups/<path>.html` を Read（=見た目の正）。`06_mockups/_shared/atelier.css` も参照。
2. 対象画面の `page.tsx` と `_components/*` を Read。データ/props/export を把握。
3. presentational JSX を**モックのセクション構成・順序・コンポーネント・文言・階層**通りに再構築。
   データはモックのダミー値ではなく既存の実データ/props にバインドする。
4. `type-check` を通す。完了報告に「どのセクションを再現したか」を列挙。
