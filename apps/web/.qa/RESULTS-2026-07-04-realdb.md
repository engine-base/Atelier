# 実DB検証 実行記録（human-grade-qa full / 2026-07-04）

## 実行環境（証拠）
- Docker Desktop 起動 → `supabase db start`（supabase_db_atelier **healthy**, 127.0.0.1:54322）
- migration は CLI 命名規則（`<timestamp>_name.sql`）不一致で skip されるため、**CI Gate #10 と同方式**で
  `ls supabase/migrations/*.sql | sort` の全 **34本を psql で手動適用 → 全成功**（public 25テーブル）
- 接続: `ATELIER_TEST_PG_URL=postgresql+asyncpg://supabase_admin:postgres@127.0.0.1:54322/postgres`
  （`postgres` ユーザだと supabase イメージで `auth.users` の owner でなく 18 ERROR → superuser で解消）

## 結果（実測・全 API テストスイート = 実 Postgres + RLS + JWT）
| 区分 | 件数 |
|---|---|
| **PASS** | **627** |
| FAIL | 27 |
| ERROR | 7 |

従来この 600+ 件の PG 統合/RLS テストは **ローカル/CI とも PG 不在で全 SKIP**（一度も実行されたことがない）。
今回が初の実走であり、以下の**実バグ/乖離**が初めて露見した。

## 検出した実バグ（クラス別・証拠 = 上記実走の DB エラー）
1. **migration 欠落（zero-state 型 / P0）**: `public.mcp_tokens`・`public.byok_api_keys` の **DDL がリポジトリに一切存在しない**。
   → MCP トークン・BYOK キー機能は fresh 環境にデプロイ不能（test_mcp_tokens ×6 / test_byok_keys ×6 / rls t-i-06,08 が該当）。
2. **RLS ↔ INSERT 乖離（systemic class / P1）**: `cron_schedules` への insert が
   `new row violates row-level security policy` （test_cron ×5）。RLS policy と service/fixture の書込前提が不一致。
3. **CHECK 制約 ↔ fixture 乖離（P1）**: `knowledge_nodes_scope_owner_consistency` 違反
   （test_knowledge_scope_tree ×7）。scope/owner の整合仕様とテストデータが乖離。
4. その他: rls t-i-05/07, t-d-36_vault, test_skills, test_chat_sse, test_auth 各1（多くは 1〜3 の波及）。

## 未実施のまま残るもの（正直な内訳）
- ブラウザ実操作（Chrome での 393 TC 実走）: **planned のまま**。web+API 同時起動と storage
  （`supabase start` の storage コンテナ unhealthy）が未解決のため。
- G3 実副作用（S-M01 の実 storage/Whisper）: storage 未起動のため **BLOCKED**。

## 環境への副作用（開示）
- port 54322 競合のため **Build-Factory プロジェクトのローカル supabase を停止**した
  （データは docker volume にバックアップ済み。該当プロジェクトの dir で `supabase start` すれば復元）。
- `supabase_db_atelier` は起動したまま（再検証用）。停止は `supabase stop`。
