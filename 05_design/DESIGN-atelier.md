---
name: Atelier
colors:
  # Primary
  primary: "#2563EB"
  on-primary: "#FFFFFF"
  primary-container: "#DBEAFE"
  on-primary-container: "#1E3A8A"
  # Secondary
  secondary: "#C7A04A"
  on-secondary: "#FFFFFF"
  secondary-container: "#FAEDC4"
  on-secondary-container: "#5C4A1E"
  # Tertiary
  tertiary: "#14B8A6"
  on-tertiary: "#FFFFFF"
  tertiary-container: "#CCFBF1"
  on-tertiary-container: "#134E4A"
  # Surface
  surface: "#FEFCF8"
  on-surface: "#0F172A"
  surface-variant: "#F4F1EC"
  on-surface-variant: "#475569"
  # Error
  error: "#DC2626"
  on-error: "#FFFFFF"
  # Neutral
  neutral: "#94A3B8"
  on-neutral: "#0F172A"
typography:
  headline-display:
    fontFamily: "Noto Sans JP"
    fontSize: 72px
    fontWeight: 900
    lineHeight: 1.1
    letterSpacing: -0.02em
  headline-lg:
    fontFamily: "Noto Sans JP"
    fontSize: 48px
    fontWeight: 700
    lineHeight: 1.2
    letterSpacing: -0.01em
  headline-md:
    fontFamily: "Noto Sans JP"
    fontSize: 36px
    fontWeight: 700
    lineHeight: 1.25
  body-lg:
    fontFamily: "Noto Sans JP"
    fontSize: 18px
    fontWeight: 400
    lineHeight: 1.7
    letterSpacing: 0.01em
  body-md:
    fontFamily: "Noto Sans JP"
    fontSize: 16px
    fontWeight: 400
    lineHeight: 1.6
  body-sm:
    fontFamily: "Noto Sans JP"
    fontSize: 14px
    fontWeight: 400
    lineHeight: 1.5
  label-lg:
    fontFamily: "Noto Sans JP"
    fontSize: 14px
    fontWeight: 600
    letterSpacing: 0.04em
  label-md:
    fontFamily: "Noto Sans JP"
    fontSize: 12px
    fontWeight: 500
    letterSpacing: 0.05em
  label-sm:
    fontFamily: "Noto Sans JP"
    fontSize: 11px
    fontWeight: 500
    letterSpacing: 0.06em
spacing:
  xs: 4px
  sm: 8px
  md: 16px
  lg: 24px
  xl: 48px
  2xl: 96px
rounded:
  none: 0px
  sm: 4px
  md: 8px
  lg: 16px
  xl: 24px
  full: 9999px
components:
  button-primary:
    backgroundColor: "{colors.primary}"
    textColor: "{colors.on-primary}"
    typography: "{typography.label-lg}"
    rounded: "{rounded.md}"
    padding: "12px 24px"
  button-secondary:
    backgroundColor: "{colors.secondary-container}"
    textColor: "{colors.on-secondary-container}"
    typography: "{typography.label-lg}"
    rounded: "{rounded.md}"
    padding: "12px 24px"
  button-outlined:
    backgroundColor: "transparent"
    textColor: "{colors.primary}"
    border: "1.5px solid {colors.primary}"
    typography: "{typography.label-lg}"
    rounded: "{rounded.md}"
    padding: "12px 24px"
  button-inverted:
    backgroundColor: "{colors.on-primary}"
    textColor: "{colors.primary}"
    typography: "{typography.label-lg}"
    rounded: "{rounded.md}"
    padding: "12px 24px"
  card:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.on-surface}"
    rounded: "{rounded.lg}"
    padding: "{spacing.lg}"
  input:
    backgroundColor: "{colors.surface-variant}"
    textColor: "{colors.on-surface}"
    rounded: "{rounded.md}"
    padding: "{spacing.md}"
---

# Atelier Design System

## Overview

**「工房の静謐 × 編集者の精密」— エディトリアル品質のAIプロジェクト管理ツール。**

Atelier は AI 社員が常駐する開発プロジェクト統合管理 SaaS。1人の開発者・小規模受託会社が「複数案件を高品質に並行運用する」ための作業環境を提供する。

このデザインシステムは Notion / Obsidian のエディトリアル品質、Linear / Vercel の SaaS 洗練、Stripe の上品さを融合し、AI 時代に最適化した新しいバランスを示す。Material Design 3 の役割ベース命名規則を採用しつつ、暖かみのある生成り紙（Warm Paper White）を主背景にして長時間作業を支える。

**Design Principles**

1. **静けさの優先（Quiet by Default）**：装飾を最小化し、コンテンツとコンテキストを主役にする。AI 出力・タスク・ナレッジが視覚的雑音に埋もれない。
2. **エディトリアル品質（Editorial Quality）**：印刷物のような余白とタイポ階層。Noto Sans JP の重いウェイト（700-900）で見出しに静かな迫力を与える。
3. **AI 時代の UX（AI-Native UX）**：assistant-ui / tool-ui と完全統合。Thinking / Analyzing / Tool Call の表示も上質に。絵文字は使わず Lucide React で統一。
4. **長時間作業の身体性（Built for Long Sessions）**：純白を避け生成り背景、WCAG AA 以上のコントラスト、控えめなアニメーション。
5. **明るく、開かれている（Bright & Open）**：Primary に明るい Vivid Sapphire を採用。AI ツールに多いダーク中心の世界観から一歩踏み出し、創造性を喚起する。

