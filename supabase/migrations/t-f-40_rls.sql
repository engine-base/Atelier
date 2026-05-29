-- =============================================================================
-- T-F-40: knowledge_nodes scope=employee_specific 細粒度 RLS (R-T08 / 将来用)
-- =============================================================================
-- 信頼源: 04_functional_breakdown/entities.json#E-018
-- 関連: F-K01 (Knowledge Base), R-T08 (致命級 cross-tenant 分離)
-- 依存: T-D-18 (knowledge_nodes RLS + user_can_see_knowledge_node), T-D-22 (R-T08)
-- 承認: R-T08 経営者承認済として実装 (越境試験 PASS 必須)
--
-- 背景:
--   T-D-18 の user_can_see_knowledge_node() は scope を区別せず
--   「account_type=workspace なら workspace member 全員可視」とする。
--   employee_specific は本来「特定 ai_employee 専用 knowledge」であり、
--   将来的に finer-grained 制御 (社員アサイン単位) が必要になる。
--
-- 本 migration が追加する細粒度ヘルパ:
--   user_can_see_employee_specific_knowledge_node(account_type, account_id, owner_employee_id)
--     - scope=common 相当 (owner_employee_id IS NULL): 既存と同じ
--       (account_type=user は self / workspace は member)
--     - scope=employee_specific (owner_employee_id NOT NULL):
--         workspace member であり、かつ当該 ai_employee が
--         同一 workspace に属し archived=false であること
--
-- R-T08 不変条件: workspace A の user は workspace B の employee_specific
--   knowledge を一切閲覧できない (cross-tenant = 0 rows)。本ヘルパは
--   workspace membership を必ず経由するため、越境は構造的に 0。
--
-- 「将来用」方針: 既存 SELECT policy (T-D-18) を壊さないため、本 migration は
--   ヘルパ関数の追加 + employee_specific を厳格化した SELECT policy への
--   置換のみ行う (common の可視性は不変)。
-- =============================================================================

begin;

-- -----------------------------------------------------------------------------
-- 細粒度ヘルパ (SECURITY DEFINER で循環参照回避)
-- -----------------------------------------------------------------------------
create or replace function public.user_can_see_employee_specific_knowledge_node(
  p_account_type text,
  p_account_id uuid,
  p_owner_employee_id uuid
)
returns boolean
language plpgsql
security definer
stable
set search_path = public, pg_catalog
as $$
begin
  -- common (owner_employee_id IS NULL) は既存ロジックに委譲
  if p_owner_employee_id is null then
    return public.user_can_see_knowledge_node(p_account_type, p_account_id);
  end if;

  -- employee_specific (AC: owner_employee に紐づかない member は不可視):
  --   1) まず account scope (user=self / workspace=member) を満たすこと
  --   2) かつ owner ai_employee の属する workspace で現ユーザーが
  --      role='owner' であること (regular member は 0 rows / R-T08 越境も 0)
  --      archived=true の ai_employee は誰からも不可視。
  if not public.user_can_see_knowledge_node(p_account_type, p_account_id) then
    return false;
  end if;

  return exists (
    select 1
    from public.ai_employees e
    join public.workspace_memberships m
      on m.workspace_id = e.workspace_id
    where e.id = p_owner_employee_id
      and e.archived = false
      and m.user_id = auth.uid()
      and m.role = 'owner'
  );
end;
$$;

comment on function public.user_can_see_employee_specific_knowledge_node(text, uuid, uuid) is
  'T-F-40: knowledge_node の細粒度可視判定。employee_specific は owner ai_employee の
   workspace member でかつ employee が archived でない場合のみ可視。
   common は user_can_see_knowledge_node に委譲。R-T08 cross-tenant 分離を保証。';

revoke all on function
  public.user_can_see_employee_specific_knowledge_node(text, uuid, uuid)
  from public;
grant execute on function
  public.user_can_see_employee_specific_knowledge_node(text, uuid, uuid)
  to authenticated;

-- -----------------------------------------------------------------------------
-- SELECT policy を細粒度版に置換
-- -----------------------------------------------------------------------------
drop policy if exists knowledge_nodes_select on public.knowledge_nodes;

create policy knowledge_nodes_select on public.knowledge_nodes
  for select
  to authenticated
  using (
    public.user_can_see_employee_specific_knowledge_node(
      account_type::text, account_id, owner_employee_id
    )
  );

commit;
