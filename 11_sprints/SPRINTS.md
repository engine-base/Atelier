# Atelier Sprint 計画書（v3.1-dual / 6 Sprint）

- 信頼源: [`sprints.json`](./sprints.json)
- HTML 版（バーンダウン + トグル）: [`SPRINTS.html`](./SPRINTS.html)
- 上流: [`../08_schedule/SCHEDULE.html`](../08_schedule/SCHEDULE.html) / [`../09_dispatch/PACKAGES.html`](../09_dispatch/PACKAGES.html)

## サマリ

| 指標 | Human-baseline | AI-accelerated |
|---|---:|---:|
| Sprint 数 | 6 | 6 |
| タスク総数 | 190 | 190 |
| 総工数 | 1328.0 h | – |
| AI compute | – | 123.7 h |
| Wall-clock 並列 | – | 27.9 h |
| カレンダー | ~240 営業日 | **15 営業日** |

## Atelier 固有の Sprint 設計（標準と異なる）

| 項目 | 標準 SaaS | **Atelier 採用** |
|---|---|---|
| Sprint 長 | 2 週間 | **1 Wave = 2-4 日** |
| ベロシティ単位 | Story Points | **wall_clock_h_ai** |
| デイリースタンドアップ | 15 分 × 5 日 | **無し**（S-E01 4h サマリ自動投稿） |
| プランニング | 4-8h | **15 分** |
| レトロ | 2h | **10 分**（vision 自動レポート） |
| バーンダウン | 紙/Jira | **HTML 自動更新** |

## 6 Sprint 詳細

### 🏗 S0 (Wave 0) — Foundation

- **期間**: 2026-05-20 → 2026-05-21 (2 営業日)
- **並列度**: 5 / 実行: `parallel`
- **タスク**: 28 件 / **AI compute**: 18.6h / **Wall-clock**: 6.72h
- **Human review**: 3.0h ★ / **Blocking**: 4 件

| 担当 | 件数 | AI h | 主タスク |
|---|---:|---:|---|
| **tony** | 19 | 13.73 | T-F-01, T-F-02, T-F-03, T-F-04, T-F-06 ...+14 |
| **vision** | 4 | 2.3 | T-F-18, T-F-23, T-F-24, T-F-26 |
| **strange** | 2 | 0.67 | T-F-05, T-F-19 |
| **wanda** | 2 | 1.2 | T-F-09, T-F-16 |
| **tchalla** | 1 | 0.67 | T-F-14 |

**KPI 目標**: 完了率 100% / CI gate PASS 95% / retry < 1.5 / escalation ≤ 2

### 🗃 S1 (Wave 1) — Data Layer

- **期間**: 2026-05-22 → 2026-05-25 (2 営業日)
- **並列度**: 8 / 実行: `parallel`
- **タスク**: 35 件 / **AI compute**: 17.8h / **Wall-clock**: 5.53h
- **Human review**: 3.3h ★ / **Blocking**: 1 件

| 担当 | 件数 | AI h | 主タスク |
|---|---:|---:|---|
| **strange** | 30 | 15.01 | T-D-01, T-D-02, T-D-03, T-D-04, T-D-05 ...+25 |
| **vision** | 5 | 2.8 | T-D-31, T-D-32, T-D-33, T-D-34, T-D-35 |

**KPI 目標**: 完了率 100% / CI gate PASS 95% / retry < 1.2 / escalation ≤ 1

### 🔒 S2 (Wave 2) — API Layer 🔒

- **期間**: 2026-05-26 → 2026-05-27 (2 営業日)
- **並列度**: 10 / 実行: `parallel`
- **タスク**: 45 件 / **AI compute**: 26.6h / **Wall-clock**: 4.66h
- **Human review**: 2.0h ★ / **Blocking**: 1 件

| 担当 | 件数 | AI h | 主タスク |
|---|---:|---:|---|
| **thor** | 35 | 19.2 | T-A-01, T-A-02, T-A-03, T-A-04, T-A-05 ...+30 |
| **tony** | 4 | 3.54 | T-A-28, T-A-29, T-A-40, T-A-45 |
| **strange** | 2 | 1.25 | T-A-13, T-A-23 |
| **tchalla** | 2 | 1.41 | T-A-36, T-A-37 |
| **steve** | 2 | 1.17 | T-A-38, T-A-39 |

**KPI 目標**: 完了率 100% / CI gate PASS 90% / retry < 2.0 / escalation ≤ 3

### 🎨 S3 (Wave 3) — UI Foundation

- **期間**: 2026-05-28 → 2026-05-29 (2 営業日)
- **並列度**: 5 / 実行: `parallel`
- **タスク**: 18 件 / **AI compute**: 9.6h / **Wall-clock**: 2.42h
- **Human review**: 0.5h ★ / **Blocking**: 1 件

| 担当 | 件数 | AI h | 主タスク |
|---|---:|---:|---|
| **wanda** | 16 | 8.4 | T-US-01, T-US-02, T-US-05, T-US-06, T-US-07 ...+11 |
| **thor** | 1 | 0.6 | T-US-03 |
| **tony** | 1 | 0.6 | T-US-04 |

**KPI 目標**: 完了率 100% / CI gate PASS 95% / retry < 1.0 / escalation ≤ 1

### ⚡ S4 (Wave 4) — UI Parallel

