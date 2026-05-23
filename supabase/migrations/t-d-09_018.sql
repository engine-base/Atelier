-- T-D-09: knowledge_nodes (E-018, pgvector 統合)
--
-- 信頼源: 04_functional_breakdown/entities.json#E-018
-- 関連: F-K01 (Knowledge Base / RAG)
-- 依存: T-D-02 (projects), T-F-14 (pgvector + voyage_embedding domain)
--
-- 設計のポイント:
--   - account_id は polymorphic (workspace_id or user_id) → FK 制約は付けず
--     account_type CHECK でアプリ層整合性を担保
--   - embedding は public.voyage_embedding (T-F-14 で配置済 domain, vector(1024))
--   - HNSW index は cosine 距離で。Wave 1 では IVFFlat ではなく HNSW を採用
--     (Postgres 15+ で標準、Supabase 17.6 で利用可)

begin;

-- =============================================================================
-- Enums
-- =============================================================================
do $$
begin
  if not exists (select 1 from pg_type where typname = 'knowledge_account_type_enum') then
    create type public.knowledge_account_type_enum as enum ('workspace', 'user');
  end if;
  if not exists (select 1 from pg_type where typname = 'knowledge_scope_enum') then
    create type public.knowledge_scope_enum as enum ('common', 'employee_specific');
  end if;
end $$;

-- =============================================================================
-- E-018 knowledge_nodes (polymorphic account, soft_delete)
-- =============================================================================
create table if not exists public.knowledge_nodes (
  id                    uuid primary key default gen_random_uuid(),
  account_id            uuid not null,
  account_type          public.knowledge_account_type_enum not null,
  scope                 public.knowledge_scope_enum not null,
  owner_employee_id     uuid references public.ai_employees(id) on delete set null,
  category              text not null,
  tags                  text[] not null default array[]::text[],
  title                 text not null,
  content_md            text not null,
  -- HNSW index は domain ではなく実 vector 型を要求するため、ここでは
  -- extensions.vector(1024) を直接使用する (voyage_embedding domain は documentation のみ)
  embedding             extensions.vector(1024),
  source_type           text not null default 'manual',
  source_project_id     uuid references public.projects(id) on delete set null,
  confidence_score      numeric(3,2) not null default 0.5,
  usage_count           integer not null default 0,
  is_anonymized         boolean not null default false,
  approved_by_user_id   uuid references public.users(id) on delete set null,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),
  deleted_at            timestamptz,

  constraint knowledge_nodes_confidence_range
    check (confidence_score >= 0 and confidence_score <= 1),

  constraint knowledge_nodes_usage_count_non_negative
    check (usage_count >= 0),

  constraint knowledge_nodes_source_type_valid
    check (source_type in ('manual', 'ai_extracted', 'import', 'mem0')),

  -- scope=employee_specific の時のみ owner_employee_id 必須、
  -- scope=common の時は owner_employee_id NULL 必須
  constraint knowledge_nodes_scope_owner_consistency
    check (
      (scope = 'employee_specific' and owner_employee_id is not null) or
      (scope = 'common' and owner_employee_id is null)
    ),

  constraint knowledge_nodes_title_length
    check (char_length(title) between 1 and 500),

  constraint knowledge_nodes_category_length
    check (char_length(category) between 1 and 100)
);

comment on table public.knowledge_nodes is
  'E-018 KnowledgeNode — RAG / Knowledge Base。polymorphic account (workspace or user)。';
comment on column public.knowledge_nodes.account_id is
  'account_type=workspace なら workspaces.id、user なら users.id (polymorphic FK)';
comment on column public.knowledge_nodes.scope is
  'common (account 全員共有) / employee_specific (特定 ai_employee のみ)';
comment on column public.knowledge_nodes.embedding is
  'Voyage AI voyage-3-large 1024-dim (T-F-14 voyage_embedding domain)';
comment on column public.knowledge_nodes.confidence_score is
  '0.000-1.000。参照回数 usage_count で上昇 (アプリ層更新)';
comment on column public.knowledge_nodes.is_anonymized is
  'F-LEGAL-015: 個人情報マスキング済フラグ。クライアント間共有時に必須 true';
comment on column public.knowledge_nodes.source_type is
  'manual / ai_extracted / import / mem0';

-- =============================================================================
-- Indexes (RAG 検索 / RLS / scope 絞り込み hot path)
-- =============================================================================
-- account 単位 + scope での絞り込み (RLS evaluation で多用)
create index if not exists knowledge_nodes_account_scope_idx
  on public.knowledge_nodes (account_type, account_id, scope) where deleted_at is null;

-- category + tags 検索 (UI のフィルタ)
create index if not exists knowledge_nodes_category_idx
  on public.knowledge_nodes (account_type, account_id, category) where deleted_at is null;
create index if not exists knowledge_nodes_tags_gin_idx
  on public.knowledge_nodes using gin (tags) where deleted_at is null;

-- employee 個別 knowledge
create index if not exists knowledge_nodes_owner_employee_idx
  on public.knowledge_nodes (owner_employee_id)
  where scope = 'employee_specific' and deleted_at is null;

-- HNSW index for cosine similarity search (Voyage 推奨は cosine)
-- 設定値は Wave 2 で実データ規模に応じて tuning する (m=16, ef_construction=64 は default)
create index if not exists knowledge_nodes_embedding_hnsw_idx
  on public.knowledge_nodes
  using hnsw (embedding extensions.vector_cosine_ops)
  with (m = 16, ef_construction = 64)
  where deleted_at is null and embedding is not null;

-- =============================================================================
-- updated_at トリガ
-- =============================================================================
do $$
begin
  if not exists (select 1 from pg_trigger where tgname = 'knowledge_nodes_set_updated_at') then
    create trigger knowledge_nodes_set_updated_at
      before update on public.knowledge_nodes
      for each row execute function public.set_updated_at();
  end if;
end $$;

-- =============================================================================
-- RLS enable + default-deny (T-D-18 で polymorphic scope policy 配置予定)
-- =============================================================================
alter table public.knowledge_nodes enable row level security;

do $$
begin
  if not exists (select 1 from pg_policies
    where schemaname='public' and tablename='knowledge_nodes'
      and policyname='knowledge_nodes_default_deny'
  ) then
    create policy knowledge_nodes_default_deny on public.knowledge_nodes
      as restrictive for all to public using (false);
  end if;
end $$;

commit;
