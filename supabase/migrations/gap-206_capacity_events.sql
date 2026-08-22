-- GAP-206: 混雑（順番待ち・お断り）が起きたことを **machine をまたいで**残す。
--
-- GAP-203 で順番待ちを入れたが、その数字は **プロセス内のカウンタ**なので
-- machine ごとに別々。cron は 1 台でしか動かないため、そのままでは
-- 「もう 1 台で起きた混雑」に気づけない。
--
-- 混雑はそもそも稀（上限に達したときだけ）なので、**起きた瞬間に 1 行書く**。
-- ホットパスではないため書き込み負荷は問題にならない。

begin;

create table if not exists public.capacity_events (
  id            uuid primary key default gen_random_uuid(),
  occurred_at   timestamptz not null default now(),
  -- queued  … 上限に達して順番待ちが発生した
  -- rejected… 列も一杯 / 待たせすぎで断った
  kind          text not null check (kind in ('queued', 'rejected')),
  -- どの machine で起きたか (Fly の FLY_MACHINE_ID。無ければ 'local')
  machine_id    text not null default 'local',
  open_streams  integer not null,
  stream_limit  integer not null,
  queued        integer not null,
  queue_limit   integer not null,
  detail        text
);

comment on table public.capacity_events is
  'GAP-206: 混雑が起きた記録。cron がこれを見て通知する (machine をまたいで集計)。';

create index if not exists capacity_events_occurred_idx
  on public.capacity_events (occurred_at desc);

-- 運営専用。利用者からは一切見えない (policy を作らない = default deny)。
alter table public.capacity_events enable row level security;

-- 通知の重複を防ぐための状態 (kind ごとに 1 行)
create table if not exists public.capacity_alert_state (
  kind             text primary key check (kind in ('queued', 'rejected')),
  last_notified_at timestamptz,
  notified_count   integer not null default 0,
  last_status      text not null default 'pending'
                   check (last_status in ('pending', 'sent', 'failed', 'skipped')),
  last_detail      text
);

comment on table public.capacity_alert_state is
  'GAP-206: 混雑通知の送信状態。失敗したら last_notified_at を進めない (次回再試行)。';

alter table public.capacity_alert_state enable row level security;

commit;
