-- GAP-167: ナレッジ候補 (会話から拾ったものを「全部溜めない」ための承認キュー)
--
-- 経営者指摘 (2026-08-19):
--   「この形式とか、しかも全て溜めるのはノイズになるし、ちゃんとどれを入れるか
--    などもできる状態になっているのか？？」
--
-- GAP-164 は会話から拾ったノウハウを **直接ナレッジへ入れていた**。
-- これを候補として溜め、**人が採用/却下** して初めてナレッジになる形に変える。
-- 却下したものは同じ題で再提案しない (同じノイズを何度も出さない)。

create table if not exists public.knowledge_candidates (
  id                   uuid primary key default gen_random_uuid(),
  workspace_id         uuid not null references public.workspaces(id) on delete cascade,
  project_id           uuid references public.projects(id) on delete set null,
  thread_id            uuid references public.chat_threads(id) on delete set null,
  title                text not null,
  content_md           text not null,
  category             text not null default 'ノウハウ',
  tags                 text[] not null default array[]::text[],
  status               text not null default 'pending'
                         check (status in ('pending', 'approved', 'rejected')),
  approved_knowledge_id uuid references public.knowledge_nodes(id) on delete set null,
  decided_by           uuid references public.users(id) on delete set null,
  decided_at           timestamptz,
  created_at           timestamptz not null default now()
);

comment on table public.knowledge_candidates is
  'GAP-167: 会話から AI が拾ったナレッジ候補。人が採用して初めてナレッジになる (全部は溜めない)。';

create index if not exists knowledge_candidates_ws_status_idx
  on public.knowledge_candidates (workspace_id, status, created_at desc);

-- 同じワークスペースで同じ題は 1 度だけ (却下済みも再提案しない)
create unique index if not exists knowledge_candidates_ws_title_uq
  on public.knowledge_candidates (workspace_id, title);

alter table public.knowledge_candidates enable row level security;

drop policy if exists knowledge_candidates_select on public.knowledge_candidates;
create policy knowledge_candidates_select on public.knowledge_candidates
  for select to authenticated
  using (workspace_id in (select public.current_user_workspaces()));

drop policy if exists knowledge_candidates_update on public.knowledge_candidates;
create policy knowledge_candidates_update on public.knowledge_candidates
  for update to authenticated
  using (workspace_id in (select public.current_user_workspaces()));

-- insert は AI の自動抽出 (service 経路) のみ — テナントから直接は積ませない
