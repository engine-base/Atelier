-- T-A-54: workspace 作成時の AI 社員 自動ブートストラップ (製品ギャップ #27)
--
-- 信頼源: ai_employees の docstring「固定 10 名/WS」設計 + seed/t-d-24.sql (運営固定テンプレ)
-- 背景:
--   新規 workspace には AI 社員が 0 で、AI 社員を作成する API/フローが無いため、
--   chat thread に必要な ai_employee_id を得られず新規ユーザーがチャットを開始できなかった
--   (本番実機検証 prod-smoke PS-22 で判明 = ギャップ #27)。
--   owner membership と同じ SECURITY DEFINER トリガで、workspaces INSERT 時に
--   運営固定テンプレ (ai_employee_templates.is_active) から社員を実体化する。
--   テンプレが未シードなら 0 行 (graceful) — seed 適用後の新規 workspace から有効。
--
-- Idempotency: create or replace function + トリガ存在チェック。
--   同一 workspace への二重挿入は (workspace_id, name) 相当の重複を on conflict do nothing で回避。

begin;

create or replace function public.bootstrap_workspace_ai_employees()
returns trigger
language plpgsql
security definer
set search_path = public, pg_catalog
as $$
begin
  insert into public.ai_employees (
    workspace_id, template_id, name, display_name, icon,
    role, department, attached_skills, attached_knowledge_cats,
    system_prompt_override, is_default
  )
  select
    new.id, t.id, t.default_name, t.default_display_name, t.default_icon,
    t.role, t.department, t.default_skills, t.default_knowledge_cats,
    t.system_prompt, true
  from public.ai_employee_templates t
  where t.is_active = true
  on conflict do nothing;
  return new;
end;
$$;

comment on function public.bootstrap_workspace_ai_employees() is
  'workspaces INSERT 時に運営固定テンプレ (is_active) から AI 社員を実体化する (ギャップ#27)。';

do $$
begin
  if not exists (
    select 1 from pg_trigger where tgname = 'workspaces_bootstrap_ai_employees'
  ) then
    create trigger workspaces_bootstrap_ai_employees
      after insert on public.workspaces
      for each row execute function public.bootstrap_workspace_ai_employees();
  end if;
end $$;

commit;
