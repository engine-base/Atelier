-- GAP-026: S-I03 実行モニターの運用操作系バックエンド。
--
-- ① dispatch_control — 「すべて一時停止」の実体 (singleton 行)。
--    paused=true の間、Bridge の /kanban/pick は新規タスクを掴まない。
-- ② bridge_workers — Bridge presence (接続状態バッジの実体)。
--    Bridge アプリが poll ごとに POST /bridge/ping で upsert する。
-- ③ tasks.dispatch_promoted_at — 「順番待ちから 1 件追加」(pick 優先度)。
--    promoted されたタスクは次の pick で最優先に選ばれる。
--
-- 冪等: if not exists で再適用可能。

create table if not exists public.dispatch_control (
  id int primary key default 1 check (id = 1),
  paused boolean not null default false,
  paused_by uuid references public.users(id) on delete set null,
  paused_at timestamptz,
  updated_at timestamptz not null default now()
);

insert into public.dispatch_control (id) values (1) on conflict (id) do nothing;

alter table public.dispatch_control enable row level security;

do $$ begin
  create policy dispatch_control_select on public.dispatch_control
    for select to authenticated using (true);
exception when duplicate_object then null; end $$;

do $$ begin
  -- 一時停止/再開はワークスペースメンバーなら誰でも操作可 (操作者は audit に記録)
  create policy dispatch_control_update on public.dispatch_control
    for update to authenticated
    using (exists (select 1 from public.workspace_memberships m where m.user_id = auth.uid()))
    with check (true);
exception when duplicate_object then null; end $$;

create table if not exists public.bridge_workers (
  id text primary key,
  host_label text not null,
  version text not null,
  worker_pid int,
  last_seen_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);

alter table public.bridge_workers enable row level security;

do $$ begin
  -- 書込は Bridge (service session / BridgeAuth) のみ。authenticated は閲覧のみ
  create policy bridge_workers_select on public.bridge_workers
    for select to authenticated using (true);
exception when duplicate_object then null; end $$;

alter table public.tasks
  add column if not exists dispatch_promoted_at timestamptz;

comment on column public.tasks.dispatch_promoted_at is
  'GAP-026: 「順番待ちから 1 件追加」の昇格時刻。pick は promoted 降順 → created_at 順で選ぶ';
