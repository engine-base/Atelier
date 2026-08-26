# Diff Mode — 差分フォーカス QA

`git diff origin/main...HEAD` から影響範囲を算出し、その範囲だけを QA する。
PR レビュー前 / 機能追加直後の高速 QA に使う。

## アルゴリズム

```
1. 直接変更ファイル抽出
   git diff --name-only origin/main...HEAD

2. ファイル種別で振り分け
   - UI (src/components, src/pages, app/*)
   - API (server/, routes/, handlers/, ai_service/)
   - DB (migrations/, schema, prisma)
   - 共通 lib (utils, hooks, types)
   - テスト (tests/, e2e/)
   - 設定 (.env.example, vite.config, next.config)

3. 上り側依存（参照元）を辿る
   - 変更 UI コンポーネントの import 元
   - 変更 API ルートの呼び出し元
   - 変更 lib の利用箇所
   各種ファイルに対して grep を 2 段階まで辿る

4. 影響範囲を機能単位にロールアップ
   - ルート（URL）レベルでまとめる
   - 例: `src/pages/CurriculumDemoPage.tsx` 変更 → 機能「カリキュラム作成」
```

## スクリプト

`scripts/diff_impact.sh` を使う。出力例:

```
=== Direct ===
src/pages/CurriculumDemoPage.tsx
src/features/curriculum/api/curriculumApiClient.ts
functions/postgresHybridApi/curriculum/annualCurriculumRepository.js

=== Importers (1 hop) ===
src/features/ai/curriculum/CurriculumAIPanel.tsx
src/pages/ManagementPage/index.tsx

=== Importers (2 hop) ===
src/App.tsx
src/router.tsx

=== Affected Routes ===
/management/curriculum-demo

=== Affected APIs ===
POST /api/curriculum/annual
GET /api/curriculum/annual/:id

=== Affected DB ===
annual_curricula
sessions

=== Affected Features (rolled up) ===
F-02 年度カリキュラム作成
F-03 AI チャット（curriculum scope）
```

## 計画書の書き方

- Full モードと同じ `templates/test-plan.md` を使う
- セクション「対象スコープ」に diff サマリを貼る
- 機能インデックスは Affected Features に絞る
- カバレッジは:
  - 影響を直接受ける機能 → 正常 + 異常 + バリデーション + 境界
  - 隣接機能 → 正常系 1 件のみ（regression smoke）

## 「直接変更されていないが壊れやすい」セット

diff にあがっていなくても、以下は変更があれば必ずスモークを走らせる:

- 認証（middleware が壊れると全機能壊滅）
- 共通 lib（utils, date, money, format）
- DB マイグレーション（追加カラム / 制約変更）
- 環境変数（`.env.example` キー追加）

## 出力

`.qa/plans/<date>-diff-<sha-short>.md` に保存。
ファイル名でどの commit に対する QA か分かるようにする。

## diff から自動生成する FAIL シナリオ

過去に同じファイルで起きた FAIL を `runs/*/failures.md` から拾い、同じシナリオを再走する。
これにより「直したつもりの古いバグ」のリグレッションを検出。

## 制約

- 完全な network/JS の参照解析はしない（ヒューリスティック）
- 動的 import や reflection は捕まえられないので、計画書に「不確実：手動で隣接機能を 1 件選んで smoke」を明記
- DB マイグレーションの downstream 影響（クエリの返り型変化）は SQL grep に依存
