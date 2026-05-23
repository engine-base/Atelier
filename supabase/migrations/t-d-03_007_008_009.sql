-- T-D-03: skills / ai_employee_templates / ai_employees (E-009, E-008, E-007)
--
-- 信頼源: 04_functional_breakdown/entities.json
-- 関連 RLS: T-D-21 で ai_employees / templates / skills policy 配置予定
-- 依存: T-D-02 (workspaces / users 経由)
--
-- 作成順:
--   1. enums (role / department / tone_preset)
--   2. skills (E-009, global)              ← templates が default_skills uuid[] で参照
--   3. ai_employee_templates (E-008, global)
--   4. ai_employees (E-007, workspace_scoped, FK → templates)
--
-- AI 社員 10 名のシードデータは T-D-24 で別途 INSERT する (本 migration は schema のみ)。

begin;

-- =============================================================================
-- Enums (E-007 / E-008 共有)
-- =============================================================================
do $$
begin
  if not exists (select 1 from pg_type where typname = 'ai_employee_role_enum') then
    create type public.ai_employee_role_enum as enum ('coo', 'lead', 'member');
  end if;
  if not exists (select 1 from pg_type where typname = 'ai_employee_department_enum') then
    create type public.ai_employee_department_enum as enum (
      'executive', 'sales', 'product', 'architecture',
      'design', 'dev_qa', 'cross_functional'
    );
  end if;
  if not exists (select 1 from pg_type where typname = 'tone_preset_enum') then
    create type public.tone_preset_enum as enum (
      'polite', 'friendly', 'casual', 'concise', 'coaching'
    );
  end if;
end $$;

-- =============================================================================
-- E-009 skills (global, no tenant isolation)
--   - templates.default_skills uuid[] / ai_employees.attached_skills uuid[]
--     が本テーブルの id を参照 (FK は array なので RDBMS 制約は付かない、
--     アプリ層で整合性担保)
-- =============================================================================
create table if not exists public.skills (
  id                      uuid primary key default gen_random_uuid(),
  name                    text not null,
  version                 text not null,
  description             text,
  content_md              text not null,
  assets_storage_path     text,
  allowed_employee_roles  text[] not null default array[]::text[],
  allowed_employee_ids    uuid[] not null default array[]::uuid[],
  is_active               boolean not null default true,
  created_at              timestamptz not null default now(),
  updated_at              timestamptz not null default now(),
  constraint skills_version_semver
    check (version ~ '^[0-9]+\.[0-9]+\.[0-9]+(-[A-Za-z0-9.-]+)?$'),
  unique (name, version)
);

comment on table public.skills is
  'E-009 Skill — global なスキル定義 (Anthropic Skills 互換 markdown ベース)。';
comment on column public.skills.version is 'semver 形式 (例: 1.0.0, 1.2.3-beta)';
comment on column public.skills.allowed_employee_roles is
  'このスキルを attach 可能な role 集合 (coo / lead / member)';
comment on column public.skills.allowed_employee_ids is
  '特定 ai_employee 個体限定 (空 array なら無制限)';

create index if not exists skills_name_idx on public.skills (name) where is_active = true;

-- =============================================================================
-- E-008 ai_employee_templates (global, admin only)
-- =============================================================================
create table if not exists public.ai_employee_templates (
  id                      uuid primary key default gen_random_uuid(),
  default_name            text not null,
  default_display_name    text not null,
  default_icon            text,
  department              public.ai_employee_department_enum not null,
  role                    public.ai_employee_role_enum not null,
  default_skills          uuid[] not null default array[]::uuid[],
  default_knowledge_cats  text[] not null default array[]::text[],
  system_prompt           text not null,
  specialty               text not null,
  version                 integer not null default 1,
  is_active               boolean not null default true,
  created_at              timestamptz not null default now(),
  updated_at              timestamptz not null default now(),
  constraint ai_employee_templates_version_positive check (version >= 1),
  unique (default_name, version)
);

comment on table public.ai_employee_templates is
  'E-008 AiEmployeeTemplate — AI 社員テンプレ (jarvis / tony 等)。global admin only。';
