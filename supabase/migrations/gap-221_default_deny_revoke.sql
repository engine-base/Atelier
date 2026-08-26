-- GAP-221: default deny の表から、アプリ用ロールの権限を明示的に外す。
--
-- 対象は「policy を 1 本も置かない = 通常経路からは一切読ませない」と決めた表。
-- RLS が有効で policy が 0 本なら SELECT/INSERT/UPDATE/DELETE は行が 0 件になるので
-- 実害は無い……**ただし TRUNCATE だけは RLS の対象外**で、権限さえあれば通る。
--
-- 実測 (2026-08-26):
--   一般利用者のロールで
--     select count(*) from public.error_log  → 0 行 (RLS が効いている)
--     truncate table public.error_log        → **通ってしまい、全行が消えた**
--   運営のエラー履歴・外形監視・混雑の実績が、サインインした人なら誰でも消せる。
--
-- 本番 (Supabase) の既定 grant は select/insert/update/delete までで TRUNCATE を
-- 含まないため、**本番に穴は空いていない**。空いていたのは `scripts/dev-bootstrap.sh`
-- が `grant all on all tables` を流すローカル開発環境。とはいえ「既定に助けられて
-- いるだけ」の状態なので、表の側でも明示的に閉じる (同じ migration で
-- artifact_files / mock_contents が既にやっているのと揃える)。
--
-- 冪等: revoke は何度流しても安全。
--
-- 注意: `grant all on all tables in schema public to authenticated` のような一括
-- GRANT を後から流すと、この revoke は打ち消される (GAP-172 の実例)。
-- dev-bootstrap.sh は revoke を含む migration を GRANT の後にもう一度流している。

begin;

revoke all on public.error_log from anon, authenticated;
revoke all on public.error_alerts from anon, authenticated;
revoke all on public.uptime_checks from anon, authenticated;
revoke all on public.capacity_events from anon, authenticated;
revoke all on public.capacity_alert_state from anon, authenticated;
revoke all on public.knowledge_curations from anon, authenticated;

commit;
