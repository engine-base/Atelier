-- T-D-99ZR: chat_plan_status — GAP-119 (Claude プラン接続の状態表示)
--
-- 信頼源: docs/gap-tracker.md#GAP-119
--   「チャット画面で、実行モード / Bridge 接続 / 本人のプラン枠 (5h・7日) を
--    確認できるようにする。取れない値は出さない (誠実設計)」
-- 出所:
--   relay 実行時に Bridge が `claude -p --output-format stream-json` の
--   rate_limit_event (utilization / resets_at — CLI が API 応答ヘッダー由来で
--   発行する実値) を complete と一緒に返送 → 本テーブルへ upsert。
--   イベントは「実行時に状態が変わったとき」しか出ないため、値は常に
--   observed_at 時点のスナップショットとして扱う (推測で補完しない)。
--
-- RLS: 本人 (user_id) のみ SELECT 可。INSERT/UPDATE/DELETE の policy は
--   置かない (default deny) — 書き込みは BridgeAuth 経由の service session のみ。
--
-- Idempotency: create-table-if-not-exists / drop-policy-if-exists → create。

begin;

create table if not exists public.chat_plan_status (
  user_id                 uuid primary key references public.users(id) on delete cascade,
  status                  text not null,
  five_hour_utilization   double precision,
  five_hour_resets_at     timestamptz,
  seven_day_utilization   double precision,
  seven_day_resets_at     timestamptz,
  observed_at             timestamptz not null default now(),
  constraint chat_plan_status_status_valid
    check (status in ('allowed', 'allowed_warning', 'rejected')),
  constraint chat_plan_status_five_hour_range
    check (five_hour_utilization is null
           or (five_hour_utilization >= 0 and five_hour_utilization <= 2)),
  constraint chat_plan_status_seven_day_range
    check (seven_day_utilization is null
           or (seven_day_utilization >= 0 and seven_day_utilization <= 2))
);

comment on table public.chat_plan_status is
  'GAP-119: 本人 Claude プラン枠の直近観測値 (Bridge が claude CLI の rate_limit_event を返送した実値のみ)';

alter table public.chat_plan_status enable row level security;

drop policy if exists chat_plan_status_select_self on public.chat_plan_status;

-- SELECT: 本人のみ (自分のプラン枠は自分にしか見せない)
create policy chat_plan_status_select_self on public.chat_plan_status
  for select
  to authenticated
  using (auth.uid() = user_id);

-- INSERT/UPDATE/DELETE: policy なし = default deny。
-- 書き込みは chat-relay complete (BridgeAuth + service session) のみ。

commit;
