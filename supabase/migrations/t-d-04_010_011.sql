-- T-D-04: chat_threads / chat_messages (E-010, E-011)
--
-- 信頼源: 04_functional_breakdown/entities.json
-- 関連: F-CTX01 (AI チャット文脈管理 / セマンティック検索)
-- 依存: T-D-02 (projects), T-D-03 (ai_employees), T-F-14 (pgvector)
--
-- 設計のポイント:
--   - chat_messages.content_tsv は tsvector で全文検索用 (trigger で自動更新)
--   - 日本語形態素解析は Supabase の標準では未対応のため 'simple' config を使用
--     (将来 pg_jieba 等を導入する場合は ALTER TRIGGER で切替可能)
--   - chat_messages.embedding は extensions.vector(1024) (Voyage AI 互換)
--   - HNSW cosine index で F-CTX01 セマンティック検索を支える

begin;

-- =============================================================================
-- Enum
-- =============================================================================
do $$
begin
  if not exists (select 1 from pg_type where typname = 'chat_message_role_enum') then
    create type public.chat_message_role_enum as enum (
      'user', 'assistant', 'system', 'tool'
    );
  end if;
end $$;

-- =============================================================================
-- E-010 chat_threads (workspace_scoped via project, soft_delete)
-- =============================================================================
create table if not exists public.chat_threads (
  id              uuid primary key default gen_random_uuid(),
  project_id      uuid not null references public.projects(id) on delete cascade,
  ai_employee_id  uuid not null references public.ai_employees(id) on delete restrict,
  title           text,
  archived        boolean not null default false,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  deleted_at      timestamptz,

  constraint chat_threads_title_length
    check (title is null or char_length(title) between 1 and 200)
);

comment on table public.chat_threads is
  'E-010 ChatThread — project × AI 社員ごとのチャットスレッド。F-CTX01 文脈基盤。';
comment on column public.chat_threads.ai_employee_id is
  '対話相手の AI 社員。ON DELETE RESTRICT で誤削除を防ぐ (履歴保持)';
comment on column public.chat_threads.archived is
  'アーカイブ済フラグ。soft_delete とは独立 (一時非表示 vs 完全削除)';

create index if not exists chat_threads_project_active_idx
  on public.chat_threads (project_id, updated_at desc)
  where deleted_at is null and archived = false;
create index if not exists chat_threads_employee_idx
  on public.chat_threads (ai_employee_id, updated_at desc)
  where deleted_at is null;

-- =============================================================================
-- E-011 chat_messages (workspace_scoped via thread, soft_delete)
-- =============================================================================
create table if not exists public.chat_messages (
  id                  uuid primary key default gen_random_uuid(),
  thread_id           uuid not null references public.chat_threads(id) on delete cascade,
  role                public.chat_message_role_enum not null,
  content             text not null,
  -- tsvector for FTS (trigger で自動更新、Japanese は 'simple' で語彙分割無し)
  content_tsv         tsvector,
  -- embedding for F-CTX01 セマンティック検索 (Voyage AI voyage-3-large)
  embedding           extensions.vector(1024),
  tool_calls          jsonb default '[]'::jsonb,
  attachments         jsonb default '[]'::jsonb,
  parent_message_id   uuid references public.chat_messages(id) on delete set null,
  token_count         integer,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  deleted_at          timestamptz,

  constraint chat_messages_content_length
    check (char_length(content) between 1 and 100000),

  constraint chat_messages_token_count_non_negative
    check (token_count is null or token_count >= 0),

  constraint chat_messages_tool_calls_array
    check (tool_calls is null or jsonb_typeof(tool_calls) = 'array'),

  constraint chat_messages_attachments_array
    check (attachments is null or jsonb_typeof(attachments) = 'array'),

  constraint chat_messages_no_self_parent
    check (parent_message_id is null or parent_message_id <> id)
);

comment on table public.chat_messages is
  'E-011 ChatMessage — chat_threads 配下のメッセージ。FTS + embedding 両対応。';
comment on column public.chat_messages.content_tsv is
  'tsvector (simple config)。trigger で自動更新。FTS / GIN index 用';
comment on column public.chat_messages.embedding is
  'Voyage AI voyage-3-large 1024-dim。F-CTX01 セマンティック検索用';
comment on column public.chat_messages.tool_calls is
  'Anthropic tool_use / tool_result 配列。[{type, name, input, ...}]';
comment on column public.chat_messages.parent_message_id is
  '応答チェーン / branching 用。NULL なら root';

-- =============================================================================
-- tsvector 自動更新 trigger
-- =============================================================================
create or replace function public.chat_messages_tsv_update()
returns trigger as $$
begin
  new.content_tsv = to_tsvector('simple', coalesce(new.content, ''));
  return new;
end;
$$ language plpgsql;

do $$
begin
  if not exists (select 1 from pg_trigger where tgname = 'chat_messages_tsv_trigger') then
    create trigger chat_messages_tsv_trigger
      before insert or update of content on public.chat_messages
      for each row execute function public.chat_messages_tsv_update();
  end if;
end $$;

-- =============================================================================
-- Indexes
-- =============================================================================
-- thread 内のメッセージを時系列順で取得 (チャット UI hot path)
create index if not exists chat_messages_thread_created_idx
  on public.chat_messages (thread_id, created_at)
  where deleted_at is null;

-- 応答チェーン走査
create index if not exists chat_messages_parent_idx
  on public.chat_messages (parent_message_id)
  where parent_message_id is not null;

-- role 別フィルタ (assistant メッセージのみ etc.)
create index if not exists chat_messages_thread_role_idx
  on public.chat_messages (thread_id, role, created_at desc)
  where deleted_at is null;

-- FTS GIN index (全文検索)
create index if not exists chat_messages_tsv_gin_idx
  on public.chat_messages using gin (content_tsv) where deleted_at is null;

-- HNSW vector cosine index (セマンティック検索, F-CTX01)
create index if not exists chat_messages_embedding_hnsw_idx
  on public.chat_messages
  using hnsw (embedding extensions.vector_cosine_ops)
  with (m = 16, ef_construction = 64)
  where deleted_at is null and embedding is not null;

-- =============================================================================
-- updated_at トリガ
-- =============================================================================
do $$
begin
  if not exists (select 1 from pg_trigger where tgname = 'chat_threads_set_updated_at') then
    create trigger chat_threads_set_updated_at
      before update on public.chat_threads
      for each row execute function public.set_updated_at();
  end if;
  if not exists (select 1 from pg_trigger where tgname = 'chat_messages_set_updated_at') then
    create trigger chat_messages_set_updated_at
      before update on public.chat_messages
      for each row execute function public.set_updated_at();
  end if;
end $$;

-- =============================================================================
-- RLS enable + default-deny (T-D-17 で workspace member policy 配置予定)
-- =============================================================================
alter table public.chat_threads  enable row level security;
alter table public.chat_messages enable row level security;

do $$
begin
  if not exists (select 1 from pg_policies
    where schemaname='public' and tablename='chat_threads' and policyname='chat_threads_default_deny'
  ) then
    create policy chat_threads_default_deny on public.chat_threads
      as restrictive for all to public using (false);
  end if;
  if not exists (select 1 from pg_policies
    where schemaname='public' and tablename='chat_messages' and policyname='chat_messages_default_deny'
  ) then
    create policy chat_messages_default_deny on public.chat_messages
      as restrictive for all to public using (false);
  end if;
end $$;

commit;