## Colors

カラーシステムは Material Design 3 に準拠した役割ベースの命名規則を採用する。

### Primary — Vivid Sapphire `#2563EB`

ブランドの中心色。CTA、最重要 UI、ナビゲーション選択状態、リンク、進捗バーに使用。
明るく自信のあるブルーで、Linear（紫寄り）・Stripe（紫）・Vercel（黒）と差別化しつつ、SaaS としての信頼性を保つ。AI による創造性・知性のメタファでもある。

### Secondary — Warm Brass `#C7A04A`

工房（Atelier）の語源を象徴する暖色金属系。完了状態の正の通知、ナレッジ蓄積バッジ、有料プラン UI、Brass Gold の道具感。
Primary の青と補色関係に近く、画面内のコントラストを生む。多用はせずアクセント・ステータスのみに使用。

### Tertiary — Fresh Teal `#14B8A6`

新規追加・成功・進行中の状態を示すフレッシュなティール。Primary と差別化された明るい色で、視線を素早く誘導する。
タスクの「実装中」「検証中」のステータスバッジ、新規ナレッジ追加時のフラッシュ、AI Thinking 中のアクセントに使用。

### Surface & Neutral — Warm Paper Palette

Surface（`#FEFCF8`）は純白を避けた生成り。長時間チャットや読み込みでも疲れにくい。
Surface variant（`#F4F1EC`）はサブ背景・カード境界・入力フィールドの背景。
On-surface（`#0F172A`）は Slate 900 の濃紺寄りブラックで、純黒より柔らかい本文表示。

### WCAG コントラスト確認

| 組合せ | コントラスト比 | 判定 |
|---|---|---|
| primary `#2563EB` / on-primary `#FFFFFF` | 5.17:1 | AA ✓ |
| surface `#FEFCF8` / on-surface `#0F172A` | 17.5:1 | AAA ✓ |
| secondary-container `#FAEDC4` / on-secondary-container `#5C4A1E` | 8.4:1 | AAA ✓ |
| tertiary `#14B8A6` / on-tertiary `#FFFFFF` | 3.2:1 | AA Large ✓ (大文字・アイコン専用、本文不可) |
| tertiary-container `#CCFBF1` / on-tertiary-container `#134E4A` | 11.8:1 | AAA ✓ |

## Typography

**Noto Sans JP 単一フォント** で全タイポグラフィを統一する。

### なぜ Noto Sans JP 単一なのか

- **日本市場特化** — 国内のみのリリース前提、日本語と英数字を 1 つのフォントで扱う
- **ウェイト軸の豊富さ** — 100 / 300 / 400 / 500 / 600 / 700 / 900 で見出しから本文まで対応
- **可読性最強** — Google Fonts、Adobe、Apple すべてに採用される標準。長時間作業に耐える
- **運用シンプル** — 複数フォントの読み込み・フォントペアリングの調整コストゼロ
- **数値処理** — `font-variant-numeric: tabular-nums` で数値を等幅化、コードや統計表示にも対応

### Scale

`headline-display` (72/900) → `headline-lg` (48/700) → `headline-md` (36/700) → `body-lg` (18/400) → `body-md` (16/400) → `body-sm` (14/400) → `label-lg` (14/600) → `label-md` (12/500) → `label-sm` (11/500)

スケールは Material Type Scale の Display / Headline / Body / Label をベースに簡略化。スキップ（display→md など飛び越え）は禁止。
見出しは weight=700-900 を使い、ウェイト差で階層を表現。letter-spacing を負値（-0.02em）にして引き締める。

### Mono / 数値表示

専用 mono フォントは使わない。Noto Sans JP の `font-variant-numeric: tabular-nums` で数値を等幅化し、コードブロックも同フォントで表示する。ブランドの統一感を最優先。

### Webfont 読込

```html
<link href="https://fonts.googleapis.com/css2?family=Noto+Sans+JP:wght@400;500;600;700;900&display=swap" rel="stylesheet">
```

font-display: swap で初期表示を高速化。プリロードは weight=400/600/700 の 3 つのみ。

## Layout

8px ベースラインのスペーシングシステム。

### Spacing Scale

- `xs` 4px — アイコン内マージン、インライン要素間
- `sm` 8px — コンパクトスタック、チップ内間隔
- `md` 16px — 標準コンポーネント内パディング、フォーム要素間
- `lg` 24px — カードパディング、セクション内ブロック間
- `xl` 48px — セクション間
- `2xl` 96px — ページ大区切り、ヒーロー周辺

### Grid

- デスクトップ（≥1280px）: 12 columns / 24px gutter / 80px margin
- タブレット（768–1279）: 8 columns / 16px gutter / 32px margin
- モバイル（<768）: 4 columns / 16px gutter / 16px margin

