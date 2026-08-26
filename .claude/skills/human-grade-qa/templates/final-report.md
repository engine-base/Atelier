# QA Final Report — <project>

- 日付: <YYYY-MM-DD>
- モード: <full / diff / feature / regression>
- 実行: human-grade-qa skill (Claude)
- 関連 PR: #NN / コミット <sha>
- 環境: dev (localhost) / staging / production

## エグゼクティブサマリ（3 行）

- 全 X ケース実行、PASS Y / FAIL Z / SKIP W
- ブロッキング: <件数>（マージ不可）
- ヒト依頼: <件数>

## 結果ダッシュボード

| 機能 | 計画 | PASS | FAIL | SKIP | 状態 |
|---|---|---|---|---|---|
| F-01 認証 | 12 | 12 | 0 | 0 | ✅ |
| F-02 カリキュラム作成 | 18 | 16 | 2 | 0 | ⚠ |
| F-03 AI チャット | 9 | 7 | 0 | 2 | ✅ |

## カテゴリ別カバレッジ

| カテゴリ | 計画 | 実行 | PASS 率 |
|---|---|---|---|
| 正常 | n | n | 100% |
| 異常 | n | n | xx% |
| バリデーション | n | n | xx% |
| 境界 | n | n | xx% |
| 権限 | n | n | xx% |
| 復帰 | n | n | xx% |

## 失敗一覧

### B-01 [P0] <短い名前>

- 機能: F-02
- 重要度: BLOCKER
- 再現:
  1. ...
  2. ...
- 期待: ...
- 実際: ...
- スクショ: `runs/.../screenshots/f02-blocker-01.jpg`
- 根本原因仮説: `src/.../foo.ts:42` で xxx
- 回避策: ユーザ側では XX することで一旦回避可能
- 修正提案: yyy

### B-02 [P1] ...

## ヒト依頼

| ID | 内容 | 依頼テキスト |
|---|---|---|
| H-01 | 実機 iPhone Touch ID | 実機で /login → 指紋でログイン成功するか確認お願いします |

## 既知の制約 / 未実施

- 時間切れにより F-04 admin 分はスキップ
- 物理デバイス依存 1 件は次回

## 推奨アクション

- [ ] B-01 を修正 → 再走
- [ ] 計画書を `.qa/plans/` に commit
- [ ] CI に Playwright 化したケースを追加（候補: TC-01, TC-07）

## 添付

- 計画書: `.qa/plans/<plan>.md`
- 実行ログ: `.qa/runs/<run>/`
- スクショ: `.qa/runs/<run>/screenshots/`
- 失敗一覧: `.qa/runs/<run>/failures.md`