- **期間**: 2026-06-01 → 2026-06-03 (3 営業日)
- **並列度**: 10 / 実行: `parallel`
- **タスク**: 40 件 / **AI compute**: 36.8h / **Wall-clock**: 3.68h
- **Human review**: 0.0h / **Blocking**: 0 件

| 担当 | 件数 | AI h | 主タスク |
|---|---:|---:|---|
| **thor** | 32 | 31.5 | T-UC-01, T-UC-02, T-UC-03, T-UC-04, T-UC-05 ...+27 |
| **wanda** | 8 | 5.3 | T-UC-06, T-UC-07, T-UC-09, T-UC-35, T-UC-36 ...+3 |

**KPI 目標**: 完了率 100% / CI gate PASS 85% / retry < 2.5 / escalation ≤ 5

### 🚀 S5 (Wave 5) — Integration 🚀

- **期間**: 2026-06-04 → 2026-06-09 (4 営業日)
- **並列度**: 5 / 実行: `sequential`
- **タスク**: 24 件 / **AI compute**: 14.4h / **Wall-clock**: 4.88h
- **Human review**: 2.0h ★ / **Blocking**: 0 件

| 担当 | 件数 | AI h | 主タスク |
|---|---:|---:|---|
| **vision** | 17 | 11.5 | T-I-01, T-I-02, T-I-03, T-I-04, T-I-05 ...+12 |
| **tony** | 6 | 2.37 | T-I-11, T-I-12, T-I-19, T-I-21, T-I-22 ...+1 |
| **wanda** | 1 | 0.53 | T-I-20 |

**KPI 目標**: 完了率 100% / CI gate PASS 95% / retry < 1.5 / escalation ≤ 3

## バーンダウン（営業日別累計）

| Day | 日付 | Sprint | 完了 | 残り | AI h 消化 | AI h 残 |
|---:|---|---|---:|---:|---:|---:|
| D1 | 2026-05-20 水 | S0 | 0 | 190 | 0 | 123.7 |
| D2 | 2026-05-21 木 | S0 | 28 | 162 | 18.6 | 105.1 |
| D3 | 2026-05-22 金 | S1 | 28 | 162 | 18.6 | 105.1 |
| D4 | 2026-05-25 月 | S1 | 63 | 127 | 36.4 | 87.3 |
| D5 | 2026-05-26 火 | S2 | 63 | 127 | 36.4 | 87.3 |
| D6 | 2026-05-27 水 | S2 | 108 | 82 | 63.0 | 60.7 |
| D7 | 2026-05-28 木 | S3 | 108 | 82 | 63.0 | 60.7 |
| D8 | 2026-05-29 金 | S3 | 126 | 64 | 72.6 | 51.1 |
| D9 | 2026-06-01 月 | S4 | 126 | 64 | 72.6 | 51.1 |
| D10 | 2026-06-02 火 | S4 | 145 | 45 | 92.4 | 31.3 |
| D11 | 2026-06-03 水 | S4 | 166 | 24 | 104.8 | 18.9 |
| D12 | 2026-06-04 木 | S5 | 166 | 24 | 109.4 | 14.3 |
| D13 | 2026-06-05 金 | S5 | 173 | 17 | 113.9 | 9.8 |
| D14 | 2026-06-08 月 | S5 | 178 | 12 | 117.4 | 6.3 |
| D15 | 2026-06-09 火 | S5 | 184 | 6 | 121.5 | 2.2 |
| D16 | 2026-06-10 水 | 🚀 | 190 | 0 | 123.7 | 0.0 |

## セレモニー設計（軽量・AI 自走前提）

### Sprint Kick（15 分 / Wave 開始時）

- Bridge dispatcher 起動確認 (tony 自動)
- ブランチ規則確認 + audit MD template 一括生成
- file-mutex 衝突予測の表示
- 致命級タスクある場合 経営者承認
- dispatcher.json 配下のパッケージを Wave スコープに並列投入

### Sprint Close（10 分 / Wave 終了時）

- Wave 完了率 (merged PR / total) 自動算出
- CI gate 失敗履歴のレトロ (vision 自動レポート)
- 次 Wave 解禁条件チェック (Phase Gate 機械判定)
- 経営者 1 クリック確認 or vision 自動進行

### Sprint 中（無人運用）

- vision が **S-E01 チャット**に進捗サマリを **4h ごと**自動投稿
- 失敗 3 連続 → human-escalation 通知 → 経営者介入
- それ以外は完全自走

## 失敗ハンドリング

| トリガー | アクション |
|---|---|
| CI gate 3 連続失敗 | S-E01 + needs-human-review label |
| Wave 内 3 task 以上失敗 | Wave 一時停止 + 緊急レトロ |
| blocking task 失敗 | 経営者通知 + Wave 全停止 |
| critical gate 失敗 (R-T08 / 契約凍結) | 経営者承認待ち |

## ベロシティ計算（参考）

```
Velocity (AI mode) = Σ(estimate_hours_ai) / wall_clock_days

S0: 18.6 / 2 = 9.3 h/day （並列 5 で実 1.86 h/day）
S1: 17.8 / 2 = 8.9 h/day （並列 8 で実 1.11 h/day）
S2: 26.6 / 2 = 13.3 h/day （並列 10 で実 1.33 h/day）
S3: 9.6 / 2 = 4.8 h/day （並列 5 で実 0.96 h/day）
S4: 36.8 / 3 = 12.3 h/day （並列 10 で実 1.23 h/day）
S5: 14.4 / 4 = 3.6 h/day （並列 5 で実 0.72 h/day）
```