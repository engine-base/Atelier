-- 運営 (platform admin) 専用テーブルの RLS 意図を明文化する deny ポリシー。
--
-- admin_goals / beta_feedback / acquisition_records / admin_costs は
-- workspace scope に乗らない運営データで、アクセス経路は
-- 「route の is_admin ゲート + service session (RLS bypass)」のみ
-- (src/services/admin/ops.py docstring 参照)。
--
-- これまで「RLS 有効 + policy 0 件」= 実質 deny-all で安全だったが、
-- 意図がスキーマ上から読めず Gate #10 (RLS policy presence audit) も
-- 「policy 無し」として fail する。authenticated への明示 deny を置いて
-- 「アクセス不可はバグではなく設計」であることをスキーマに固定する。
-- 挙動変更なし (deny-all → deny-all)。
--
-- Idempotency: drop policy if exists → create。

drop policy if exists admin_goals_platform_admin_only on public.admin_goals;
create policy admin_goals_platform_admin_only on public.admin_goals
  for all to authenticated using (false) with check (false);
comment on policy admin_goals_platform_admin_only on public.admin_goals is
  '運営専用: is_admin ゲート + service session 経由のみ。直接アクセスは設計として deny';

drop policy if exists beta_feedback_platform_admin_only on public.beta_feedback;
create policy beta_feedback_platform_admin_only on public.beta_feedback
  for all to authenticated using (false) with check (false);
comment on policy beta_feedback_platform_admin_only on public.beta_feedback is
  '運営専用: is_admin ゲート + service session 経由のみ。直接アクセスは設計として deny';

drop policy if exists acquisition_records_platform_admin_only on public.acquisition_records;
create policy acquisition_records_platform_admin_only on public.acquisition_records
  for all to authenticated using (false) with check (false);
comment on policy acquisition_records_platform_admin_only on public.acquisition_records is
  '運営専用: is_admin ゲート + service session 経由のみ。直接アクセスは設計として deny';

drop policy if exists admin_costs_platform_admin_only on public.admin_costs;
create policy admin_costs_platform_admin_only on public.admin_costs
  for all to authenticated using (false) with check (false);
comment on policy admin_costs_platform_admin_only on public.admin_costs is
  '運営専用: is_admin ゲート + service session 経由のみ。直接アクセスは設計として deny';
