-- T-D-99ZO: oauth_accounts — GAP-020 (S-A01 OAuth サインイン) のアカウント連付けテーブル
--
-- 信頼源: docs/gap-tracker.md#GAP-020
--   「OAuth 認可フロー (プロバイダ登録・コールバック・アカウント連付け) の API + ボタン配線」
-- 役割: OAuth プロバイダ (google / github) の provider_user_id と public.users を
--   1:N で連付ける。callback 時に
--     1. (provider, provider_user_id) 一致 → 当該 user でログイン
--     2. email 一致の既存 user → 本テーブルに行を追加して連付け
--     3. どちらも無し → 新規 user 作成 + 行追加
--   の順に解決する (apps/api/src/services/auth/oauth.py)。
--
-- RLS: 本人のみ SELECT 可。INSERT/UPDATE/DELETE の policy は置かない (default deny)。
--   書き込みはサーバー (service_role 相当 session, RLS バイパス) のみが行う。
--
-- Idempotency: create-table-if-not-exists / drop-policy-if-exists → create。

begin;

create table if not exists public.oauth_accounts (
  id                uuid primary key default gen_random_uuid(),
  user_id           uuid not null references public.users(id) on delete cascade,
  provider          text not null,
  provider_user_id  text not null,
  email             text not null,
  created_at        timestamptz not null default now(),
  constraint oauth_accounts_provider_valid check (provider in ('google', 'github')),
  constraint oauth_accounts_provider_uid_key unique (provider, provider_user_id)
);

create index if not exists idx_oauth_accounts_user on public.oauth_accounts (user_id);
create index if not exists idx_oauth_accounts_email on public.oauth_accounts (email);

alter table public.oauth_accounts enable row level security;

drop policy if exists oauth_accounts_select_self on public.oauth_accounts;

-- SELECT: 本人のみ (連付け済プロバイダの一覧表示用)
create policy oauth_accounts_select_self on public.oauth_accounts
  for select
  to authenticated
  using (auth.uid() = user_id);

-- INSERT/UPDATE/DELETE: policy なし = default deny。
-- 連付け・作成はサーバーの service session (RLS バイパス) のみが実行する。

commit;
