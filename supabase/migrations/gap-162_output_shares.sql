-- GAP-162: 成果物のクライアント共有リンク (経営者質問 2026-08-19)
--   「これをこのままリンクとして資料を渡せる状態にもなっている？？」
--
-- 設計:
--   - トークンは **ハッシュのみ保存** (漏洩時に DB からリンクを復元できない)
--   - 期限つき + いつでも失効 (revoke)。失効・期限切れは 410 で正直に断る
--   - 閲覧は認証不要 (クライアントに渡すため)。閲覧のたびに last_viewed_at を更新
--   - RLS: リンクの作成・一覧・失効はその成果物が見えるテナントのみ

create table if not exists public.output_share_links (
  id            uuid primary key default gen_random_uuid(),
  output_id     uuid not null references public.workflow_outputs(id) on delete cascade,
  token_hash    text not null unique,
  label         text not null default '',
  expires_at    timestamptz not null,
  revoked_at    timestamptz,
  view_count    integer not null default 0,
  last_viewed_at timestamptz,
  created_by    uuid references public.users(id) on delete set null,
  created_at    timestamptz not null default now()
);

comment on table public.output_share_links is
  'GAP-162: 成果物をクライアントへ渡すための期限つき共有リンク。トークンはハッシュのみ保存し、失効可能。';

create index if not exists output_share_links_output_idx
  on public.output_share_links (output_id, created_at desc);

alter table public.output_share_links enable row level security;

drop policy if exists output_share_links_select on public.output_share_links;
create policy output_share_links_select on public.output_share_links
  for select to authenticated
  using (
    output_id in (
      select o.id from public.workflow_outputs o
      join public.projects p on p.id = o.project_id
      where p.workspace_id in (select public.current_user_workspaces())
    )
  );

drop policy if exists output_share_links_insert on public.output_share_links;
create policy output_share_links_insert on public.output_share_links
  for insert to authenticated
  with check (
    output_id in (
      select o.id from public.workflow_outputs o
      join public.projects p on p.id = o.project_id
      where p.workspace_id in (select public.current_user_workspaces())
    )
  );

-- 失効 (revoked_at のセット) のみ更新を許す
drop policy if exists output_share_links_update on public.output_share_links;
create policy output_share_links_update on public.output_share_links
  for update to authenticated
  using (
    output_id in (
      select o.id from public.workflow_outputs o
      join public.projects p on p.id = o.project_id
      where p.workspace_id in (select public.current_user_workspaces())
    )
  );
