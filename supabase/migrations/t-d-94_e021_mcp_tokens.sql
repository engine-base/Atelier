-- T-D-94: mcp_tokens (E-021) — テーブル + RLS
--
-- 信頼源: 04_functional_breakdown/entities.json#E-021 (workspace_scoped)
-- 背景: 実DB検証 (apps/web/.qa/RESULTS-2026-07-04-realdb.md) で本テーブルの DDL が
--   リポジトリに存在しないことが発覚 (routes/services/tests は実装済み)。fresh 環境で
--   MCP トークン機能がデプロイ不能だったため追加する。
-- 列は apps/api/src/services/mcp_tokens/__init__.py の SELECT/INSERT から逆算。
-- 可視性: workspace member (R-T08)。revoke の owner 限定は service 層が
--   workspace_memberships.role='owner' で判定 (RLS は workspace 境界を担保)。
--
-- Idempotency: create if not exists / drop policy if exists → create。

begin;

create table if not exists public.mcp_tokens (
  id            uuid primary key,
  workspace_id  uuid not null references public.workspaces(id) on delete cascade,
  token_hash    text not null,
  name          text not null,
  scopes        text[] not null default '{}',
  expires_at    timestamptz,
  revoked_at    timestamptz,
  last_used_at  timestamptz,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

create unique index if not exists idx_mcp_tokens_token_hash on public.mcp_tokens (token_hash);
create index if not exists idx_mcp_tokens_workspace on public.mcp_tokens (workspace_id);

alter table public.mcp_tokens enable row level security;

drop policy if exists mcp_tokens_select_member on public.mcp_tokens;
drop policy if exists mcp_tokens_insert_member on public.mcp_tokens;
drop policy if exists mcp_tokens_update_member on public.mcp_tokens;

-- SELECT: workspace member 全員可 (t-i-06: 他 WS からは不可視)
create policy mcp_tokens_select_member on public.mcp_tokens
  for select
  to authenticated
  using (workspace_id in (select public.current_user_workspaces()));

-- INSERT: workspace owner / member 限定 (viewer 不可)
create policy mcp_tokens_insert_member on public.mcp_tokens
  for insert
  to authenticated
  with check (
    exists (
      select 1 from public.workspace_memberships m
      where m.workspace_id = mcp_tokens.workspace_id
        and m.user_id = auth.uid()
        and m.role in ('owner', 'member')
    )
  );

-- UPDATE (revoke / last_used_at): owner / member。owner 限定判定は service 層。
create policy mcp_tokens_update_member on public.mcp_tokens
  for update
  to authenticated
  using (
    exists (
      select 1 from public.workspace_memberships m
      where m.workspace_id = mcp_tokens.workspace_id
        and m.user_id = auth.uid()
        and m.role in ('owner', 'member')
    )
  )
  with check (
    exists (
      select 1 from public.workspace_memberships m
      where m.workspace_id = mcp_tokens.workspace_id
        and m.user_id = auth.uid()
        and m.role in ('owner', 'member')
    )
  );

-- DELETE は service に存在しないため policy なし (default deny)。

commit;
