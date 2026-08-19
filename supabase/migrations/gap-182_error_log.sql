-- GAP-182: 自前のエラーログ (Sentry を使わない選択の実体)。
--
-- 経営者判断 (2026-08-19):
--   「B で進めて」= Sentry.io (外部 SaaS) にエラーを送らず、自分たちのインフラに貯める。
--
-- これまでの実態: apps/api/src/observability/sentry.py と apps/web/lib/sentry.client.ts に
-- 初期化コードだけがあり、(a) main.py から一度も呼ばれず (b) SDK も入っていなかった。
-- つまり **本番でエラーが起きても誰も気づけない**状態だった (docs には「Sentry EU 接続済」
-- と書かれていたが事実ではない)。
--
-- 設計:
--   - 外部送信ゼロ。Fly.io の API と同じ Supabase に貯める。
--   - テナントから直接は読めない (RLS で authenticated に select を与えない)。
--     運営 admin だけが service 経路 (/admin/errors) で読む。
--   - insert も service_role のみ。利用者がログを汚染・偽装できない。
--   - fingerprint で同種をまとめ、件数を数えられるようにする。

create table if not exists public.error_log (
  id           uuid primary key default gen_random_uuid(),
  occurred_at  timestamptz not null default now(),
  source       text not null check (source in ('api', 'web', 'worker')),
  level        text not null default 'error' check (level in ('error', 'warning')),
  kind         text not null,
  message      text not null,
  path         text,
  method       text,
  status_code  integer,
  user_id      uuid references public.users(id) on delete set null,
  fingerprint  text not null,
  stack        text,
  context      jsonb not null default '{}'::jsonb
);

comment on table public.error_log is
  'GAP-182: 自前のエラー記録。外部 SaaS (Sentry) へは送らない。運営 admin のみ閲覧可。';
comment on column public.error_log.fingerprint is
  '同種エラーをまとめる key (source|kind|path|先頭スタックフレーム の hash)。';
comment on column public.error_log.stack is
  '秘匿値 (token/key/authorization) を除去したスタックトレース。';

create index if not exists error_log_occurred_idx
  on public.error_log (occurred_at desc);
create index if not exists error_log_fingerprint_idx
  on public.error_log (fingerprint, occurred_at desc);

alter table public.error_log enable row level security;

-- policy を 1 つも作らない = authenticated からは select も insert もできない。
-- 記録と閲覧は service_role (service セッション + admin gate) 経由のみ。
