-- GAP-023: S-G01 成果物ビューアの未描画要素群のバックエンド。
--
-- ① workflow_outputs.meta — 改訂の出所 (author=steve / revision_instruction /
--    revised_from_version / model) を持つ jsonb。S-G01 バージョン選択の表示実体。
-- ② output_fix_proposals — コメントに対する AI (スティーブ) の修正提案
--    (モックの ai-fix ブロックの実体)。pending → approved (revise 適用で新
--    バージョン生成 / applied_output_id) or rejected。1 コメントにつき
--    pending は 1 件 (unique partial index)。
--    RLS は output → project → workspace_memberships で member のみ。
--
-- 冪等: if not exists / duplicate_object 吸収で再適用可能。

alter table public.workflow_outputs
  add column if not exists meta jsonb not null default '{}'::jsonb;

comment on column public.workflow_outputs.meta is
  'GAP-023: 改訂メタ (author / revision_instruction / revised_from_version / model)';

create table if not exists public.output_fix_proposals (
  id uuid primary key default gen_random_uuid(),
  comment_id uuid not null references public.comments(id) on delete cascade,
  output_id uuid not null references public.workflow_outputs(id) on delete cascade,
  proposal text not null check (char_length(proposal) between 1 and 10000),
  status text not null default 'pending'
    check (status in ('pending', 'approved', 'rejected')),
  applied_output_id uuid references public.workflow_outputs(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  resolved_at timestamptz
);

create index if not exists output_fix_proposals_output_idx
  on public.output_fix_proposals (output_id, created_at);

create unique index if not exists output_fix_proposals_pending_unique
  on public.output_fix_proposals (comment_id)
  where status = 'pending';

alter table public.output_fix_proposals enable row level security;

do $$ begin
  create policy output_fix_proposals_member_select on public.output_fix_proposals
    for select to authenticated
    using (
      exists (
        select 1 from public.workflow_outputs o
        join public.projects p on p.id = o.project_id
        join public.workspace_memberships m on m.workspace_id = p.workspace_id
        where o.id = output_fix_proposals.output_id
          and m.user_id = auth.uid()
      )
    );
exception when duplicate_object then null; end $$;

do $$ begin
  create policy output_fix_proposals_member_insert on public.output_fix_proposals
    for insert to authenticated
    with check (
      exists (
        select 1 from public.workflow_outputs o
        join public.projects p on p.id = o.project_id
        join public.workspace_memberships m on m.workspace_id = p.workspace_id
        where o.id = output_fix_proposals.output_id
          and m.user_id = auth.uid()
      )
    );
exception when duplicate_object then null; end $$;

do $$ begin
  create policy output_fix_proposals_member_update on public.output_fix_proposals
    for update to authenticated
    using (
      exists (
        select 1 from public.workflow_outputs o
        join public.projects p on p.id = o.project_id
        join public.workspace_memberships m on m.workspace_id = p.workspace_id
        where o.id = output_fix_proposals.output_id
          and m.user_id = auth.uid()
      )
    );
exception when duplicate_object then null; end $$;
