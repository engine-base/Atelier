# モック忠実性・導線・実操作（単体/契約テストの死角）

## I4-S 到達性・nav配線（★ブラウザ/DB不要・実施済）
- nav href ⇔ 実ルート 静的突合を実行 → **死リンク 1件検出（S-B01 → /projects/${id}/dashboard[404]）→ 修正(#245)→ 再スイープ 0**。
- 全42ルートに孤立(nav未配線)は無し（全画面はTopBar/AppShell/直リンクから到達可能）。
- 証拠: gen 差分スクリプト出力（DEAD:0）。

## モック要素照合（各画面 ⇔ 06_mockups/<dir>/<S-XX>.html）
- 対象モック 36枚が subdir に実在。主要画面のボタン/タブ/フォーム/列/セクションを要素照合。
- **既知の意図的差分（honest）**: S-G01 座標ピン→一覧+追加、mock/output 本文→iframe(署名URL)、cron即時実行/招待再送/WS削除ボタン非表示(API欠如)。
- 視覚忠実度 段1: token値=DESIGN-atelier.md 一致（primary#2563EB/surface#FEFCF8/on-surface#0F172A/error#DC2626）、ハードコード色0（実施済）。

## 全操作要素の実クリック / 主要書込の貫通
- 全ボタン/タブ/トグル/select の実操作、create→別GET再取得→DB突合、CSV(該当画面)のDL→記入→アップロード。
- **実行は実DB/実UI(ブラウザ)が必要 → BLOCKED（planned）**。項目は screens/*.md の各インタラクション/更新TCに定義済。
