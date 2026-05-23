-- T-D-10: approval_inbox (E-019)
--
-- 信頼源: 04_functional_breakdown/entities.json#E-019
-- 関連: F-J02 (経営者承認動線), F-CUC02 (スコープ変更時の確認)
-- 依存: T-D-05 (tasks), T-D-06 (acceptance_criteria) で target_id が参照可能
--
-- 設計のポイント:
--   - user_scoped: 各 user の受信トレイ (auth.uid() で読める)
--   - polymorphic target: target_type で task / phase / knowledge_node /
--     comment / scope_change のどれかを指す (アプリ層整合性)
--   - status は text + CHECK (entities.json で enum 化されていない)
--   - F-CUC02 (タスクライフサイクル変更時の承認): 致命級ではないが操作不可逆

begin;

-- =============================================================================
-- Enum: approval_inbox_type_enum
-- =============================================================================
do $$
begin
  if not exists (select 1 from pg_type where typname = 'approval_inbox_type_enum') then
    create type public.approval_inbox_type_enum as enum (
      'task_approval',
      'phase_approval',
      'knowledge_write',
      'comment_response',
      'scope_change'
    );
  end if;
end $$;

-- =============================================================================
-- E-019 approval_inbox (user_scoped, append-and-resolve)
-- =============================================================================
create table if not exists public.approval_inbox (
  id              uuid primary key default gen_random_uuid(),
  user_id         uuid not null references public.users(id) on delete cascade,
  type            public.approval_inbox_type_enum not null,
  target_type     text not null,
  target_id       uuid not null,
  title           text not null,
  payload         jsonb not null default '{}'::jsonb,
  status          text not null default 'pending',
  resolved_at     timestamptz,
  resolution_note text,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),

  constraint approval_inbox_status_valid
    check (status in ('pending', 'approved', 'rejected')),

  -- status=pending なら resolved_at NULL、resolved (approved/rejected) なら resolved_at NOT NULL
  constraint approval_inbox_resolution_consistency
    check (
      (status = 'pending' and resolved_at is null) or
      (status in ('approved', 'rejected') and resolved_at is not null)
    ),

  constraint approval_inbox_resolved_after_created
    check (resolved_at is null or resolved_at >= created_at),

  constraint approval_inbox_target_type_valid
    check (target_type in ('task', 'phase', 'knowledge_node', 'comment', 'scope_change')),

  constraint approval_inbox_title_length
    check (char_length(title) between 1 and 200),

  constraint approval_inbox_payload_object
    check (jsonb_typeof(payload) = 'object'),

  constraint approval_inbox_resolution_note_length
    check (resolution_note is null or char_length(resolution_note) <= 2000)
);

comment on table public.approval_inbox is
  'E-019 ApprovalInbox — user 受信トレイ (F-J02 承認 / F-CUC02 スコープ変更確認)。';
comment on column public.approval_inbox.type is
  'task_approval / phase_approval / knowledge_write / comment_response / scope_change';
comment on column public.approval_inbox.target_type is
  'polymorphic target: task / phase / knowledge_node / comment / scope_change';
comment on column public.approval_inbox.target_id is
  'target_type に応じて tasks.id / phases.id / knowledge_nodes.id / comments.id を指す (アプリ層整合性)';
comment on column public.approval_inbox.payload is
  '承認対象の詳細データ (diff / before-after / 関連 context)';
comment on column public.approval_inbox.status is 'pending / approved / rejected';

-- =============================================================================
-- Indexes (受信トレイ UI / バッジカウント / 過去履歴)
-- =============================================================================
-- pending 一覧 (UI のトップ画面)
create index if not exists approval_inbox_user_pending_idx
  on public.approval_inbox (user_id, created_at desc)
  where status = 'pending';

-- 全件履歴 (UI のフィルタなし表示)
create index if not exists approval_inbox_user_created_idx
  on public.approval_inbox (user_id, created_at desc);

-- type 別フィルタ
create index if not exists approval_inbox_user_type_idx
  on public.approval_inbox (user_id, type, created_at desc);

-- target 逆引き (例: この task に紐づく approval は?)
create index if not exists approval_inbox_target_idx
  on public.approval_inbox (target_type, target_id) where status = 'pending';

-- =============================================================================
-- updated_at トリガ
-- =============================================================================
do $$
begin
  if not exists (select 1 from pg_trigger where tgname = 'approval_inbox_set_updated_at') then
    create trigger approval_inbox_set_updated_at
      before update on public.approval_inbox
      for each row execute function public.set_updated_at();
  end if;
end $$;

-- =============================================================================
-- RLS enable + default-deny (T-D-17 で user-scoped policy 配置予定)
-- =============================================================================
alter table public.approval_inbox enable row level security;

do $$
begin
  if not exists (select 1 from pg_policies
    where schemaname='public' and tablename='approval_inbox'
      and policyname='approval_inbox_default_deny'
  ) then
    create policy approval_inbox_default_deny on public.approval_inbox
      as restrictive for all to public using (false);
  end if;
end $$;

commit;
