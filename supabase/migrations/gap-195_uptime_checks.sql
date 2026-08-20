-- GAP-195: 外形監視 (uptime) — サーバーが完全に落ちたことを記録する。
--
-- これまでの実態:
--   エラーは自前の error_log に貯めていた (GAP-182/194) が、**サーバー自体が
--   落ちたら自分ではログを書けない**。落ちている間は記録も通知も残らず、
--   復旧後に「いつからいつまで落ちていたか」を答えられなかった。
--
-- 設計:
--   運営インフラ (Fly.io) の外側 = GitHub Actions から 15 分ごとに /health と
--   画面を叩き、結果を **API を経由せず直接 Supabase へ** 書く。
--   API が落ちていても記録が残る (API 経由にすると落ちた時に記録できない)。
--
--   Supabase まで落ちた場合はここにも残らないが、その場合は GitHub Actions の
--   実行自体が失敗し、Slack / メール通知は DB を使わない経路で飛ぶ。

create table if not exists public.uptime_checks (
  id           uuid primary key default gen_random_uuid(),
  target       text not null,
  checked_at   timestamptz not null default now(),
  ok           boolean not null,
  status_code  integer,
  latency_ms   integer,
  error        text,
  --  この結果で通知を出したか (状態が変わった時と、落ちたままの定期リマインドのみ)
  notified     boolean not null default false
);

comment on table public.uptime_checks is
  'GAP-195: 外形監視の結果。運営インフラの外側 (GitHub Actions) から直接書き込む。';
comment on column public.uptime_checks.target is
  '監視対象の名前 (api / web など)。ATELIER_UPTIME_TARGETS で定義する。';
comment on column public.uptime_checks.notified is
  '状態が変わった (落ちた / 復旧した) か、落ちたままのリマインドで通知した場合に true。';

create index if not exists uptime_checks_target_idx
  on public.uptime_checks (target, checked_at desc);

alter table public.uptime_checks enable row level security;
-- policy を 1 つも作らない = authenticated からは読めない。運営 admin (service 経路) のみ。