comment on column public.ai_employee_templates.default_skills is
  'デフォルト attach する skill id 配列 (skills.id 参照、アプリ層で整合性確認)';

create index if not exists ai_employee_templates_active_idx
  on public.ai_employee_templates (is_active, department);

-- =============================================================================
-- E-007 ai_employees (workspace_scoped)
-- =============================================================================
create table if not exists public.ai_employees (
  id                       uuid primary key default gen_random_uuid(),
  workspace_id             uuid not null references public.workspaces(id) on delete cascade,
  template_id              uuid references public.ai_employee_templates(id) on delete set null,
  name                     text not null,
  display_name             text not null,
  icon                     text,
  role                     public.ai_employee_role_enum not null,
  department               public.ai_employee_department_enum not null,
  tone_preset              public.tone_preset_enum not null default 'polite',
  custom_tone_text         text,
  attached_skills          uuid[] not null default array[]::uuid[],
  attached_knowledge_cats  text[] not null default array[]::text[],
  system_prompt_override   text,
  is_default               boolean not null default false,
  archived                 boolean not null default false,
  created_at               timestamptz not null default now(),
  updated_at               timestamptz not null default now(),
  constraint ai_employees_custom_tone_length
    check (custom_tone_text is null or char_length(custom_tone_text) <= 500),
  unique (workspace_id, name)
);

comment on table public.ai_employees is
  'E-007 AiEmployee — workspace 配下の AI 社員インスタンス。RLS: workspace member (T-D-21)。';
comment on column public.ai_employees.template_id is
  'コピー元 template。template 削除時は SET NULL (履歴保持)';
comment on column public.ai_employees.custom_tone_text is
  'ユーザー定義 tone (最大 500 文字)。tone_preset と併用可';
comment on column public.ai_employees.system_prompt_override is 'admin only で編集可';

create index if not exists ai_employees_workspace_idx
  on public.ai_employees (workspace_id) where archived = false;
create index if not exists ai_employees_template_idx
  on public.ai_employees (template_id) where template_id is not null;

-- =============================================================================
-- updated_at トリガ (T-D-01 で定義済 set_updated_at() 再利用)
-- =============================================================================
do $$
begin
  if not exists (select 1 from pg_trigger where tgname = 'skills_set_updated_at') then
    create trigger skills_set_updated_at
      before update on public.skills
      for each row execute function public.set_updated_at();
  end if;
  if not exists (select 1 from pg_trigger where tgname = 'ai_employee_templates_set_updated_at') then
    create trigger ai_employee_templates_set_updated_at
      before update on public.ai_employee_templates
      for each row execute function public.set_updated_at();
  end if;
  if not exists (select 1 from pg_trigger where tgname = 'ai_employees_set_updated_at') then
    create trigger ai_employees_set_updated_at
      before update on public.ai_employees
      for each row execute function public.set_updated_at();
  end if;
end $$;

-- =============================================================================
-- RLS enable + default-deny (T-D-21 で実 policy に置換予定)
-- =============================================================================
alter table public.skills                 enable row level security;
alter table public.ai_employee_templates  enable row level security;
alter table public.ai_employees           enable row level security;

do $$
begin
  if not exists (select 1 from pg_policies
    where schemaname='public' and tablename='skills' and policyname='skills_default_deny'
  ) then
    create policy skills_default_deny on public.skills
      as restrictive for all to public using (false);
  end if;
  if not exists (select 1 from pg_policies
    where schemaname='public' and tablename='ai_employee_templates'
      and policyname='ai_employee_templates_default_deny'
  ) then
    create policy ai_employee_templates_default_deny on public.ai_employee_templates
      as restrictive for all to public using (false);
  end if;
  if not exists (select 1 from pg_policies
    where schemaname='public' and tablename='ai_employees' and policyname='ai_employees_default_deny'
  ) then
    create policy ai_employees_default_deny on public.ai_employees
      as restrictive for all to public using (false);
  end if;
end $$;

commit;
