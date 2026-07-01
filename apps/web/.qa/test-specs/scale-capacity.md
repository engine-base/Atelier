# 負荷・スケール・容量（少データ/1ユーザーでは検出不能・必須軸）

> 実行は実DB+負荷ツールが必要。本環境は PG 無しのため **BLOCKED**（planned）。前提と閾値を定義。

## スケール前提（見積）
| 指標 | 初期 | 1年 | 3年 |
|---|---|---|---|
| ワークスペース(テナント) | 10 | 200 | 1,000 |
| 1WS当たり project | 5 | 20 | 50 |
| 1project当たり task | 50 | 300 | 1,000 |
| ピーク同時実行 | 20 | 200 | 1,000 |

## 検証項目
| # | 観点 | 項目 | 閾値/期待 | 結果 |
|---|---|---|---|---|
| L-001 | データ量 | tasks 100万行で S-I01 ボード/一覧 | 全件ロードせずページング、p95<800ms | BLOCKED |
| L-002 | 検索 | GET /search を大量データで | ILIKE が index/pg_trgm で seq scan 回避、p95<1s | BLOCKED |
| L-003 | 集計 | S-B02 dashboard の task_counts | N+1 無し・集計=実数、p95<600ms | BLOCKED |
| L-004 | 並行 | 主要GETを200並列 | エラー率<1%、p95<1s | BLOCKED |
| L-005 | EXPLAIN | 重経路(tasks一覧/search)の EXPLAIN ANALYZE | seq scan 無し・index 使用 | BLOCKED |
| L-006 | 上限 | 招待/添付/レート上限に到達 | 超過で明示4xx（500/破損にしない） | BLOCKED |
| L-007 | 規模整合 | 大量並行作成後 RLS分離/集計=count(*) | 越境0・数値一致 | BLOCKED |

解除条件: 実DBへ generate_series でN倍シード→k6/autocannon で並行負荷→p95/エラー率/EXPLAIN を実測 assert。
