-- T-D-07: mocks / comments (E-015, E-016)
--
-- 信頼源: 04_functional_breakdown/entities.json#E-015, E-016
-- 関連: F-H01 (HTML モック + コメント)
-- 依存: T-D-02 (projects), T-D-01 (users), T-D-05 (tasks for mock_id ALTER)
--
-- 作成順:
--   1. enum (comment_target_type_enum)
--   2. mocks (E-015, project_id FK, parent_mock_id self-ref, soft_delete)
--   3. comments (E-016, polymorphic target, parent_comment_id self-ref, soft_delete)
--   4. ALTER public.tasks ADD FK tasks_mock_id_fkey → mocks.id (T-D-05 forward ref 解消)
--
-- Forward reference (未解消):
--   comments.author_invitation_id → client_invitations.id
--     ↑ T-D-08 で ALTER TABLE comments ADD CONSTRAINT で後付け予定

begin;

-- =============================================================================
-- Enum: comment_target_type_enum (polymorphic target)
-- =============================================================================
do $$
begin
  if not exists (select 1 from pg_type where typname = 'comment_target_type_enum') then
    create type public.comment_target_type_enum as enum (
      'workflow_output', 'mock', 'task', 'acceptance_criteria'
    );
  end if;
end $$;

-- =============================================================================
-- E-015 mocks (workspace_scoped via project_id, soft_delete, version chain)
-- =============================================================================
create table if not exists public.mocks (
  id                 uuid primary key default gen_random_uuid(),
  project_id         uuid not null references public.projects(id) on delete cascade,
  screen_name        text not null,
  html_storage_path  text not null,
  version            integer not null default 1,
  parent_mock_id     uuid references public.mocks(id) on delete set null,
  meta_tags          jsonb,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  deleted_at         timestamptz,
  constraint mocks_version_positive check (version >= 1),
  constraint mocks_no_self_parent check (parent_mock_id is null or parent_mock_id <> id),
  constraint mocks_meta_tags_object check (meta_tags is null or jsonb_typeof(meta_tags) = 'object')
);

comment on table public.mocks is
  'E-015 Mock — HTML モック (Supabase Storage 連携)。version chain で履歴管理。';
comment on column public.mocks.parent_mock_id is
  'version chain: 前バージョンの mock。NULL なら初版。';
comment on column public.mocks.meta_tags is
  '{screen_id, screen_name, category, status, version} を JSONB で保持';

create index if not exists mocks_project_id_idx
  on public.mocks (project_id) where deleted_at is null;
create index if not exists mocks_parent_chain_idx
  on public.mocks (parent_mock_id) where parent_mock_id is not null;

-- =============================================================================
-- E-016 comments (polymorphic target, soft_delete, thread support)
-- =============================================================================
create table if not exists public.comments (
  id                    uuid primary key default gen_random_uuid(),
  target_type           public.comment_target_type_enum not null,
  target_id             uuid not null,
  target_element_id     text,
  author_user_id        uuid references public.users(id) on delete set null,
  -- author_invitation_id: T-D-08 で FK 後付け (client_invitations 未作成)
  author_invitation_id  uuid,
  content               text not null,
  status                text not null default 'open',
  parent_comment_id     uuid references public.comments(id) on delete set null,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),
  deleted_at            timestamptz,
  constraint comments_status_valid
    check (status in ('open', 'resolved', 'deleted')),
  constraint comments_content_length
    check (char_length(content) between 1 and 10000),
  constraint comments_no_self_parent
    check (parent_comment_id is null or parent_comment_id <> id),
  -- author は user か client invitation のどちらか (両方 NULL も許容 = system 投稿)
  constraint comments_author_exclusive
    check (author_user_id is null or author_invitation_id is null)
);

comment on table public.comments is
  'E-016 Comment — polymorphic target (workflow_output/mock/task/acceptance_criteria)。';
comment on column public.comments.target_element_id is
  'HTML 要素 ID (DOM 内の特定箇所へのコメント、optional)';
comment on column public.comments.author_invitation_id is
  'client_invitations.id への FK は T-D-08 で ALTER で後付け予定';
comment on column public.comments.status is 'open / resolved / deleted';

create index if not exists comments_target_idx
  on public.comments (target_type, target_id) where deleted_at is null;
create index if not exists comments_author_user_idx
  on public.comments (author_user_id) where author_user_id is not null and deleted_at is null;
create index if not exists comments_thread_idx
  on public.comments (parent_comment_id) where parent_comment_id is not null;
create index if not exists comments_open_idx
  on public.comments (target_type, target_id) where status = 'open' and deleted_at is null;

-- =============================================================================
-- T-D-05 forward reference 解消: tasks.mock_id → mocks.id
-- =============================================================================
do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'tasks_mock_id_fkey'
  ) then
    alter table public.tasks
      add constraint tasks_mock_id_fkey
      foreign key (mock_id) references public.mocks(id) on delete set null;
  end if;
end $$;

-- =============================================================================
-- updated_at トリガ (T-D-01 set_updated_at() 再利用)
-- =============================================================================
do $$
begin
  if not exists (select 1 from pg_trigger where tgname = 'mocks_set_updated_at') then
    create trigger mocks_set_updated_at
      before update on public.mocks
      for each row execute function public.set_updated_at();
  end if;
  if not exists (select 1 from pg_trigger where tgname = 'comments_set_updated_at') then
    create trigger comments_set_updated_at
      before update on public.comments
      for each row execute function public.set_updated_at();
  end if;
end $$;

-- =============================================================================
-- RLS enable + default-deny (T-D-17 で実 policy に置換予定)
-- =============================================================================
alter table public.mocks    enable row level security;
alter table public.comments enable row level security;

do $$
begin
  if not exists (select 1 from pg_policies
    where schemaname='public' and tablename='mocks' and policyname='mocks_default_deny'
  ) then
    create policy mocks_default_deny on public.mocks
      as restrictive for all to public using (false);
  end if;
  if not exists (select 1 from pg_policies
    where schemaname='public' and tablename='comments' and policyname='comments_default_deny'
  ) then
    create policy comments_default_deny on public.comments
      as restrictive for all to public using (false);
  end if;
end $$;

commit;