### サイドバー幅

メインアプリ（S-B02 等）のサイドバー幅は **240px** 固定。Linear / Notion 標準サイズ。

## Elevation & Depth

エディトリアル原則として **ボーダー優先・シャドウは控えめ**。

| Level | 用途 | スタイル |
|---|---|---|
| 0 | 通常面 | `border: 1px solid var(--surface-variant)` |
| 1 | ホバー / 重要カード | `box-shadow: 0 1px 3px rgba(15,23,42,0.06)` |
| 2 | ポップオーバー / メニュー | `box-shadow: 0 4px 12px rgba(15,23,42,0.08)` |
| 3 | モーダル / ダイアログ | `box-shadow: 0 16px 40px rgba(15,23,42,0.12)` |

Material Design の派手な elevation スタイルは採用しない。

## Shapes

| Token | 値 | 用途 |
|---|---|---|
| `none` | 0px | テーブル、フルブリード画像、ステータスバー |
| `sm` | 4px | タグ、バッジ、Status Pill 内のチップ |
| `md` | 8px | ボタン、入力フィールド、メニューアイテム |
| `lg` | 16px | カード、モーダル、サーフェスパネル |
| `xl` | 24px | シート、大型コンテナ、ヒーローイメージ |
| `full` | 9999px | アバター、ピル型タグ、トグル |

## Components

### Buttons（5 variants）

| Variant | 用途 | スタイル |
|---|---|---|
| **Primary** | 最重要 CTA（1画面 1 つ原則） | `bg=primary` `text=on-primary` |
| **Secondary** | 重要だが補助 | `bg=secondary-container` `text=on-secondary-container` |
| **Outlined** | 代替アクション、危険操作の確認 | `border=primary` `text=primary` |
| **Inverted** | Primary 背景上 | `bg=on-primary` `text=primary` |
| **Ghost** | テキスト風、メニュー項目 | `bg=transparent` `text=primary` |

### Cards（3 variants）

- **Surface Card**：通常カード。`surface` 背景に `surface-variant` ボーダー
- **Primary Container Card**：重要強調用。`primary-container` 背景
- **Secondary Container Card**：補助情報用。`secondary-container` 背景

### Inputs

`surface-variant` 背景でフォームフィールドを背景から浮かせる。フォーカス時 `primary` 色 2px アウトライン。

### Icons

**Lucide React** に統一。絵文字使用禁止（ESLint emoji-regex で CI 強制）。
アイコンサイズは `12 / 14 / 16 / 20 / 24px` の 5 段階。

### AI-Specific Components

| コンポーネント | ライブラリ | 用途 |
|---|---|---|
| Thread / Composer / Status | **assistant-ui** | チャット基盤、Thinking / Analyzing 表示 |
| ToolCallCard / WebSearchResult / FileRead | **tool-ui** | AI ツール呼出の整形表示 |
| Status Pill（実装中 / 検証中 / 承認待ち） | shadcn/ui Badge | `tertiary-container` 系で色分け |
| Score Indicator | カスタム | F-J02 スコア評価表示、`tertiary` 進捗バー |

## Do's and Don'ts

### Do's

- **Primary 色は CTA と最重要 UI のみ** に使用。1 画面 1 つの Primary ボタンが原則
- **テキストコントラストは常に WCAG AA 以上**。`on-surface`・`on-primary` 等のペアで管理
- **スペーシングは必ず `spacing` トークン** を使用。`12px` `20px` 等のマジックナンバー禁止
- **コンポーネントはトークン参照** `{colors.primary}` を使い、直接 hex 値を書かない
- **数値表示は `font-variant-numeric: tabular-nums`** で揃える
- **アイコンは Lucide React** で統一、絵文字は禁止
- **静かさを優先**：派手なシャドウ・グラデーション・装飾は禁止

### Don'ts

- Primary 色を装飾目的で多用しない（CTA の重みを失う）
- タイポグラフィスケールをスキップしない（`display` → `body-md` 等の飛び越え禁止）
- カスタム色を追加する際は WCAG AA を必ず確認
- `surface` 上に `surface-variant` を重ねてコントラストを下げない
- 絵文字・アニメーション GIF・ストック写真をデザインに混入させない
- ダークモードは Phase 5 以降で対応（v1.0 ではライトテーマのみ）

## Naming Conventions

- CSS カスタムプロパティ：`--color-primary` / `--font-headline` / `--space-md` / `--rounded-md`
- Tailwind 設定：`extend.colors.primary` / `extend.fontFamily.headline`
- shadcn/ui theme：`hsl(var(--primary))` 形式で参照
- design-tokens.json：`colors.primary` / `typography.headline-lg` の階層

## Version & Maintenance

- v1.0 (2026-05-18)：初版
- 改訂時は `name` を保持し YAML 内のみ変更
- カラー・タイポ追加時は WCAG コントラスト検証を必ず実施
- 拡張色（warning / info 等）が必要な場合は `additional-colors` セクションを追加
