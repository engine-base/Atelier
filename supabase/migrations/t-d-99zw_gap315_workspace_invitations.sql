-- =============================================================================
-- GAP-315: 未登録のメールアドレスをワークスペースに招待できるようにする。
--
-- これまでの招待は「登録済みのメールなら即 membership を足す」だけで、
-- **まだ Atelier を使っていない人は招待できなかった** (API は 422 を返して終わり)。
-- 正本 (通し J31-08) は「期限 7 日の招待リンク → 登録 → 参加」を期待している。
--
-- client_invitations (クライアントポータル) と同じ作りにする:
--   - サーバーはトークンの **sha256 ハッシュだけ**を持つ (生トークンは発行直後のみ)
--   - expires_at で期限切れ、revoked_at で失効、accepted_at で使用済み
--   - 招待は **送った宛先のメールにひも付く** (別人が拾っても参加できない)
-- =============================================================================
begin;

create table if not exists public.workspace_invitations (
  id                uuid primary key default gen_random_uuid(),
  workspace_id      uuid not null references public.workspaces(id) on delete cascade,
  email             text not null,
  role              public.workspace_member_role_enum not null default 'member',
  token_hash        text not null unique,
  expires_at        timestamptz not null,
  invited_by        uuid references public.users(id) on delete set null,
  accepted_at       timestamptz,
  accepted_user_id  uuid references public.users(id) on delete set null,
  revoked_at        timestamptz,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),

  constraint workspace_invitations_email_format
    check (email ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$'),
  constraint workspace_invitations_token_hash_sha256
    check (token_hash ~ '^[a-f0-9]{64}$'),
  constraint workspace_invitations_expires_after_creation
    check (expires_at > created_at),
  constraint workspace_invitations_accepted_needs_user
    check ((accepted_at is null) = (accepted_user_id is null))
);

comment on table public.workspace_invitations is
  'GAP-315 WorkspaceInvitation — 未登録のメール宛の招待リンク (既定 7 日)。
   サーバーは token_hash (sha256) のみ保持。生トークンは発行直後にしか出さない。';
comment on column public.workspace_invitations.email is
  '招待の宛先。**この宛先で登録・サインインした人だけ**が受け取れる (リンクを拾った別人は不可)。';

create index if not exists workspace_invitations_workspace_idx
  on public.workspace_invitations (workspace_id, created_at desc);
create index if not exists workspace_invitations_email_idx
  on public.workspace_invitations (lower(email));

-- 同じ宛先への「生きている招待」は 1 通だけ (再送は前のを失効させてから)
create unique index if not exists workspace_invitations_live_unique
  on public.workspace_invitations (workspace_id, lower(email))
  where accepted_at is null and revoked_at is null;

-- -----------------------------------------------------------------------------
-- RLS: 招待の中身が見えてよいのは、そのワークスペースのメンバーだけ。
-- 受け取り側 (まだメンバーでない人) の照会・承諾は service 経路で行う
-- (トークンを知っていること自体が本人性の証明。RLS で開けると全招待が見える)。
-- -----------------------------------------------------------------------------
alter table public.workspace_invitations enable row level security;

drop policy if exists workspace_invitations_select_member on public.workspace_invitations;
create policy workspace_invitations_select_member on public.workspace_invitations
  for select to authenticated
  using (workspace_id in (select public.current_user_workspaces()));

drop policy if exists workspace_invitations_write_owner on public.workspace_invitations;
create policy workspace_invitations_write_owner on public.workspace_invitations
  for all to authenticated
  using (
    exists (
      select 1 from public.workspace_memberships m
      where m.workspace_id = workspace_invitations.workspace_id
        and m.user_id = auth.uid() and m.role = 'owner'
    )
  )
  with check (
    exists (
      select 1 from public.workspace_memberships m
      where m.workspace_id = workspace_invitations.workspace_id
        and m.user_id = auth.uid() and m.role = 'owner'
    )
  );

-- token_hash は「見えてはいけない列」。メンバーであっても読めないようにする
-- (読めると、同僚が他人宛の招待リンクを再現できてしまう)。
revoke select (token_hash) on public.workspace_invitations from authenticated;

commit;
