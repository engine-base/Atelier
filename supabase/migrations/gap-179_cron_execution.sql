-- GAP-179: 自動実行 (cron_schedules) を実際に走らせるための最小スキーマ拡張。
--
-- 経営者指摘 (2026-08-19):
--   「スケジュールの部分だけの話ってこと？？」
--   → 画面で選べる 6 種類のうち 5 種類は実体が無く、利用者が入れた cron 式も
--     一度も使われていなかった。実行基盤 (services/cron/dispatcher.py) を入れる。
--
-- 実行できない状態 (利用者の PC が未接続 = Bridge オフライン) を "error" と
-- 書くと嘘になる。「保留 = あとで自動再試行」を表す deferred を追加する。

alter table public.cron_run_history
  drop constraint if exists cron_run_history_status_check;

alter table public.cron_run_history
  add constraint cron_run_history_status_check
  check (status in ('running', 'success', 'error', 'deferred'));

comment on column public.cron_run_history.status is
  'running / success / error / deferred (GAP-179: deferred = 今は実行できないので自動再試行する)';

comment on column public.cron_schedules.next_run_at is
  'GAP-179: 利用者の cron_expression (日本時間で解釈) から算出した次回発火時刻 (UTC)。';
