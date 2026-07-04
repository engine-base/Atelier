-- T-D-95: byok_api_keys (E-022) — テーブル + self RLS + encrypted_key 列保護
--
-- 信頼源: 04_functional_breakdown/entities.json#E-022 (user_scoped)
-- 背景: 実DB検証 (apps/web/.qa/RESULTS-2026-07-04-realdb.md) で本テーブルの DDL が
--   リポジトリに存在しないことが発覚 (routes/services/tests は実装済み)。
-- 列は apps/api/src/services/byok_keys/__init__.py の SELECT/INSERT から逆算。
-- セキュリティ (rls t-i-08 の意図):
--   - 行: user_id = auth.uid() の self のみ (R-T06)
--   - 列: encrypted_key は authenticated から SELECT 不可 (列レベル権限)。
--     service 層の _COLS も encrypted_key を返さない。復号はバックエンド (service_role)。
--
-- Idempotency: create if not exists / drop policy if exists → create / grant は再実行安全。

begin;

create table if not exists public.byok_api_keys (
  id             uuid primary key,
  user_id        uuid not null references public.users(id) on delete cascade,
  provider       text not null,
  encrypted_key  text not null,
  key_label      text,
  is_active      boolean not null default true,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);

create index if not exists idx_byok_api_keys_user on public.byok_api_keys (user_id);

alter table public.byok_api_keys enable row level security;

drop policy if exists byok_api_keys_select_self on public.byok_api_keys;
drop policy if exists byok_api_keys_insert_self on public.byok_api_keys;
drop policy if exists byok_api_keys_update_self on public.byok_api_keys;
drop policy if exists byok_api_keys_delete_self on public.byok_api_keys;

create policy byok_api_keys_select_self on public.byok_api_keys
  for select to authenticated
  using (user_id = auth.uid());

create policy byok_api_keys_insert_self on public.byok_api_keys
  for insert to authenticated
  with check (user_id = auth.uid());

create policy byok_api_keys_update_self on public.byok_api_keys
  for update to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

create policy byok_api_keys_delete_self on public.byok_api_keys
  for delete to authenticated
  using (user_id = auth.uid());

-- 列レベル保護: encrypted_key は authenticated/anon から SELECT 不可。
-- (INSERT/UPDATE は全列可 = service が暗号文を書き込む。RETURNING id は id の SELECT 権限で賄う)
revoke select on public.byok_api_keys from authenticated, anon;
grant select (id, user_id, provider, key_label, is_active, created_at, updated_at)
  on public.byok_api_keys to authenticated;

commit;
